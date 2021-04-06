const db = require('./AWS_Helpers');
const fetch = require('node-fetch');

const NOT_SUPPORTED = "NOT_SUPPORTED";
const TERMINAL_ERROR = "TERMINAL_ERROR";
const INVALID_DAY = "INVALID_DAY";
const NO_DATA_FOR_DAY = "NO_DATA_FOR_DAY";

/**
 * Returns the slotID and value for the resort in the IntentRequest
 * @param {object} resortsSlot - from the IntentRequest (ex: 'this.event.request.intent.slots.Resort')
 * @returns {object} {resortSlotID, synonymValue}
 */
const getResortSlotIdAndName = async (resortSlot) => {
  console.log('Attempting to get resortSlotIdAndName...');
  let synonymValue = resortSlot.value;
  let resortSlotID;
  let resortName;

  // Attempt to get resortSlotID
  if (
    resortSlot.resolutions &&
    resortSlot.resolutions.resolutionsPerAuthority &&
    resortSlot.resolutions.resolutionsPerAuthority[0] &&
    resortSlot.resolutions.resolutionsPerAuthority[0].status &&
    resortSlot.resolutions.resolutionsPerAuthority[0].status.code &&
    resortSlot.resolutions.resolutionsPerAuthority[0].status.code === "ER_SUCCESS_MATCH"
  ) {
    resortSlotID = resortSlot.resolutions.resolutionsPerAuthority[0].values[0].value.id;
    resortName = resortSlot.resolutions.resolutionsPerAuthority[0].values[0].value.name;
  }

  await exportFunctions.updateDBUniqueResortCounter(resortSlotID, synonymValue);

  console.log(`getResortSlotIdAndName returning: resortSlotID: ${resortSlotID}, resortName: ${resortName}, synonymValue: ${synonymValue}`);
  return {
    resortSlotID,
    resortName,
    synonymValue
  }
}

/**
 * Updates the resort counter on the DynamodDB table that tracks the resorts used in the skill
 * @param {string} resortSlotID 
 * @param {string} synonymValue 
 */
const updateDBUniqueResortCounter = async (resortSlotID, synonymValue) => {
  const resort = !!resortSlotID ? resortSlotID : synonymValue;
  const params = {
    TableName: "SkiResortTracking",
    Key: {
      "resort": resort
    },
    UpdateExpression: "ADD resortCounter :val",
    ExpressionAttributeValues: {
      ":val":1
    },
    ReturnValues: "UPDATED_NEW"
  }

  console.log('Updating DB Resort Counter...');
  await db.updateResortCount(params);
}

// Weather API related code
// These are the gridpoints used for the weather API
const resortWeatherGridpoints = {
  Stevens_Pass: 'SEW/164,66',
  Snoqualmie_Pass: 'SEW/151,53',
  Crystal_Mountain: 'SEW/144,30',
  Mount_Baker: 'SEW/156,122',
  Mission_Ridge: 'OTX/42,89',
  Mount_Hood_Meadows: 'PQR/143,88',
  Mount_Hood_Skibowl: 'PQR/139,87',
  Timberline_Lodge: 'PQR/135,95',
  Mount_Bachelor: 'PDT/22,39',
  Schweitzer: 'OTX/171,120',
  Sun_Valley: 'PIH/38,93',
  Mammoth_Mountain: 'REV/56,16',
  Big_Bear_Mountain: 'SGX/76,78',
  Breckenridge: 'BOU/24,52',
  Alta: 'SLC/107,166',
  Brighton: 'SLC/109,166',
  Snowbird: 'SLC/107,165',
  Solitude: 'SLC/109,167',
  Deer_Valley: 'SLC/113,167',
  Park_City: 'SLC/112,168',
  Sundance: 'SLC/108,157',
  Powder_Mountain: 'SLC/107,202',
  Snowbasin: 'SLC/103,195',
  Brian_Head_Resort: 'SLC/48,41',
  Eagle_Point: 'SLC/68,67',
  Beaver_Mountain: 'SLC/118,228',
  Mount_Washington: 'NOT_SUPPORTED'
};

/**
 * Makes a network request to the WeatherAPI to get the forecast for the given resort
 * @param {string} resortID 
 * @returns JSON formatted object of the weather forecast for the week.
 * It returns error NOT_SUPPORTED if the resortId is not supported by the Weather API
 * If there are any errors, it returns a TERMINAL_ERROR
 */
const getWeatherRequest = async (resortID) => {
  console.log(`Requesting weather for ${resortID}`);
  const gridpoint = resortWeatherGridpoints[resortID];
  
  // End early if resortID is not supported
  if (gridpoint === NOT_SUPPORTED) {
    return { data: undefined, error: NOT_SUPPORTED };
  }
  
  const path = `/gridpoints/${gridpoint}/forecast`;
  const options = {
    host: 'api.weather.gov',
    path: path,
    method: 'GET',
    headers: {
        'user-agent': 'Snow-Report (hildeapps@gmail.com)',
        'accept': 'application/json'
    }
  };

  try {
    const data = await fetch(`https://api.weather.gov${path}`, options);
    const jsonData = await data.json();
    return { data: jsonData, error: undefined };
  } catch (error) {
    console.log(`Error fetching Weather info for ${resortID}: ${error}`);
    return { data: undefined, error: TERMINAL_ERROR };
  }
};

