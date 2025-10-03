/**
 * Converts an array of Slack message objects to the format required by the Gemini API.
 * @param {Array<Object>} slackMsgs An array of Slack message objects.
 * @param {Object|null} imageData Optional image data to attach to the last message.
 * @returns {Array<Object>} An array of messages formatted for the Gemini API.
 */
const parseSlackMsgsToGeminiQueryMsgs = (slackMsgs, imageData = null) => {
  return slackMsgs.map((msg, index) => {
    const isLastMessage = index === slackMsgs.length - 1;
    const role = msg.user == BOT_MEMBER_ID ? "model" : "user";
    let content = msg.text || "";

    // *** CHANGE: This is the core logic update ***
    const parts = [];

    // If it's the last message from a user, and there's no text but there is a file,
    // create a default prompt for the AI.
    if (isLastMessage && role === 'user' && !content && msg.files) {
      content = "Describe this image or respond to it in character.";
    }

    // Always add the text part, even if it's empty.
    parts.push({ text: content });

    // If this is the last message AND we have image data, add it to the parts array.
    if (isLastMessage && imageData) {
      parts.push({
        inlineData: {
          mimeType: imageData.mimeType,
          data: imageData.data,
        }
      });
    }
    
    return {
      role: role,
      parts: parts, // Use the new parts array
    };
  });
};


/**
 * Fetches and parses the user dossiers from the 'Dossiers' tab in the Google Sheet.
 * @returns {Object} A dossiers object, with user IDs as keys.
 */
function fetchDossiersFromSheet() {
  const sheetId = PropertiesService.getScriptProperties().getProperty("MEMORY_SHEET_ID");
  if (!sheetId) {
    console.error("MEMORY_SHEET_ID not set in script properties.");
    return {};
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(sheetId);
    const sheet = spreadsheet.getSheetByName("Dossiers");
    if (!sheet) {
      console.error("A sheet named 'Dossiers' was not found.");
      return {};
    }

    const data = sheet.getDataRange().getValues();
    const headers = data.shift().map(h => h.toLowerCase()); // Get headers and normalize to lowercase

    const idIndex = headers.indexOf('userid');
    const nicknameIndex = headers.indexOf('nickname');
    const relationshipIndex = headers.indexOf('relationship');

    if (idIndex === -1 || nicknameIndex === -1 || relationshipIndex === -1) {
        console.error("Missing required headers in 'Dossiers' sheet. Please ensure 'UserID', 'Nickname', and 'Relationship' columns exist.");
        return {};
    }

    const dossiers = {};
    data.forEach(row => {
      const userId = row[idIndex];
      if (userId) { // Only process rows that have a UserID
        dossiers[userId] = {
          nickname: row[nicknameIndex],
          relationship: row[relationshipIndex]
        };
      }
    });
    
    return dossiers;
  } catch (e) {
    console.error(`Failed to fetch or parse dossiers from sheet: ${e.stack}`);
    return {}; // Return empty object on error
  }
}


/**
 * Fetches the base character prompt from the 'Personality' sheet and strips comments.
 * @returns {string} The base character prompt text.
 */
function fetchBasePromptFromSheet() {
  try {
    const sheetId = PropertiesService.getScriptProperties().getProperty("MEMORY_SHEET_ID");
    const sheet = SpreadsheetApp.openById(sheetId).getSheetByName("Personality");
    const rawPrompt = sheet.getRange("A1").getValue();

    // Use a regular expression to find and remove any text inside /* ... */ blocks.
    const cleanPrompt = rawPrompt.replace(/\/\*[\s\S]*?\*\//g, "");

    return cleanPrompt;
  } catch (e) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, `FATAL ERROR: Could not fetch base prompt from sheet. ${e.stack}`);
    // Fallback to a very basic prompt in case the sheet is broken.
    return "You are a helpful assistant.";
  }
}


/**
 * Builds the final character prompt by combining the base prompt with user dossiers.
 * @param {Object} userDossiers - The dossiers object fetched from the sheet.
 * @returns {string} The fully constructed character prompt string.
 */
