import type { Context } from "grammy";
import { opencode } from "../../opencode/client.js";
import { getState, setState, stateKey } from "../../services/session.js";
import { logger } from "../../utils/logger.js";
import {
  getTopicForSession,
  setTopicMapping,
  removeSessionMapping,
  updateTopicName,
  formatTopicName,
  effectiveDir,
  setIntendedDir,
} from "../../services/topic-store.js";
import { formatSessionMessages } from "../../services/formatter.js";
import { sessionsKeyboard, sessionActionsKeyboard } from "../keyboards/sessions.js";
import { providersKeyboard, modelsKeyboard } from "../keyboards/models.js";
import { projectsKeyboard } from "../keyboards/projects.js";
import {
  switcherKeyboard,
  switcherProvidersKeyboard,
  switcherModelsKeyboard,
  switcherVariantsKeyboard,
  switcherAgentsKeyboard,
  extractVariants,
} from "../keyboards/switcher.js";
import { splitMessage, escapeHtml } from "../../utils/telegram.js";
import { answerQuestionOption, dismissQuestion } from "./question.js";
import { takeTalkBack } from "./voice.js";
import { armTalkBack } from "../../services/speak.js";
import { takeToken } from "../../services/callback-tokens.js";
import { config } from "../../config.js";
import { listSubdirectories, shortenDir } from "../commands/actions.js";

export async function callbackHandler(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const userId = ctx.from!.id;
  // Per-chat state: isolates parallel workflows across groups/topics.
  const userKey = stateKey(ctx.chat?.id, userId);
  logger.info("Incoming callback", { userId, data: data.slice(0, 80) });
  const parts = data.split(":");

  try {
    switch (parts[0]) {
      case "session":
        await handleSession(ctx, userKey, parts);
        break;
      case "model":
        await handleModel(ctx, userKey, parts);
        break;
      case "agent":
        await handleAgent(ctx, userKey, parts);
        break;
      case "project":
        await handleProject(ctx, userKey, parts);
        break;
      case "action":
        await handleAction(ctx, userKey, parts);
        break;
      case "confirm":
        await handleConfirm(ctx, userKey, parts);
        break;
      case "perm":
        await handlePermission(ctx, userKey, parts);
        break;
      case "q":
        await handleQuestion(ctx, parts);
        break;
      case "voice":
        await handleVoiceChoice(ctx, parts);
        break;
      case "sw":
        await handleSwitcher(ctx, userKey, parts);
        break;
      case "noop":
        await ctx.answerCallbackQuery();
        break;
      default:
        await ctx.answerCallbackQuery({ text: "Unknown action" });
    }
  } catch (err) {
    logger.error("Callback handler error", { data, error: String(err) });
    await ctx.answerCallbackQuery({ text: "❌ Error occurred" });
  }
}

// ── Session callbacks ──────────────────────────────────────

export async function openOrCreateTopic(
  ctx: Context,
  sessionId: string,
  sessionName: string,
  directory: string,
): Promise<number | null> {
  const chatId = ctx.chat!.id;
  const topicName = formatTopicName(directory, sessionName);

  const existing = getTopicForSession(sessionId);
  if (existing) {
    try {
      await ctx.api.reopenForumTopic(chatId, existing.topicId);
    } catch {
      // already open — fine
    }
    if (existing.name !== topicName) {
      try {
        await ctx.api.editForumTopic(chatId, existing.topicId, { name: topicName });
        updateTopicName(sessionId, topicName);
      } catch {
        // non-critical
      }
    }
    return existing.topicId;
  }

  try {
    const topic = await ctx.api.createForumTopic(chatId, topicName, {
      icon_color: 0x6FB9F0,
    });
    setTopicMapping(chatId, sessionId, topic.message_thread_id, topicName);
    return topic.message_thread_id;
  } catch (err) {
    logger.error("Failed to create forum topic", { error: String(err) });
    return null;
  }
}

