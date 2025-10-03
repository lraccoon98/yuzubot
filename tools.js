/**
 * Executes a Google Custom Search, sanitizes the results, and returns them.
 * @param {string} query The search query.
 * @returns {string} A string summarizing the search results.
 */
const searchGoogle = (query) => {
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_ENGINE_ID) {
    console.error("Google Search API Key or Search Engine ID is missing. Cannot perform search.");
    return "My search engine's unplugged. Looks like someone forgot to set up the API keys. Can't look up shit without 'em.";
  }

  const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_SEARCH_API_KEY}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&sort=date`;

  try {
    const response = UrlFetchApp.fetch(searchUrl);
    const data = JSON.parse(response.getContentText());

    if (data.items && data.items.length > 0) {
      let resultsSummary = "Search Results (sorted by most recent within the last year):\n";
      for (let i = 0; i < Math.min(data.items.length, 7); i++) {
        const item = data.items[i];

        // --- NEW: Sanitize the text from the web ---
        // This regex removes weird characters that can trigger safety filters.
        const cleanTitle = item.title.replace(/[^\p{L}\p{N}\p{P}\p{Z}^$\n]/gu, '').trim();
        const cleanSnippet = item.snippet.replace(/[^\p{L}\p{N}\p{P}\p{Z}^$\n]/gu, '').trim();

        // Use the cleaned text to build the summary
        resultsSummary += `- Title: ${cleanTitle}\n  Snippet: ${cleanSnippet}\n  Link: ${item.link}\n`;
      }
      return resultsSummary;
    } else {
      return "No relevant search results found for the query: " + query;
    }
  } catch (e) {
    console.error(`Error during Google search for "${query}": ${e.message}`);
    return `Tried to search the web, but the connection fizzled out. Annoying. The net's probably acting up again.`;
  }
};


/**
 * Gets the current date and time in Japan (JST) in a machine-readable format.
 * @returns {string} The current date and time, formatted for the AI.
 */
const getCurrentDate = () => {
  const now = new Date();
  
  // Create formatter options for each part to ensure correct JST values
  const year = now.toLocaleString('en-US', { year: 'numeric', timeZone: 'Asia/Tokyo' });
  const month = now.toLocaleString('en-US', { month: '2-digit', timeZone: 'Asia/Tokyo' });
  const day = now.toLocaleString('en-US', { day: '2-digit', timeZone: 'Asia/Tokyo' });
  const hour = now.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' });
  const minute = now.toLocaleString('en-US', { minute: '2-digit', timeZone: 'Asia/Tokyo' });

  // Manually construct the unambiguous YYYY-MM-DD format
  const dateString = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const timeString = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;

  return `[System Information] Today's date is ${dateString} (YYYY-MM-DD). The current time is ${timeString} JST.`;
};


/**
 * Fetches the text content of a given URL.
 * @param {string} url The URL to read.
 * @returns {string} The cleaned text content of the webpage.
 */
function readWebpage(url) {
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const responseCode = response.getResponseCode();
    if (responseCode !== 200) {
      return `Tried to read that page, but it slammed the door in my face. Got a ${responseCode} error.`;
    }

    let textContent = response.getContentText();
    // A series of regular expressions to strip out HTML, scripts, and styles.
    textContent = textContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
    textContent = textContent.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
    textContent = textContent.replace(/<[^>]+>/g, " ");
    textContent = textContent.replace(/\s+/g, ' ').trim();

    const MAX_PAGE_LENGTH = 15000;
    if (textContent.length > MAX_PAGE_LENGTH) {
      textContent = textContent.substring(0, MAX_PAGE_LENGTH) + "... (content trimmed)";
    }
    return textContent;
  } catch (e) {
    console.error(`Error fetching URL "${url}": ${e.message}`);
    return "I got to the site, but the text is all scrambled garbage I can't read. What a mess.";
  }
}


/**
 * A tool to remember a new fact about a user.
 * Includes a quality check for length and checks for duplicates.
 * @param {string} userId The user's Slack ID.
 * @param {string} fact The fact to remember.
 * @returns {string} A success or failure message for the AI to process.
 */