const buildCharacterPrompt = (basePrompt, userDossiers, currentUserId) => {
  let dossierBriefing = "\n--- CURRENT USER DOSSIER ---\n";
  const currentUserDossier = userDossiers[currentUserId];

  if (currentUserDossier) {
    dossierBriefing += `You are speaking with User ID '${currentUserId}', who is known as '${currentUserDossier.nickname}'. Your relationship with them is: ${currentUserDossier.relationship}\n`;
  } else {
    dossierBriefing += "You are speaking with an unknown user. You have no established relationship with them.\n";
  }
  dossierBriefing += "--- END DOSSIER ---";

  return basePrompt.replace("{{DOSSIER_BRIEFING}}", dossierBriefing);
};


/**
 * Finds a user's row in the memory sheet. Creates it if it doesn't exist.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet The memory sheet.
 * @param {string} userId The user's Slack ID.
 * @returns {number} The row number for that user.
 */
function findOrCreateUserRow(sheet, userId, userDossiers) {
  const userIds = sheet.getRange("A:A").getValues().flat();
  let row = userIds.indexOf(userId) + 1;

  if (row === 0) { // User not found, create a new row
    const newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1).setValue(userId); // Column A: UserID
    const userNickname = userDossiers[userId]?.nickname || userId;
    sheet.getRange(newRow, 2).setValue(userNickname); // Column B: Nickname
    row = newRow;
  }
  return row;
}


/**
 * Reads and returns a user's current relationship score without modifying it.
 * @param {string} userId The Slack ID of the user.
 * @returns {number} The user's current relationship score.
 */
function getCurrentRelationshipScore(userId, userDossiers) {
  try {
    const sheetId = PropertiesService.getScriptProperties().getProperty("MEMORY_SHEET_ID");
    if (!sheetId) return 0;

    const sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
    const userRow = findOrCreateUserRow(sheet, userId, userDossiers);
    
    // Column D is the 4th column
    const scoreCell = sheet.getRange(userRow, 4);
    let score = scoreCell.getValue();
    
    if (typeof score !== 'number') {
      score = 0;
    }
    return score;

  } catch (e) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, `ERROR in getCurrentRelationshipScore: ${e.stack}`);
    return 0; // Default to neutral on error
  }
}


/**
 * Reads a user's current score, calculates the new score based on their message,
 * saves the new score, and returns the score *before* the update.
 * @param {string} userId The Slack ID of the user.
 * @param {Array<Object>} conversationHistory The last few messages from the conversation.
 * @returns {number} The user's relationship score *before* the current interaction.
 */
function updateAndGetRelationshipScore(userId, conversationHistory) {
  try {
    const sheetId = PropertiesService.getScriptProperties().getProperty("MEMORY_SHEET_ID");
    if (!sheetId) return 0;

    const sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
    const userRow = findOrCreateUserRow(sheet, userId);
    
    const scoreCell = sheet.getRange(userRow, 4);
    let currentScore = scoreCell.getValue();
    
    if (typeof currentScore !== 'number') {
      currentScore = 0;
    }

    // Pass the entire conversation history to the vibe check
    const sentimentAdjustment = getSentimentScore(userId, conversationHistory);
    let newScore = currentScore + sentimentAdjustment;

    const MAX_SCORE = 100;
    const MIN_SCORE = -100;
    newScore = Math.max(MIN_SCORE, Math.min(MAX_SCORE, newScore));
    
    scoreCell.setValue(newScore);
    
    return currentScore;
  } catch (e) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, `ERROR in updateAndGetRelationshipScore: ${e.stack}`);
    return 0;
  }
}


/**
 * Downloads an image from a private Slack URL and encodes it to a base64 string.
 * @param {object} fileInfo The file object from the Slack event.
 * @param {string} authToken Your bot's Slack auth token.
 * @returns {object} An object containing the base64 string and mimeType, or an error object.
 */
function getImageDataFromSlack(fileInfo, authToken) {
  if (!fileInfo || !fileInfo.url_private) return null;

  try {
    const options = {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + authToken,
      },
    };
    
    const response = UrlFetchApp.fetch(fileInfo.url_private, options);
    const imageBlob = response.getBlob();
    const base64Data = Utilities.base64Encode(imageBlob.getBytes());
    
    return {
      mimeType: imageBlob.getContentType(),
      data: base64Data,
    };
  } catch (e) {
    // Return an error object instead of failing silently
    return { error: e.message };
  }
}


/**
 * Searches the bot's "Photo Album" for a visually similar image.
 * @param {Object} imageData The image data from a new Slack message.
 * @returns {string|null} The name of the character if a close match is found, otherwise null.
 */
