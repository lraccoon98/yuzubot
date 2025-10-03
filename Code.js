// *** GEMINI CHANGE: Updated the model name variable ***
const geminiModel = "gemini-2.5-flash";
const BOT_NICKNAMES = ["yuzu", "yuzuha", "yuzu-chan", "柚葉", "柚葉ちゃん", "ゆず", "ゆずちゃん"];

const BOT_MEMBER_ID =
  PropertiesService.getScriptProperties().getProperty("BOT_MEMBER_ID");
const BOT_AUTH_TOKEN =
  PropertiesService.getScriptProperties().getProperty("BOT_AUTH_TOKEN");
// *** GEMINI CHANGE: Using the Gemini API key now ***
const GEMINI_API_KEY =
  PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
const BOT_B_MEMBER_ID =
  PropertiesService.getScriptProperties().getProperty("BOT_B_MEMBER_ID");
const SLACK_LOG_CHANNEL_ID =
  PropertiesService.getScriptProperties().getProperty("SLACK_LOG_CHANNEL_ID");

// The number of past messages (user + assistant replies) to keep in memory.
const MAX_HISTORY_MESSAGES = 100;

// New constants for Google Custom Search API
const GOOGLE_SEARCH_API_KEY =
  PropertiesService.getScriptProperties().getProperty("GOOGLE_SEARCH_API_KEY");
const GOOGLE_SEARCH_ENGINE_ID =
  PropertiesService.getScriptProperties().getProperty("GOOGLE_SEARCH_ENGINE_ID");

// This configuration disables all safety filters.
const DISABLED_SAFETY_SETTINGS = [
  {
    category: 'HARM_CATEGORY_HARASSMENT',
    threshold: 'BLOCK_NONE'
  },
  {
    category: 'HARM_CATEGORY_HATE_SPEECH',
    threshold: 'BLOCK_NONE'
  },
  {
    category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    threshold: 'BLOCK_NONE'
  },
  {
    category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
    threshold: 'BLOCK_NONE'
  },
];

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
 * The "Etiquette Brain." This is the gatekeeper for all conversational replies.
 * It analyzes the conversation context using a complex set of social rules
 * to decide if Yuzuha should reply.
 * @param {Object} triggerMsg The incoming message from Slack.
 * @returns {Array<Object>} A list of messages for context, or an empty array to stay silent.
 */
function fetchSlackMsgsAskedToBot(triggerMsg) {
  const eventText = triggerMsg.text || "";
  if (eventText.startsWith("Log:")) return [];

  const isDirectMessage = triggerMsg.channel_type === 'im';
  const botMentioned = eventText.includes(BOT_MEMBER_ID);
  const partnerBotMentioned = eventText.includes(BOT_B_MEMBER_ID);

  // Rule 1: Yield Protocol. This is essential for Kitachan to reply first.
  if (botMentioned && partnerBotMentioned) {
    return [];
  }

  // Rule 2: Direct Summons (for starting new threads with only Yuzuha)
  if (isDirectMessage || botMentioned) {
    return triggerMsg.thread_ts ? fetchMsgsInThread(triggerMsg.channel, triggerMsg.thread_ts) : [triggerMsg];
  }

  // Rule 3: Thread Context Rules
  if (triggerMsg.thread_ts) {
    const msgsInThread = fetchMsgsInThread(triggerMsg.channel, triggerMsg.thread_ts);
    if (msgsInThread.length === 0) return [];
    
    if (triggerMsg.ts !== msgsInThread[msgsInThread.length - 1].ts) return [];

    const fromPartnerBot = triggerMsg.user === BOT_B_MEMBER_ID;

    // --- REORDERED LOGIC ---
    // First, handle all potential replies to the partner bot.
    if (fromPartnerBot) {
      if (msgsInThread.length >= 2) {
        const messageBeforePartner = msgsInThread[msgsInThread.length - 2];
        const previousText = messageBeforePartner.text || "";
        const wasFromHuman = !messageBeforePartner.bot_id;
        const mentionedMe = previousText.includes(BOT_MEMBER_ID);
        const mentionedPartner = previousText.includes(BOT_B_MEMBER_ID);

        // The "convo chain" trigger.
        if (wasFromHuman && mentionedMe && mentionedPartner) {
          return msgsInThread;
        }
        // The old etiquette rule.
        if (wasFromHuman && !mentionedMe) {
          return [];
        }
      }
      return msgsInThread; // Default to replying to the partner bot.
    }

    // --- THEN, handle messages from humans ---
    const firstMsgText = msgsInThread[0].text || "";
    const iWasSummonedInFirstMessage = firstMsgText.includes(BOT_MEMBER_ID);

    if (!iWasSummonedInFirstMessage) {
      return []; // If not summoned at the start, ignore human messages.
    }
    
    // Standard human message handling.
    if (eventText.includes("<@") && !eventText.includes(BOT_MEMBER_ID)) return [];
    return msgsInThread;
  }
  return [];
}

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
 * Fetches and parses the latest articles from an RSS feed,
 * automatically handling multiple common RSS formats and XML namespaces.
 * @param {string} feedUrl The URL of the RSS feed.
 * @returns {Array<Object>} An array of article objects, each with a title and link.
 */
