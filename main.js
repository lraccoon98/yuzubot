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