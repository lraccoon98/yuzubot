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