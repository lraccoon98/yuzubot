/**
 * Sends a request to the Gemini API and processes its response.
 * @param {Array<Object>} contents The messages to send to the model.
 * @param {Object} [systemInstruction] Optional system instruction.
 * @param {boolean} [useTools=true] Whether to include the tools in the request.
 * @param {Array<Object>} [safetySettings=null] Optional safety settings.
 * @returns {Object} The parsed response content from Gemini.
 */
function callGeminiAPI(contents, systemInstruction, useTools = true, safetySettings = null) {
  // *** CHANGE: The 'imageData' parameter and all the logic that used it has been removed. ***
  const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GEMINI_API_KEY}`;

  const requestBody = {
    contents: contents,
    systemInstruction: systemInstruction,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    }
  };

  if (useTools) {
    requestBody.tools = tools;
  }
  
  if (safetySettings) {
    requestBody.safetySettings = safetySettings;
  }

  try {
    let res;
    const MAX_RETRIES = 2; // Try a total of 2 times
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        res = UrlFetchApp.fetch(ENDPOINT, {
          method: "POST",
          contentType: "application/json",
          payload: JSON.stringify(requestBody),
          muteHttpExceptions: true,
        });

        if (res.getResponseCode() === 200) {
          break; // Success, exit the loop
        }
        // If not the last retry, wait before trying again
        if (i < MAX_RETRIES - 1) {
          Utilities.sleep(1500);
        }
      } catch (e) {
        if (i === MAX_RETRIES - 1) throw e; // On the last try, fail permanently
        Utilities.sleep(1500);
      }
    }

    const resCode = res.getResponseCode();
    const resPayloadObj = JSON.parse(res.getContentText());

    if (resCode !== 200) {
      throw new Error(`API request failed: ${res.getContentText()}`);
    }

    // Robustness Check: Handle safety blocks or other empty responses from the API.
    if (!resPayloadObj.candidates || resPayloadObj.candidates.length === 0) {
      // Log the reason if available (e.g., "SAFETY")
      const finishReason = resPayloadObj.promptFeedback?.blockReason || "Unknown";
      slackLogMessage(SLACK_LOG_CHANNEL_ID, `API call returned no candidates. Probable reason: ${finishReason}`);
      return null;
    }

    // Ensure the content part itself exists.
    if (!resPayloadObj.candidates[0].content) {
      const finishReason = resPayloadObj.candidates[0].finishReason || "Unknown";
      slackLogMessage(SLACK_LOG_CHANNEL_ID, `API call returned a candidate with no content. Finish Reason: ${finishReason}`);
      return null;
    }

    return resPayloadObj.candidates[0].content;
  } catch (e) {
    throw e;
  }
}


/**
 * Checks if the bot is already an active participant in a given thread. This serves as
 * the bot's "conversational memory" for threads.
 * @param {string} channelId The ID of the channel.
 * @param {string} thread_ts The timestamp of the parent message in the thread.
 * @returns {boolean} True if the bot has posted in the thread, false otherwise.
 */
function isBotInvolvedInThread(channelId, thread_ts) {
  // If there's no thread_ts, it's not a thread, so the bot can't be involved.
  if (!thread_ts) {
    return false;
  }

  try {
    const msgsInThread = fetchMsgsInThread(channelId, thread_ts);
    // Use .some() to efficiently check if any message in the thread was sent by our bot.
    return msgsInThread.some(msg => msg.user === BOT_MEMBER_ID);
  } catch (e) {
    // If fetching messages fails for any reason, assume we're not involved to be safe.
    console.error(`Failed to check thread involvement: ${e.message}`);
    return false;
  }
}


/**
 * Fetches all messages from a specific Slack thread using the Slack API.
 * @param {string} channelId The ID of the channel containing the thread.
 * @param {string} threadTimestamp The 'ts' value of the parent message of the thread.
 * @returns {Array<Object>} An array of Slack message objects.
 */
const fetchMsgsInThread = (channelId, threadTimestamp) => {
  const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTimestamp}`;

  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + BOT_AUTH_TOKEN,
  };

  const options = {
    method: "GET",
    headers,
  };

  const response = UrlFetchApp.fetch(url, options);
  const data = JSON.parse(response.getContentText());

  if (data.ok) {
    return data.messages;
  } else {
    throw new Error(`Failed to fetch messages in thread: ${data.error}`);
  }
};