async function pushSessionHistory(
  ctx: Context,
  sessionId: string,
  topicId: number,
  limit = 8,
): Promise<void> {
  const chatId = ctx.chat!.id;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const sendThreaded = async (text: string, parseMode?: "HTML"): Promise<void> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await ctx.api.sendMessage(chatId, text, {
          message_thread_id: topicId,
          ...(parseMode ? { parse_mode: parseMode } : {}),
        });
        return;
      } catch (err) {
        // Flood control: honor Telegram's backoff, then continue once.
        const m = String(err).match(/retry after (\d+)/i);
        if (m?.[1]) await sleep(Number(m[1]) * 1000 + 500);
        else throw err;
      }
    }
  };

  try {
    const messages = await opencode.getMessages(sessionId);
    const formatted = formatSessionMessages(messages, limit);

    const session = await opencode.getSession(sessionId).catch(() => null);
    const lastUser = [...messages].reverse().find((m) => m.info.role === "user");
    const lastUserText = lastUser?.parts.find((p) => p.type === "text")?.text ?? "";
    const effDir = session ? effectiveDir(sessionId, session.directory) : "";
    const header =
      `📌 <b>Session</b>\n` +
      `📁 <code>${escapeHtml(effDir)}</code>\n` +
      `💬 ${messages.filter((m) => m.info.role === "user" || m.info.role === "assistant").length} messages` +
      (lastUserText ? `\nLast prompt: <i>${escapeHtml(lastUserText.slice(0, 140))}</i>` : "");

    if (formatted.length === 0) {
      await sendThreaded(`${header}\n\n📭 No messages in this session yet.`, "HTML");
      return;
    }

    await sendThreaded(header, "HTML");
    // Paced sends: bursts of history trip Telegram flood control (429).
    for (const text of formatted) {
      const chunks = splitMessage(text, config.stream.maxMessageLength);
      for (const chunk of chunks) {
        await sendThreaded(chunk, "HTML");
        await sleep(350);
      }
    }
  } catch (err) {
    const msg = String(err);
    // Topic deleted (or never existed): forget the mapping and fall back to
    // the chat root instead of failing the whole resume.
    if (msg.includes("message thread not found")) {
      logger.warn("Forum topic gone, falling back to chat root", { sessionId });
      removeSessionMapping(sessionId);
      try {
        const messages = await opencode.getMessages(sessionId);
        const formatted = formatSessionMessages(messages, limit);
        const head = "📭 History will appear here (topic was removed).";
        const first = formatted.length > 0 ? formatted[0]! : "📭 No messages in this session yet.";
        await ctx.api.sendMessage(chatId, `${head}\n\n${first}`, { parse_mode: "HTML" });
        for (const text of formatted.slice(1)) {
          for (const chunk of splitMessage(text, config.stream.maxMessageLength)) {
            await ctx.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
          }
        }
      } catch (err2) {
        logger.error("Failed to push session history fallback", { error: String(err2) });
      }
      return;
    }
    logger.error("Failed to push session history", { error: msg });
    await ctx.api.sendMessage(chatId, "⚠️ Could not load session history.", {
      message_thread_id: topicId,
    });
  }
}