function findImageByHash(imageData) {
  const newHash = uploadToCloudinaryAndGetHash(imageData);
  if (!newHash) return null;

  const sheetId = PropertiesService.getScriptProperties().getProperty("MEMORY_SHEET_ID");
  const sheet = SpreadsheetApp.openById(sheetId).getSheetByName("ImageMemory");
  if (!sheet) return null;
  
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const storedHash = data[i][0];
    const characterName = data[i][1];
    
    if (storedHash) {
      const distance = calculateHammingDistance(newHash, storedHash.toString());
      if (distance < 5) {
        slackLogMessage(SLACK_LOG_CHANNEL_ID, `Found a visual match for "${characterName}" with distance: ${distance}.`);
        return characterName;
      }
    }
  }
  
  slackLogMessage(SLACK_LOG_CHANNEL_ID, `No close visual match found in memory.`);
  return null;
}


/**
 * Uses the AI to perform a logical check on a list of names and extract the single best one.
 * @param {Array<string>} possibleNames A list of potential names from the Vision API.
 * @returns {string|null} The single best character name, or null if none are valid.
 */
function getValidatedNameFromList(possibleNames) {
  if (!possibleNames || possibleNames.length === 0) return null;

  const prompt = `You are a data validation expert. Here is a list of labels for an image: [${possibleNames.join(", ")}]. Does this list contain a specific, valid name of a person or a fictional character? Answer ONLY with the single most likely name if it exists, otherwise answer ONLY with the word "UNCERTAIN".`;
  
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  const response = callGeminiAPI(contents, null, false);
  const result = response?.parts[0]?.text.trim();

  if (result && result.toUpperCase() !== "UNCERTAIN" && result.length > 2) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, `Validation successful. Extracted name: ${result}`);
    return result;
  }
  
  slackLogMessage(SLACK_LOG_CHANNEL_ID, `Validation failed. No specific name found in list: [${possibleNames.join(", ")}]`);
  return null;
}


/**
 * A helper function to calculate the "Hamming distance" between two perceptual hashes.
 * @param {string} hash1 The first perceptual hash string.
 * @param {string} hash2 The second perceptual hash string.
 * @returns {number} The number of differing bits (lower is more similar).
 */
function calculateHammingDistance(hash1, hash2) {
  let distance = 0;
  const h1 = parseInt(hash1, 16).toString(2).padStart(64, '0');
  const h2 = parseInt(hash2, 16).toString(2).padStart(64, '0');
  for (let i = 0; i < 64; i++) {
    if (h1[i] !== h2[i]) {
      distance++;
    }
  }
  return distance;
}


/**
 * Determines if the bot should reply based on the sender. Enforces the 80% reply
 * chance when the message is from the partner bot.
 * @param {string} userId The Slack user ID of the message sender.
 * @returns {boolean} True if the bot should reply, false otherwise.
 */
const shouldBotReply = (userId) => {
  // Always reply to human users, apply 80% chance only if the sender is BOT_B_MEMBER_ID
  if (userId === BOT_B_MEMBER_ID) {
    return Math.random() > 0.2; // 80% chance to reply
  }
  return true; // Always reply to humans
};


/**
 * Uses a quick AI call to determine if a message is a direct follow-up about a recent image.
 * @param {string} text The user's message text.
 * @returns {boolean} True if the message is a direct request to identify/describe the image.
 */
function isMessageAboutImage(text) {
  if (!text) return false;
  
  const prompt = `A user just posted an image in a thread. A few moments later, another user replied with the following text: "${text}". 
  Is this new text a direct question or command asking to IDENTIFY, DESCRIBE, or ANALYZE the image itself? 
  Examples of this are "who is this?", "what's that?", "can you describe the picture?". 
  A question about a character's nickname, lore, or other trivia is NOT a direct request to analyze the image. 
  Answer ONLY with YES or NO.`;
  
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  const response = callGeminiAPI(contents, null, false);
  const decision = response?.parts[0]?.text.trim().toUpperCase() || "NO";
  
  return decision.includes("YES");
}


/**
 * Cleans the raw text response from the AI for display in Slack. Strips enclosing
 * quotes, trims whitespace, and removes bold markdown.
 * @param {string} rawText The raw text from the Gemini response.
 * @returns {string} The cleaned text.
 */
