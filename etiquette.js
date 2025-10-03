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