/**
 * Gets the weather for today
 * @param {string} resortID 
 * @returns {object} {detailedForecast?: string, error?: string}
 * Returns the detailedForecast for today on success
 * Returns any errors that are returned from getWeatherRequest
 */
const getForecastToday = async (resortID) => {
  const { data, error } = await exportFunctions.getWeatherRequest(resortID);
  
  if (error) {
    return { detailedForecast: undefined, error };
  }

  const forecast = JSON.parse(data);

  return {
    detailedForecast: forecast.properties.periods[0].detailedForecast,
    error: undefined
  };
};

/**
 * Gets the forecast for the week
 * @param {string} resortID 
 * @returns {object} Object containing an array of forecast data or an error
 * {
 *   forecastDataArray?: [{day, tempHigh, tempLow, shortForecast, detailedForecast}],
 *   error?: string
 * }
 * Returns any errors that are returned from getWeatherRequest
 */
const getForecastWeek = async (resortID) => {
  const { data, error } = await exportFunctions.getWeatherRequest(resortID);
  
  if (error) {
    return { forecastDataArray: undefined, error };
  }

  const forecast = JSON.parse(data);
  const forecastPeriods = forecast.properties.periods;

  // If the first result has isDaytime = false, then it will only have one result for "Tonight"
  // In addition it means that the very last result will also only return one result, the "day" portion
  // To make sure that we always have a tempHigh and a tempLow, we skip the first and last results in this case
  const isFirstPeriodNight = !forecastPeriods[0].isDaytime;
  const startIndex = isFirstPeriodNight ? 1 : 0;
  const endIndex = isFirstPeriodNight ? forecastPeriods.length - 1 : forecastPeriods.length;

  let forecastData = [];

  for (let i = startIndex; i < endIndex; i += 2) {
    forecastData.push({
      day: forecastPeriods[i].name,
      tempHigh: forecastPeriods[i].temperature,
      tempLow: forecastPeriods[i + 1].temperature,
      shortForecast: forecastPeriods[i].shortForecast,
      detailedForecast: forecastPeriods[i].detailedForecast
    });
  }

  return {
    forecastDataArray: forecastData,
    error: undefined
  };
};

/**
 * Gets the forecast for the specified day
 * @param {string} resortID 
 * @param {string} day - day of the week
 * @returns Object containing forecast data or an error
 * {
 *   forecastData?: [{day, tempHigh, tempLow, shortForecast, detailedForecast}],
 *   error?: string
 * }
 * Returns any errors that are returned from getWeatherRequest
 * Returns INVALID_DAY if the day passed in does not match a day of the week
 */
const getForecastWeekDay = async (resortID, day) => {
  const { forecastDataArray, error } = await exportFunctions.getForecastWeek(resortID);

  if (error) {
    return { forecastData: undefined, error };
  }

  // Make sure user said a valid day
  // Ex: In some cases a holiday name could replace the name of the day in the field
  if (!isValidDayOfTheWeek(day)) {
    return { forecastData: undefined, error: INVALID_DAY };
  }

  const forecastDataForSpecificDay = forecastDataArray.find(data => data.day.toLowerCase() === day.toLowerCase());
  // Make sure we have data for the specified day
  // Ex: If they ask for Friday and today is Friday, we only have up to next Thursday
  const noDataForDayError = !forecastDataForSpecificDay ? NO_DATA_FOR_DAY : undefined;

  return {
    forecastData: forecastDataForSpecificDay,
    error: noDataForDayError
  };
}

/**
 * Checks that the a valid day of the week is being used
 * @param {string} day 
 * @returns true/false
 */
const isValidDayOfTheWeek =  (day) => {
  const daysOfTheWeek = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return daysOfTheWeek.indexOf(day.toLowerCase()) > -1;
}

// For testing
// getWeatherRequest("Stevens_Pass");

// Due to the way module.exports works, when unit testing these module functions that call other module functions
// It actually saves it as an object. So when you go to mock a function it ends up using the copied function instead of the mock
// In order to work around this constraint, we are using this object.
// IMPORTANT: When calling a module function from within the same module, it should be called from exportFunction.moduleName
// The following article explains this further:
// https://medium.com/@DavideRama/mock-spy-exported-functions-within-a-single-module-in-jest-cdf2b61af642
const exportFunctions = {
  // Constants
  NOT_SUPPORTED,
  TERMINAL_ERROR,
  INVALID_DAY,
  NO_DATA_FOR_DAY,
  getResortSlotIdAndName: getResortSlotIdAndName,
  // Weather helpers
  getForecastToday: getForecastToday,
  getForecastWeek: getForecastWeek,
  getForecastWeekDay: getForecastWeekDay,
  // Exported for unit tests only
  updateDBUniqueResortCounter: updateDBUniqueResortCounter,
  getWeatherRequest: getWeatherRequest
};

module.exports = exportFunctions;