function rememberFact(userId, fact) {
  try {
    // --- Improved Input Quality Check ---
    const cleanFact = fact.trim();
    // Reject facts that are too short, are just a single word, or are likely junk.
    if (cleanFact.length < 4) {
      return "FAILURE: The fact provided was rejected for being too short, just a single word, or lacking meaningful context.";
    }
    // --- End of Input Quality Check ---

    const sheetId = PropertiesService.getScriptProperties().getProperty("MEMORY_SHEET_ID");
    if (!sheetId) return "FAILURE: Memory is not configured.";

    const sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
    const userRow = findOrCreateUserRow(sheet, userId);
    
    const factsCell = sheet.getRange(userRow, 3);
    const existingFacts = factsCell.getValue().toString();

    // --- Duplicate Check Logic ---
    if (existingFacts) {
      const normalizedNewFact = fact.toLowerCase().replace(/^- /, '').trim();
      const existingFactsArray = existingFacts.split('\n');
      
      const isDuplicate = existingFactsArray.some(savedFact => {
        const normalizedSavedFact = savedFact.toLowerCase().replace(/^- /, '').trim();
        return normalizedSavedFact === normalizedNewFact;
      });

      if (isDuplicate) {
        return "SUCCESS: This fact was already in memory. No action was needed.";
      }
    }
    // --- End of Duplicate Check ---

    const newFacts = existingFacts ? `${existingFacts}\n- ${fact}` : `- ${fact}`;
    factsCell.setValue(newFacts);

    return "SUCCESS: The fact was saved to long-term memory.";
  } catch (e) {
    return `FAILURE: ${e.message}`;
  }
}


/**
 * A tool to recall all stored facts about a user from the memory sheet.
 * @param {string} userId The Slack ID of the user to recall facts for.
 * @returns {string} A list of remembered facts, or a message if none are found.
 */
function recallFacts(userId) {
  try {
    const sheetId = PropertiesService.getScriptProperties().getProperty("MEMORY_SHEET_ID");
    if (!sheetId) return "Memory is not configured. Missing Sheet ID.";

    const sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
    const userIds = sheet.getRange("A:A").getValues().flat();
    const userRow = userIds.indexOf(userId) + 1;

    if (userRow === 0) {
      return "I don't seem to have any dirt on you. You're a blank slate.";
    }

    const facts = sheet.getRange(userRow, 3).getValue();
    if (!facts) {
      return "I've got nothing on you. My file's empty.";
    }

    const userNickname = sheet.getRange(userRow, 2).getValue();
    return `Here's the intel I have on '${userNickname}':\n${facts}`;
  } catch (e) {
    console.error(`Error in recallFacts: ${e.stack}`);
    return `My memory files are corrupted. Couldn't recall facts. Error: ${e.message}`;
  }
}


/**
 * A tool to "forget" facts related to a specific topic for a user.
 * Returns a simple success message for the AI to process.
 */
function forgetFact(userId, topic) {
  try {
    const sheetId = PropertiesService.getScriptProperties().getProperty("MEMORY_SHEET_ID");
    if (!sheetId) return "FAILURE: Memory is not configured.";

    const sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
    const userIds = sheet.getRange("A:A").getValues().flat();
    const userRow = userIds.indexOf(userId) + 1;
    if (userRow === 0) { return "SUCCESS: No file found for user, so nothing to forget."; }

    const factsCell = sheet.getRange(userRow, 3);
    const existingFacts = factsCell.getValue();
    if (!existingFacts) { return "SUCCESS: File is already empty, nothing to forget."; }

    const allFacts = existingFacts.split('\n');
    const keptFacts = allFacts.filter(fact => !fact.toLowerCase().includes(topic.toLowerCase()));
    
    if (keptFacts.length === allFacts.length) {
      return `SUCCESS: No mention of '${topic}' was found, so nothing was forgotten.`;
    }

    const newFacts = keptFacts.join('\n');
    factsCell.setValue(newFacts);
    
    return `SUCCESS: Facts about '${topic}' were forgotten.`; // Simple, factual report
  } catch (e) {
    return `FAILURE: ${e.message}`;
  }
}


/**
 * A tool for the AI. Saves a character's name and image "fingerprint" to memory.
 * @param {string} name The name of the character in the image.
 * @param {string} imageUrl The Slack private URL of the image to remember.
 * @returns {string} A success or failure message for the AI.
 */
function rememberCharacterImage(name, imageUrl) {
  try {
    const fileInfo = { url_private: imageUrl };
    const imageData = getImageDataFromSlack(fileInfo, BOT_AUTH_TOKEN);
    if (!imageData || imageData.error) {
      return `FAILURE: Could not download the image from Slack.`;
    }
    
    const imageHash = uploadToCloudinaryAndGetHash(imageData);
    if (!imageHash) {
      return `FAILURE: Could not analyze the image to get its fingerprint.`;
    }

    const sheetId = PropertiesService.getScriptProperties().getProperty("MEMORY_SHEET_ID");
    const sheet = SpreadsheetApp.openById(sheetId).getSheetByName("ImageMemory");
    sheet.appendRow([imageHash, name]);

    return `SUCCESS: Got it. I've remembered the character "${name}" from that image.`;
  } catch (e) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, `FATAL ERROR in rememberCharacterImage: ${e.stack}`);
    return `FAILURE: A critical error occurred. ${e.message}`;
  }
}