function fetchNewsFromRSS(feedUrl) {
  try {
    const options = {
      'headers': {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    };

    const xml = UrlFetchApp.fetch(feedUrl, options).getContentText();
    const document = XmlService.parse(xml);
    const root = document.getRootElement();
    let items = [];

    // --- The Master Logic ---
    // First, try the standard RSS 2.0 format where <item> is inside <channel>.
    const channel = root.getChild('channel');
    if (channel) {
        items = channel.getChildren('item');
    }

    // If that didn't find any articles, try the RSS 1.0 format with a specific namespace.
    if (items.length === 0) {
        const rssNamespace = XmlService.getNamespace("http://purl.org/rss/1.0/");
        items = root.getChildren("item", rssNamespace);
    }
    // --- End Master Logic ---

    if (items.length === 0) {
      console.warn(`Could not find any <item> tags in the RSS feed: ${feedUrl}`);
      return [];
    }

    const articles = [];
    // Get the top 5 articles
    for (let i = 0; i < Math.min(items.length, 5); i++) {
      // This part is now smart enough to get the correct namespace from the item itself.
      const itemNamespace = items[i].getNamespace();
      const title = items[i].getChild('title', itemNamespace)?.getText();
      const link = items[i].getChild('link', itemNamespace)?.getText();

      if (title && link) {
        articles.push({ title: title, link: link });
      }
    }
    return articles;
  } catch (e) {
    console.error(`Failed to fetch or parse RSS feed: ${e.stack}`);
    return [];
  }
}

/**
 * Fetches news from an RSS feed and posts a formatted briefing to Slack.
 */
function sendDailyNewsBriefing() {
  // We can easily switch sources just by changing this URL.
  // Siliconera's feed is a good, clean source.
  const NEWS_SOURCE_URL = "https://www.4gamer.net/rss/arcade/arcade_news.xml";
  const BRIEFING_CHANNEL_ID = PropertiesService.getScriptProperties().getProperty("BRIEFING_CHANNEL_ID");

  if (!BRIEFING_CHANNEL_ID) {
    console.error("BRIEFING_CHANNEL_ID is not set. Aborting briefing.");
    return;
  }

  const articles = fetchNewsFromRSS(NEWS_SOURCE_URL);

  if (articles.length === 0) {
    slackPostMessage(BRIEFING_CHANNEL_ID, "Heh, tried to get the news, but the data stream is dead. Couldn't fetch any articles.");
    return;
  }

  // Build the message for Slack.
  let message = "*Today's Arcade Scoop* :newspaper:\n\nGot the latest arcade intel fresh off the wire for ya:\n";
  articles.forEach(article => {
    message += `• <${article.link}|${article.title}>\n`;
  });

  slackPostMessage(BRIEFING_CHANNEL_ID, message);
}

/**
 * Defines the tools (functions) that the Gemini model can call.
 */
const tools = [{
  functionDeclarations: [
    {
      name: "searchGoogle",
      description: "Searches Google for recent and up-to-date information. Use for questions about current events, facts, or things not in your base knowledge.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: {
            type: "STRING",
            description: "The search query to look up on Google.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "getCurrentDate",
      description: "Use this function to get the current date and time in Japan (JST).",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "readWebpage",
      description: "Reads the text content of a given webpage URL. Use this after 'searchGoogle' to get more detail from a promising link.",
      parameters: {
        type: "OBJECT",
        properties: {
          url: {
            type: "STRING",
            description: "The full URL of the webpage to read.",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "rememberFact",
      description: "Saves a significant, long-term fact about a user, like their birthday, core preferences (favorite game/food), or important personal details. You are the quality filter. Before calling this tool, you must judge if the fact is meaningful and worth remembering long-term. Do NOT save trivial, temporary, or conversational filler.",
      parameters: {
        type: "OBJECT",
        properties: {
          userId: {
            type: "STRING",
            description: "The Slack ID of the user the fact is about.",
          },
          fact: {
            type: "STRING",
            description: "The single, concise fact to remember.",
          },
        },
        required: ["userId", "fact"],
      },
    },
    {
      name: "recallFacts",
      description: "Retrieves saved facts about a user from long-term memory. Use this to answer any direct question about a user's personal information, such as their birthday, preferences, or details they have asked you to remember.",
      parameters: {
        type: "OBJECT",
        properties: {
          userId: {
            type: "STRING",
            description: "The Slack ID of the user to retrieve facts for.",
          },
        },
        required: ["userId"],
      },
    },
    {
      name: "forgetFact",
      description: "Deletes facts about a specific topic from a user's long-term memory. Use this when a user asks you to 'forget' something.",
      parameters: {
        type: "OBJECT",
        properties: {
          userId: {
            type: "STRING",
            description: "The Slack ID of the user.",
          },
          topic: {
            type: "STRING",
            description: "A keyword or topic to search for and remove from the user's memory file.",
          },
        },
        required: ["userId", "topic"],
      },
    },
    {
      name: "rememberCharacterImage",
      description: "Saves a character's name and image fingerprint to memory. Use this when a user explicitly tells you to remember a character. Also use this proactively if you successfully identify a character using other tools and believe the user would want you to remember it.",
      parameters: {
        type: "OBJECT",
        properties: {
          name: {
            type: "STRING",
            description: "The name of the character to remember.",
          },
          imageUrl: {
            type: "STRING",
            description: "The private Slack URL of the image file that the user attached. The system provides this automatically when a user asks to remember a character from an image.",
          },
        },
        required: ["name", "imageUrl"],
      },
    }
  ],
}];

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
 * The primary "Conversation Manager." It orchestrates the entire process of generating
 * a response for a direct conversation, including checking etiquette rules, handling
 * images with the Vision API, and calling the Gemini model.
 * @param {Object} triggerMsg The raw Slack event that initiated the conversation.
 * @returns {string} The final, cleaned response text from the AI, or an empty string.
 */
function fetchAIAnswerText(triggerMsg) {
  const msgsAskedToBot = fetchSlackMsgsAskedToBot(triggerMsg);
  if (!msgsAskedToBot || msgsAskedToBot.length === 0) return "";
  const userId = triggerMsg.user;
  if (!shouldBotReply(userId)) return "";

  let fileInfo = (triggerMsg.files && triggerMsg.files.length > 0) ? triggerMsg.files[0] : null;
  
  // If the current message has no file, check if it's a follow-up to a previous image.
  if (!fileInfo && triggerMsg.thread_ts) {
    if (isMessageAboutImage(triggerMsg.text || "")) {
      // It IS a follow-up. Search the history for the most recent image.
      for (let i = msgsAskedToBot.length - 1; i >= 0; i--) {
        if (msgsAskedToBot[i].files && msgsAskedToBot[i].files.length > 0) {
          fileInfo = msgsAskedToBot[i].files[0];
          break;
        }
      }
    }
  }
  const fallbackMessage = "I seem to have lost my train of thought... Heh. Ask me that again, or try something else.";

  try {
    let externalKnowledge = "";
    let imageDataForFinalPrompt = null;

    if (fileInfo) {
      const imageData = getImageDataFromSlack(fileInfo, BOT_AUTH_TOKEN);
      if (imageData && !imageData.error) {
        imageDataForFinalPrompt = imageData;
        const knownName = findImageByHash(imageData);
        
        if (knownName) {
          // Path 1: A match was found in our custom memory.
          externalKnowledge = `\n[System Command: My internal memory identified this as "${knownName}". Incorporate this name into your natural, in-character response.]`;
        } else {
          // Path 2: No custom memory match, use the two-step "Think, then Speak" process.
          const rawPossibleNames = getCharacterNameFromVisionAPI(imageData); 
          const validatedName = getValidatedNameFromList(rawPossibleNames); // The "Think" step.

          if (validatedName) {
            // If validation succeeded, the final instruction is simple.
            externalKnowledge = `\n[System Command: The character has been identified as "${validatedName}". State this in your own voice and add a brief, relevant comment.]`;
          } else {
            // If validation failed, the instruction is also simple.
            externalKnowledge = `\n[System Command: The character could not be identified. You MUST state that you are not sure in an in-character way. Do not guess.]`;
          }
        }
      } else if (imageData && imageData.error) {
        return `Ugh, I tried to look at that image...`;
      }
    }

    const allDossiers = fetchDossiersFromSheet();
    const basePrompt = fetchBasePromptFromSheet();
    const userId = triggerMsg.user;

    // This now provides the dossier for ONLY the current user.
    let character = buildCharacterPrompt(basePrompt, allDossiers, userId);
    const relationshipScoreEnabled = PropertiesService.getScriptProperties().getProperty("RELATIONSHIP_SCORE_ENABLED");
    if (relationshipScoreEnabled === "true") {
      const score = getCurrentRelationshipScore(userId, allDossiers);
      character += `\n\nRELATIONSHIP SCORE: ${score}`;
    }
    let msgsForGemini = parseSlackMsgsToGeminiQueryMsgs(msgsAskedToBot, imageDataForFinalPrompt);

    const systemInstruction = { role: "system", parts: [{ text: character }] };
    let firstResponseContent = callGeminiAPI(msgsForGemini, systemInstruction, true, DISABLED_SAFETY_SETTINGS);

    if (!firstResponseContent || !firstResponseContent.parts || firstResponseContent.parts.length === 0) {
      slackLogMessage(SLACK_LOG_CHANNEL_ID, "Initial API response was invalid or blocked. Returning fallback.");
      return fallbackMessage;
    }

    if (firstResponseContent.parts.some(part => part.functionCall)) {
      const functionCalls = firstResponseContent.parts.filter(p => p.functionCall).map(p => p.functionCall);
      let toolResults = [];
      for (const functionCall of functionCalls) {
        let toolResult;
        const functionName = functionCall.name;
        switch (functionName) {
          case "searchGoogle": toolResult = searchGoogle(functionCall.args.query); break;
          case "getCurrentDate": toolResult = getCurrentDate(); break;
          case "readWebpage": toolResult = readWebpage(functionCall.args.url); break;
          case "rememberFact": toolResult = rememberFact(functionCall.args.userId || userId, functionCall.args.fact); break;
          case "forgetFact": toolResult = forgetFact(functionCall.args.userId || userId, functionCall.args.topic); break;
          case "recallFacts": toolResult = recallFacts(functionCall.args.userId || userId); break;
          case "rememberCharacterImage": toolResult = rememberCharacterImage(functionCall.args.name, triggerMsg.files[0].url_private); break;
          default: toolResult = "Whoa, tried to use some kinda gadget that's not in my inventory. My bad. What were you asking?";
        }
        toolResults.push({ functionResponse: { name: functionName, response: { result: toolResult } } });
      }
      const conversationWithToolResult = [ ...msgsForGemini, { role: "model", parts: firstResponseContent.parts }, { role: "tool", parts: toolResults }];
      let finalResponseContent = callGeminiAPI(conversationWithToolResult, systemInstruction, true, DISABLED_SAFETY_SETTINGS);
      const rawFinalText = finalResponseContent?.parts[0]?.text;
      if (rawFinalText && rawFinalText.trim() !== "") {
        return processAndCleanResponse(rawFinalText);
      } else {
        slackLogMessage(SLACK_LOG_CHANNEL_ID, "The AI's post-tool reply contained no text. Returning fallback.");
        return fallbackMessage;
      }
    } else {
      const rawAnswerText = firstResponseContent.parts[0]?.text;
      if (rawAnswerText && rawAnswerText.trim() !== "") {
        return processAndCleanResponse(rawAnswerText);
      } else {
        slackLogMessage(SLACK_LOG_CHANNEL_ID, "The AI's initial reply contained no text. Returning fallback.");
        return fallbackMessage;
      }
    }

  } catch (e) {
    slackLogMessage(SLACK_LOG_CHANNEL_ID, `CRITICAL ERROR in fetchAIAnswerText: ${e.stack}`);
    return `Damn, the whole system just short-circuited on me. My handler needs to see this: \`\`\`${e.stack}\`\`\``;
  }
}

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
 * The main entry point for all incoming POST requests from Slack. Acts as the master
 * "traffic cop" for the bot, filtering events and routing them to the correct logic handler.
 * @param {Object} e The event parameter from the Google Apps Script trigger.
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return ContentService.createTextOutput("OK");

  try {
    const reqObj = JSON.parse(e.postData.getDataAsString());
    const event = reqObj.event;

    // --- Basic Event Filtering ---
    if (reqObj.type === "url_verification") return ContentService.createTextOutput(reqObj.challenge);
    if (!event || event.type !== 'message') return ContentService.createTextOutput("OK");

    // --- Universal Timestamp Guard ---
    const messageTimestamp = parseFloat(event.ts);
    const currentTimestamp = new Date().getTime() / 1000;
    const messageAgeInSeconds = currentTimestamp - messageTimestamp;
    if (messageAgeInSeconds > 60) {
      // slackLogMessage(SLACK_LOG_CHANNEL_ID, `GLOBAL: Ignoring stale event. Message is ${Math.round(messageAgeInSeconds)} seconds old.`);
      return ContentService.createTextOutput("OK");
    }

    // --- Ignore Self Filter ---
    const BOT_A_BOT_ID = PropertiesService.getScriptProperties().getProperty("BOT_A_BOT_ID");
    if ((event.bot_id && event.bot_id === BOT_A_BOT_ID) || event.user === BOT_MEMBER_ID) {
      return ContentService.createTextOutput("OK");
    }

    // --- Universal Duplicate Check ---
    const msgId = event.client_msg_id || event.ts;
    const cache = CacheService.getScriptCache();
    if (cache.get(msgId)) return ContentService.createTextOutput("OK");
    cache.put(msgId, "true", 60 * 10);

    // --- Main Logic Router ---
    const GHOST_MODE_CHANNEL_ID = PropertiesService.getScriptProperties().getProperty("GHOST_MODE_CHANNEL_ID");
    const isDirectMention = (event.text || "").includes(BOT_MEMBER_ID);
    const isDirectMessage = event.channel_type === 'im';
    const isThreaded = event.thread_ts !== undefined;
    
    // If it's a direct conversation (DM, mention, or any threaded message), use the main conversational engine.
    if (isDirectMessage || isDirectMention || isThreaded) {
      const answerMsg = fetchAIAnswerText(event);
      if (answerMsg) {
        slackPostMessage(event.channel, answerMsg, { thread_ts: event.thread_ts || event.ts });
      }
    // Otherwise, check if it's a candidate for Ghost Mode.
    } else if (event.channel === GHOST_MODE_CHANNEL_ID) {
      const answerMsg = handleGhostModeMessage(event);
      if (answerMsg) {
        slackPostMessage(event.channel, answerMsg);
      }
    }
    
  } catch (err) {
    // Error handling
  } finally {
    lock.releaseLock();
  }
  return ContentService.createTextOutput("OK");
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
 * The "Ghost Brain." This function contains the logic for the bot's unprompted
 * interjections, now with full relationship awareness.
 * @param {Object} event The Slack event object for the message.
 * @returns {string} The bot's response, or an empty string if it decides to stay silent.
 */
function handleGhostModeMessage(event) {
  // Cooldown check is still here
  const channelId = event.channel;
  const cache = CacheService.getScriptCache();
  const cooldownKey = `ghost_mode_cooldown_${channelId}`;
  if (cache.get(cooldownKey)) {
    return "";
  }

  const userText = event.text || "";
  const lowerCaseText = userText.toLowerCase();

  // This is the new, reliable, code-based check for triggers
  const isNameMentioned = BOT_NICKNAMES.some(name => lowerCaseText.includes(name));
  const isSlurMentioned = lowerCaseText.includes("nigga"); 

  // If either of the trigger conditions are met, proceed to generate a response.
  if (isNameMentioned || isSlurMentioned) {
    const userId = event.user;
    const allDossiers = fetchDossiersFromSheet();
    const basePrompt = fetchBasePromptFromSheet();

    // Pass the userId to the prompt builder, as required by our new architecture.
    let character = buildCharacterPrompt(basePrompt, allDossiers, userId);
    
    // Pass the dossiers to the score function, as required by our previous fix.
    const relationshipScoreEnabled = PropertiesService.getScriptProperties().getProperty("RELATIONSHIP_SCORE_ENABLED");
    if (relationshipScoreEnabled === "true") {
      const score = getCurrentRelationshipScore(userId, allDossiers);
      character += `\n\nRELATIONSHIP SCORE: ${score}`;
    }

    const systemInstruction = { role: "system", parts: [{ text: character }] };
    const responsePrompt = `A user in a group chat said: "${userText}". Based on your Yuzuha personality (and the provided relationship context), jump into the conversation with a relevant, witty, or insightful comment.`;
    const responseContents = [{ role: "user", parts: [{ text: responsePrompt }] }];
    let finalResponse = callGeminiAPI(responseContents, systemInstruction, true, DISABLED_SAFETY_SETTINGS);
    
    const responseText = finalResponse?.parts[0]?.text;

    if (responseText) {
      cache.put(cooldownKey, "true", 15); // Your cooldown
      return processAndCleanResponse(responseText);
    }
  }

  return ""; // Default to saying nothing if no triggers are met.
}

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