async function handleSession(ctx: Context, userKey: number, parts: string[]): Promise<void> {
  const action = parts[1];

  switch (action) {
    case "resume": {
      const sessionId = parts[2]!;
      setState(userKey, { activeSessionId: sessionId });
      const session = await opencode.getSession(sessionId);
      await ctx.answerCallbackQuery({ text: `Resumed: ${session.slug}` });
      const effDir = effectiveDir(sessionId, session.directory);

      // Forum topics only exist in forum groups — never attempt in private chats.
      const topicId = ctx.chat?.type === "private"
        ? null
        : await openOrCreateTopic(ctx, sessionId, session.title || session.slug, effDir);
      if (topicId) {
        await ctx.editMessageText(
          `✅ Active session: *${session.title || session.slug}*\n📁 ${effDir}\n\nOpened in topic thread.`,
          {
            parse_mode: "Markdown",
            reply_markup: sessionActionsKeyboard(sessionId),
          },
        );
        await pushSessionHistory(ctx, sessionId, topicId);
      } else {
        await ctx.editMessageText(
          `✅ Active session: *${session.title || session.slug}*\n📁 ${effDir}\n\nSend messages here directly.`,
          {
            parse_mode: "Markdown",
            reply_markup: sessionActionsKeyboard(sessionId),
          },
        );
      }
      break;
    }

    case "page": {
      const page = Number(parts[2]);
      const sessions = await opencode.listAllSessions([getState(userKey).activeDirectory]);
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({
        reply_markup: sessionsKeyboard(sessions, page, (x) => effectiveDir(x.id, x.directory)),
      });
      break;
    }

    case "new": {
      if (getState(userKey).isBusy) {
        await ctx.answerCallbackQuery({ text: "Busy — wait for the current task" }).catch(() => {});
        break;
      }
      setState(userKey, { isBusy: true });
      const state = getState(userKey);
      // Queries expire while creation runs (~1 min); never fail on a stale ack.
      const ack = (o?: object): Promise<unknown> => {
        return ctx.answerCallbackQuery(o).catch(() => {});
      };
      await ack({ text: "Creating session..." });
      let session;
      try {
        session = await opencode.createSessionInDir(
          state.activeDirectory,
          state.selectedModel ?? config.defaults.model,
        );
      } catch (err) {
        setState(userKey, { isBusy: false });
        await ack({ text: "Creation failed" });
        await ctx.editMessageText(
          `❌ Could not create session: ${err instanceof Error ? err.message : "unknown error"}`,
        );
        break;
      }
      setState(userKey, { activeSessionId: session.id, isBusy: false });
      // Remember the intended project (server pins its own directory).
      setIntendedDir(session.id, state.activeDirectory);
      const intendedDir = state.activeDirectory;
      await ack({ text: "Session created" });

      const topicId = ctx.chat?.type === "private"
        ? null
        : await openOrCreateTopic(ctx, session.id, session.title || session.slug, intendedDir);
      if (topicId) {
        await ctx.editMessageText(
          `✅ New session: *${session.title || session.slug}*\n📁 ${intendedDir}\n🔐 Approvals ON — I'll ask here before running shell commands or editing files.\n\nSend your message in the topic thread to start coding.`,
          { parse_mode: "Markdown" },
        );
      } else {
        await ctx.editMessageText(
          `✅ New session: *${session.title || session.slug}*\n📁 ${intendedDir}\n🔐 Approvals ON — I'll ask here before running shell commands or editing files.\n\nSend me a message to start coding.`,
          { parse_mode: "Markdown" },
        );
      }
      break;
    }

    case "fork": {
      const sessionId = parts[2]!;
      const forked = await opencode.forkSession(sessionId);
      setState(userKey, { activeSessionId: forked.id });
      await ctx.answerCallbackQuery({ text: "Session forked" });

      const topicId = ctx.chat?.type === "private"
        ? null
        : await openOrCreateTopic(ctx, forked.id, forked.title || forked.slug, forked.directory);
      if (topicId) {
        await ctx.editMessageText(
          `🔀 Forked: *${forked.title || forked.slug}*\n\nOpened in topic thread.`,
          { parse_mode: "Markdown" },
        );
        await pushSessionHistory(ctx, forked.id, topicId);
      } else {
        await ctx.editMessageText(
          `🔀 Forked: *${forked.title || forked.slug}*`,
          { parse_mode: "Markdown" },
        );
      }
      break;
    }

    case "share": {
      const sessionId = parts[2]!;
      try {
        const shareData = await opencode.shareSession(sessionId);
        await ctx.answerCallbackQuery({ text: "Share link created" });
        await ctx.editMessageText(`🔗 Share link:\n${shareData.url}`);
      } catch {
        await ctx.answerCallbackQuery({ text: "Failed to create share link" });
      }
      break;
    }

    case "compact": {
      const sessionId = parts[2]!;
      await ctx.answerCallbackQuery({ text: "Compacting..." });
      await opencode.summarizeSession(sessionId);
      await ctx.editMessageText("✅ Session compacted. Token usage reduced.");
      break;
    }

    case "delete": {
      const sessionId = parts[2]!;
      const state = getState(userKey);

      const topicEntry = getTopicForSession(sessionId);
      if (topicEntry) {
        try {
          await ctx.api.deleteForumTopic(topicEntry.chatId, topicEntry.topicId);
        } catch (err) {
          logger.debug("Failed to delete forum topic", { error: String(err) });
        }
        removeSessionMapping(sessionId);
      }

      await opencode.deleteSession(sessionId);
      if (state.activeSessionId === sessionId) {
        setState(userKey, { activeSessionId: null });
      }
      await ctx.answerCallbackQuery({ text: "Session deleted" });
      const sessions = await opencode.listAllSessions([getState(userKey).activeDirectory]);
      if (sessions.length > 0) {
        await ctx.editMessageText("📋 *Sessions*\n\nSelect a session to resume:", {
          parse_mode: "Markdown",
          reply_markup: sessionsKeyboard(sessions, 0, (x) => effectiveDir(x.id, x.directory)),
        });
      } else {
        await ctx.editMessageText("No sessions left. Use /new to create one.");
      }
      break;
    }

    case "list": {
      const sessions = await opencode.listAllSessions([getState(userKey).activeDirectory]);
      await ctx.answerCallbackQuery();
      if (sessions.length > 0) {
        await ctx.editMessageText("📋 *Sessions*\n\nSelect a session to resume:", {
          parse_mode: "Markdown",
          reply_markup: sessionsKeyboard(sessions, 0, (x) => effectiveDir(x.id, x.directory)),
        });
      } else {
        await ctx.editMessageText("No sessions. Use /new to create one.");
      }
      break;
    }

    default:
      await ctx.answerCallbackQuery({ text: "Unknown session action" });
  }
}