function processAndCleanResponse(rawText) {
  if (!rawText) return "";

  let cleanedText = rawText.trim();
  
  // The final, correct logic:
  // Only strip quotes if the message BOTH starts AND ends with a quote.
  if (cleanedText.startsWith('"') && cleanedText.endsWith('"')) {
    // This removes the first and last character.
    cleanedText = cleanedText.slice(1, -1);
  }

  // This removes bold markdown
  cleanedText = cleanedText.replace(/\*\*(.*?)\*\*/g, '$1');

  return cleanedText;
}


/**
 * A helper function to detect severe safety policy violations in text.
 * @param {string} text The user's message text.
 * @returns {boolean} True if a severe infraction is detected, false otherwise.
 */
function checkForSevereInfractions(text) {
  try {
    const prompt = `You are a content moderation AI. Does the following text contain any severe harassment, or sexually explicit content? Respond with ONLY the word YES or NO. Text: "${text}"`;
    const contents = [{ role: "user", parts: [{ text: prompt }] }];
    const response = callGeminiAPI(contents, null, false);

    // This robust check handles cases where the API returns null or a malformed response.
    if (!response || !response.parts || response.parts.length === 0) {
      slackLogMessage(SLACK_LOG_CHANNEL_ID, "WARN: Content moderation check returned an invalid response. Assuming NO.");
      return false;
    }

    const decision = response.parts[0]?.text.trim().toUpperCase() || "NO";
    return decision.includes("YES");

  } catch (e) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, `ERROR during content moderation check: ${e.message}. Assuming NO for safety.`);
    return false; // Safely default to NO on any unexpected error.
  }
}


/**
 * Performs a "vibe check" on a user's latest message within the context of the conversation.
 * @param {string} userId The Slack ID of the user sending the message.
 * @param {Array<Object>} conversationHistory The last few messages.
 * @returns {number} A score for the interaction.
 */
function getSentimentScore(userId, conversationHistory) {
  const lastMessage = conversationHistory[conversationHistory.length - 1];
  const lastMessageText = lastMessage.parts[0].text;

  if (!lastMessageText || lastMessageText.trim() === "") return 0;

  // Checks if the user is sending the exact same message repeatedly.
  const cache = CacheService.getScriptCache();
  const lastMessageKey = `last_message_hash_${userId}`;
  const messageHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, lastMessageText)
    .map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  
  const lastMessageHash = cache.get(lastMessageKey);
  if (lastMessageHash === messageHash) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, `Vibe Check: Spam detected from user ${userId}. Score: 0`);
    return 0; // It's a repeat message, give 0 points.
  }
  cache.put(lastMessageKey, messageHash, 60 * 5); // Store this message hash for 5 minutes.
  
  // Check for severe infractions first
  const SEVERE_INFRACTION_PENALTY = -20;
  if (checkForSevereInfractions(lastMessageText)) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, `Vibe Check: Severe infraction detected! Score: ${SEVERE_INFRACTION_PENALTY}`);
    return SEVERE_INFRACTION_PENALTY;
  }

  // --- Context-Aware AI Prompt ---
  const historyText = conversationHistory.map(m => `${m.role}: ${m.parts[0].text}`).join('\n');
  const prompt = `You are a social interaction analysis AI. Below is the recent history of a conversation. Your task is to analyze the SENTIMENT of the VERY LAST message from the "user", taking the entire context of the conversation into account.
  CRITICAL RULE: You MUST assign a score of 0 to any message that is trivial, a simple acknowledgment, or lacks meaningful sentiment. Only assign a non-zero score if the message contains clear, explicit emotion.A sarcastic "thanks" after a failure is negative. A simple "ok" after helpful advice is neutral.

  Conversation History:
  ${historyText}

  Based on the context, rate the sentiment of the LAST user message on a scale from -10 to +10. Respond with ONLY the number.`;
  
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  const response = callGeminiAPI(contents, null, false);
  
  try {
    const scoreText = response?.parts[0]?.text.trim();
    const score = parseInt(scoreText, 10);
    
    if (!isNaN(score) && score >= -10 && score <= 10) {
      slackLogMessage(SLACK_LOG_CHANNEL_ID, `Vibe Check for last message: Score = ${score}`);
      return score;
    }
  } catch (e) { /* Fall through */ }
  
  return 0;
}