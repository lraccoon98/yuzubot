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