// ── Model callbacks ────────────────────────────────────────

async function handleModel(ctx: Context, userKey: number, parts: string[]): Promise<void> {
  const action = parts[1];

  switch (action) {
    case "provider": {
      const providerId = parts[2]!;
      const providersData = await opencode.getProviders();
      const provider = providersData.providers.find((p) => p.id === providerId);
      if (!provider) {
        await ctx.answerCallbackQuery({ text: "Provider not found" });
        return;
      }
      const state = getState(userKey);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`🤖 *${provider.name}* — Select a model:`, {
        parse_mode: "Markdown",
        reply_markup: modelsKeyboard(provider, state.selectedModel?.modelID),
      });
      break;
    }

    case "select": {
      const providerId = parts[2]!;
      const modelId = parts.slice(3).join(":");
      setState(userKey, { selectedModel: { providerID: providerId, modelID: modelId } });
      await ctx.answerCallbackQuery({ text: `Model: ${modelId}` });
      await ctx.editMessageText(`✅ Model set to \`${providerId}/${modelId}\``, {
        parse_mode: "Markdown",
      });
      break;
    }

    case "list": {
      const providersData = await opencode.getProviders();
      const state = getState(userKey);
      let text = "🤖 *Select a provider:*\n";
      if (state.selectedModel) {
        text += `\nCurrent: \`${state.selectedModel.providerID}/${state.selectedModel.modelID}\``;
      }
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: providersKeyboard(providersData.providers),
      });
      break;
    }

    default:
      await ctx.answerCallbackQuery({ text: "Unknown model action" });
  }
}

// ── Agent callbacks ────────────────────────────────────────