/**
 * Posts a message to a specified Slack channel.
 * @param {string} channelId The ID of the channel to post to.
 * @param {string} message The text of the message to post.
 * @param {Object} [option] Optional parameters for the Slack API, like thread_ts.
 */
const slackPostMessage = (channelId, message, option) => {
  const url = "https://slack.com/api/chat.postMessage";

  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + BOT_AUTH_TOKEN,
  };

  const payload = {
    channel: channelId,
    text: message,
    ...option,
  };

  const options = {
    method: "POST",
    headers,
    payload: JSON.stringify(payload),
  };

  UrlFetchApp.fetch(url, options);
};


/**
 * Sends a log message to a designated Slack channel.
 * @param {string} channelId The ID of the log channel.
 * @param {string} message The log message to send.
 */
function slackLogMessage(channelId, message) {
  const url = "https://slack.com/api/chat.postMessage";
  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + BOT_AUTH_TOKEN
    },
    payload: JSON.stringify({
      channel: channelId,
      text: "Log: " + message,
    }),
  };

  UrlFetchApp.fetch(url, options);
}


/**
 * Uses the Google Cloud Vision API to get a list of possible entities for an image.
 * This is the core of the accurate image recognition system.
 * @param {object} imageData The image data object with a base64 string.
 * @returns {Array<string>|null} An array of possible names, or null.
 */
function getCharacterNameFromVisionAPI(imageData) {
  const CLOUD_VISION_API_KEY = PropertiesService.getScriptProperties().getProperty("CLOUD_VISION_API_KEY");
  if (!CLOUD_VISION_API_KEY) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, "ERROR: CLOUD_VISION_API_KEY is not set.");
    return null;
  }
  
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${CLOUD_VISION_API_KEY}`;
  
  const requestBody = {
    requests: [{
      image: { content: imageData.data },
      features: [{ type: "WEB_DETECTION", maxResults: 5 }]
    }]
  };

  const options = {
    method: "POST",
    contentType: "application/json",
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const data = JSON.parse(response.getContentText());

    if (data.responses && data.responses[0].webDetection) {
      const webEntities = data.responses[0].webDetection.webEntities;
      if (webEntities && webEntities.length > 0) {
        // Return a list of the top 5 entity descriptions, filtering out any empty ones.
        const possibleNames = webEntities.slice(0, 5).map(entity => entity.description).filter(Boolean);
        slackLogMessage(SLACK_LOG_CHANNEL_ID, `Vision API possible names: [${possibleNames.join(", ")}]`);
        return possibleNames;
      }
    }
    slackLogMessage(SLACK_LOG_CHANNEL_ID, "WARN: Vision API did not return any web entities.");
    return null;
  } catch (e) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, `FATAL ERROR in getCharacterNameFromVisionAPI: ${e.stack}`);
    return null;
  }
}


/**
 * Uploads an image to Cloudinary and returns its perceptual hash.
 * @param {Object} imageData The image data object with a base64 string.
 * @returns {string|null} The perceptual hash of the uploaded image, or null on failure.
 */
function uploadToCloudinaryAndGetHash(imageData) {
  const CLOUD_NAME = PropertiesService.getScriptProperties().getProperty("CLOUDINARY_CLOUD_NAME");
  const API_KEY = PropertiesService.getScriptProperties().getProperty("CLOUDINARY_API_KEY");
  const API_SECRET = PropertiesService.getScriptProperties().getProperty("CLOUDINARY_API_SECRET");

  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, "ERROR: Cloudinary credentials are not fully set.");
    return null;
  }

  const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`;
  const timestamp = Math.round(new Date().getTime() / 1000);
  
  const signatureString = `phash=true&timestamp=${timestamp}${API_SECRET}`;
  const signature = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, signatureString)
    .map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');

  const payload = {
    file: `data:${imageData.mimeType};base64,${imageData.data}`,
    api_key: API_KEY,
    timestamp: timestamp,
    signature: signature,
    phash: true,
  };

  const options = {
    method: "POST",
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const data = JSON.parse(response.getContentText());

    if (data.phash) {
      slackLogMessage(SLACK_LOG_CHANNEL_ID, `Cloudinary returned pHash: ${data.phash}`);
      return data.phash;
    } else {
      slackLogMessage(SLACK_LOG_CHANNEL_ID, `ERROR: Failed to get pHash from Cloudinary. Reason: ${data.error?.message || 'Unknown'}`);
      return null;
    }
  } catch (e) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, `FATAL ERROR in uploadToCloudinaryAndGetHash: ${e.stack}`);
    return null;
  }
}