async function handleAgent(ctx: Context, userKey: number, parts: string[]): Promise<void> {
  const action = parts[1];

  if (action === "select") {
    const agentId = parts[2]!;
    setState(userKey, { selectedAgent: agentId });
    await ctx.answerCallbackQuery({ text: `Agent: ${agentId}` });
    await ctx.editMessageText(`✅ Agent set to *${agentId}*`, { parse_mode: "Markdown" });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown agent action" });
}

// ── Project callbacks ──────────────────────────────────────

async function handleProject(ctx: Context, userKey: number, parts: string[]): Promise<void> {
  const action = parts[1];

  if (action === "select" || action === "pick") {
    const rest = parts.slice(2).join(":");
    let dir: string | undefined;
    if (action === "pick") {
      // Index into the live sorted listing (short callback data).
      const dirs = listSubdirectories(config.opencode.defaultDir);
      dir = dirs[Number(rest)];
    } else {
      dir = rest; // legacy full-path buttons
    }
    if (!dir) {
      await ctx.answerCallbackQuery({ text: "Outdated list — reopen /project" });
      return;
    }
    setState(userKey, { activeDirectory: dir, activeSessionId: null });
    const shortDir = dir.replace(/^\/home\/[^/]+\//, "~/");
    await ctx.answerCallbackQuery({ text: `Project: ${shortDir}` });
    await ctx.editMessageText(
      `✅ Switched to *${shortDir}*\n\nUse /new to create a session in this project, or /sessions to see existing ones.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (action === "page") {
    const page = Number(parts[2]);
    const baseDir = config.opencode.defaultDir;
    const dirs = listSubdirectories(baseDir);
    const state = getState(userKey);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({
      reply_markup: projectsKeyboard(dirs, state.activeDirectory, shortenDir, page),
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown project action" });
}

// ── Action callbacks (undo, continue) ──────────────────────

async function handleAction(ctx: Context, userKey: number, parts: string[]): Promise<void> {
  const action = parts[1];
  const state = getState(userKey);

  switch (action) {
    case "undo": {
      const payload = takeToken(parts[2] ?? "");
      if (!payload) {
        await ctx.answerCallbackQuery({ text: "Expired — buttons work once, tap a fresh message" });
        break;
      }
      const { s: sessionId, m: messageId } = JSON.parse(payload) as { s: string; m: string };
      await ctx.answerCallbackQuery({ text: "Undoing..." });
      await opencode.revertMessage(sessionId, messageId);
      await ctx.editMessageText("↩️ Changes reverted.");
      break;
    }

    case "continue": {
      const payload = takeToken(parts[2] ?? "");
      if (!payload) {
        await ctx.answerCallbackQuery({ text: "Expired — buttons work once, tap a fresh message" });
        break;
      }
      const { s: sessionId } = JSON.parse(payload) as { s: string };
      if (state.isBusy) {
        await ctx.answerCallbackQuery({ text: "Already processing..." });
        break;
      }

      await ctx.answerCallbackQuery({ text: "Continuing..." });
      // Unified path: same waiter as typed prompts (heartbeat, attribution,
      // journal, late delivery) instead of the old idle-only stream.
      const { runPrompt } = await import("./message.js");
      setState(userKey, { isBusy: true });
      void runPrompt({
        api: ctx.api,
        chatId: ctx.chat!.id,
        key: userKey,
        threadId: ctx.callbackQuery?.message?.message_thread_id,
        draftId: ctx.update.update_id,
        sessionId,
        text: "continue",
        origin: "text",
      });
      break;
    }

    default:
      await ctx.answerCallbackQuery({ text: "Unknown action" });
  }
}

// ── Confirm callbacks ──────────────────────────────────────

async function handleConfirm(ctx: Context, userKey: number, parts: string[]): Promise<void> {
  const action = parts[1];

  if (action === "cancel") {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText("❌ Cancelled.");
    return;
  }

  const id = parts.slice(2).join(":");
  const state = getState(userKey);

  switch (action) {
    case "delete": {
      const topicEntry = getTopicForSession(id);
      if (topicEntry) {
        try {
          await ctx.api.deleteForumTopic(topicEntry.chatId, topicEntry.topicId);
        } catch (err) {
          logger.debug("Failed to delete forum topic on confirm:delete", { error: String(err) });
        }
        removeSessionMapping(id);
      }

      await opencode.deleteSession(id);
      if (state.activeSessionId === id) {
        setState(userKey, { activeSessionId: null });
      }
      await ctx.answerCallbackQuery({ text: "Deleted" });
      await ctx.editMessageText("🗑 Session deleted.");
      break;
    }

    default:
      await ctx.answerCallbackQuery({ text: "Confirmed" });
  }
}

// ── Permission callbacks ───────────────────────────────────

async function handlePermission(ctx: Context, _userKey: number, parts: string[]): Promise<void> {
  const action = parts[1];
  const payload = takeToken(parts[2] ?? "");
  if (!payload) {
    await ctx.answerCallbackQuery({ text: "Expired — ask the model to try again" });
    try {
      await ctx.editMessageText("⌛ This approval expired. Ask the model to try again.");
    } catch {
      // ignore
    }
    return;
  }
  const { s: sessionId, r: requestId } = JSON.parse(payload) as { s: string; r: string };

  try {
    // Verified live 2026-10-14: top-level route answers the request.
    await opencode.replyPermission(sessionId, requestId, action === "allow" ? "once" : "reject");
    const label = action === "allow" ? "✅ Permission granted." : "❌ Permission denied.";
    await ctx.answerCallbackQuery({ text: label });
    await ctx.editMessageText(label);
  } catch (err) {
    logger.error("Permission response error", { error: String(err) });
    await ctx.answerCallbackQuery({ text: "Failed to respond" });
  }
}

// ── Question callbacks (q:) ────────────────────────────────────

async function handleQuestion(ctx: Context, parts: string[]): Promise<void> {
  const action = parts[1];

  if (action === "ans") {
    await answerQuestionOption({
      api: ctx.api,
      answerCallbackQuery: ctx.answerCallbackQuery.bind(ctx),
      editMessageText: ctx.editMessageText.bind(ctx),
      requestId: parts[2]!,
      qIdx: Number(parts[3]),
      oIdx: Number(parts[4]),
    });
    return;
  }

  if (action === "no") {
    await dismissQuestion({
      api: ctx.api,
      answerCallbackQuery: ctx.answerCallbackQuery.bind(ctx),
      editMessageText: ctx.editMessageText.bind(ctx),
      requestId: parts[2]!,
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown question action" });
}

// ── Voice talk-back opt-in (voice:) ────────────────────────────

async function handleVoiceChoice(ctx: Context, parts: string[]): Promise<void> {
  const action = parts[1];
  if (action !== "talk") {
    await ctx.answerCallbackQuery({ text: "Unknown voice action" });
    return;
  }
  const entry = takeTalkBack(parts[2]!);
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "Expired — the reply already went out as text" });
    return;
  }
  armTalkBack(entry.chatId, entry.sessionId);
  await ctx.answerCallbackQuery({ text: "🔊 Will talk back when the reply lands" });
}

// ── Switcher callbacks (sw:) ───────────────────────────────

async function loadAgentList(): Promise<{ name: string; id: string }[]> {
  const cfg = await opencode.getConfig();
  const agents: { name: string; id: string }[] = [
    { name: "Build (default)", id: "build" },
    { name: "Plan (read-only)", id: "plan" },
  ];
  if (cfg.agent && typeof cfg.agent === "object") {
    for (const [id] of Object.entries(cfg.agent)) {
      if (id !== "build" && id !== "plan") {
        agents.push({ name: id, id });
      }
    }
  }
  return agents;
}

async function handleSwitcher(ctx: Context, userKey: number, parts: string[]): Promise<void> {
  const category = parts[1];

  if (category === "back") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("⚙️", {
      reply_markup: switcherKeyboard(),
    });
    return;
  }

  switch (category) {
    case "model":
      await handleSwitcherModel(ctx, userKey, parts);
      break;
    case "variant":
      await handleSwitcherVariant(ctx, userKey, parts);
      break;
    case "agent":
      await handleSwitcherAgent(ctx, userKey, parts);
      break;
    default:
      await ctx.answerCallbackQuery({ text: "Unknown switcher action" });
  }
}

async function handleSwitcherModel(ctx: Context, userKey: number, parts: string[]): Promise<void> {
  const action = parts[2];

  switch (action) {
    case "providers": {
      const page = Number(parts[3] ?? 0);
      const providersData = await opencode.getProviders();
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("🤖 Select a provider:", {
        reply_markup: switcherProvidersKeyboard(providersData.providers, page),
      });
      break;
    }

    case "provider": {
      const providerId = parts[3]!;
      const page = Number(parts[4] ?? 0);
      const providersData = await opencode.getProviders();
      const provider = providersData.providers.find((p) => p.id === providerId);
      if (!provider) {
        await ctx.answerCallbackQuery({ text: "Provider not found" });
        return;
      }
      const state = getState(userKey);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`🤖 ${provider.name} — select a model:`, {
        reply_markup: switcherModelsKeyboard(provider, state.selectedModel?.modelID, page),
      });
      break;
    }

    case "select": {
      const providerId = parts[3]!;
      const modelId = parts.slice(4).join(":");
      setState(userKey, { selectedModel: { providerID: providerId, modelID: modelId } });
      await ctx.answerCallbackQuery({ text: `Model: ${modelId}` });
      await ctx.editMessageText(`✅ Model set to \`${providerId}/${modelId}\``, {
        parse_mode: "Markdown",
        reply_markup: switcherKeyboard(),
      });
      break;
    }

    default:
      await ctx.answerCallbackQuery({ text: "Unknown model action" });
  }
}

async function handleSwitcherVariant(ctx: Context, userKey: number, parts: string[]): Promise<void> {
  const action = parts[2];

  switch (action) {
    case "list": {
      const page = Number(parts[3] ?? 0);
      const providersData = await opencode.getProviders();
      const state = getState(userKey);
      const variants = extractVariants(providersData.providers, state.selectedModel?.modelID);
      if (variants.length === 0) {
        await ctx.answerCallbackQuery({ text: "No variants available" });
        return;
      }
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("🔀 Select a variant:", {
        reply_markup: switcherVariantsKeyboard(variants, state.selectedModel?.modelID, page),
      });
      break;
    }

    case "select": {
      const providerId = parts[3]!;
      const modelId = parts.slice(4).join(":");
      setState(userKey, { selectedModel: { providerID: providerId, modelID: modelId } });
      await ctx.answerCallbackQuery({ text: `Variant: ${modelId}` });
      await ctx.editMessageText(`✅ Model set to \`${providerId}/${modelId}\``, {
        parse_mode: "Markdown",
        reply_markup: switcherKeyboard(),
      });
      break;
    }

    default:
      await ctx.answerCallbackQuery({ text: "Unknown variant action" });
  }
}

async function handleSwitcherAgent(ctx: Context, userKey: number, parts: string[]): Promise<void> {
  const action = parts[2];

  switch (action) {
    case "list": {
      const page = Number(parts[3] ?? 0);
      const agents = await loadAgentList();
      const state = getState(userKey);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("🧠 Select an agent:", {
        reply_markup: switcherAgentsKeyboard(agents, state.selectedAgent, page),
      });
      break;
    }

    case "select": {
      const agentId = parts[3]!;
      setState(userKey, { selectedAgent: agentId });
      await ctx.answerCallbackQuery({ text: `Agent: ${agentId}` });
      await ctx.editMessageText(`✅ Agent set to *${agentId}*`, {
        parse_mode: "Markdown",
        reply_markup: switcherKeyboard(),
      });
      break;
    }

    default:
      await ctx.answerCallbackQuery({ text: "Unknown agent action" });
  }
}
