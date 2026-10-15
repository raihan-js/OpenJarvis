import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { Context } from "grammy";
import { opencode } from "../../opencode/client.js";
import { getState, setState, stateKey } from "../../services/session.js";
import { config } from "../../config.js";
import { projectsKeyboard } from "../keyboards/projects.js";
import { threadOf, getSessionFromContext } from "../middleware/thread.js";

function resolveDir(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  if (trimmed.startsWith("/")) return resolve(trimmed);
  // Bare names resolve inside the projects root (OPENCODE_DEFAULT_DIR),
  // so `/project kaggle` picks (or creates) ~/Desktop/APPS/kaggle.
  return resolve(config.opencode.defaultDir, trimmed);
}

export function shortenDir(dir: string): string {
  return dir.replace(new RegExp(`^${homedir()}/`), "~/");
}

export function listSubdirectories(baseDir: string): string[] {
  try {
    const entries = readdirSync(baseDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => join(baseDir, e.name))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch {
    return [];
  }
}

export async function projectCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const userKey = stateKey(ctx.chat?.id, userId);

  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/project\s*/, "").trim();

  if (arg) {
    const dir = resolveDir(arg);

    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        await ctx.reply(`❌ Cannot create directory: \`${dir}\`\n${String(err)}`);
        return;
      }
    }

    setState(userKey, { activeDirectory: dir, activeSessionId: null });
    const shortDir = shortenDir(dir);
    await ctx.reply(
      `✅ Switched to *${shortDir}*\n\nUse /new to create a session in this project, or /sessions to see existing ones.`,
      { parse_mode: "Markdown", message_thread_id: threadOf(ctx) }
    );
    return;
  }

  const baseDir = config.opencode.defaultDir;
  const dirs = listSubdirectories(baseDir);
  const state = getState(userKey);

  if (dirs.length === 0) {
    await ctx.reply("No directories found. Use `/project ~/path` to set a directory manually.", {
      parse_mode: "Markdown",
      message_thread_id: threadOf(ctx),
    });
    return;
  }

  const kb = projectsKeyboard(dirs, state.activeDirectory, shortenDir, 0);

  const shortBase = shortenDir(baseDir);
  await ctx.reply(`📁 *Directories in* \`${shortBase}\`\n\nOr use \`/project ~/path\` to set a custom directory.`, {
    parse_mode: "Markdown",
    message_thread_id: threadOf(ctx),
    reply_markup: kb,
  });
}

export async function abortCommand(ctx: Context): Promise<void> {
  const userKey = stateKey(ctx.chat?.id, ctx.from!.id);
  const st = getState(userKey);
  // Inside a topic, abort THAT session — never the controller's.
  const sessionId = getSessionFromContext(ctx) ?? st.activeSessionId;
  if (!sessionId) {
    await ctx.reply("No active session.", { message_thread_id: threadOf(ctx) });
    return;
  }

  const result = await opencode.abortSession(sessionId);
  // Local teardown too: release the waiter so Thinking... resolves instead
  // of hanging, drop queued prompts, and let the next prompt start clean.
  // runPrompt's wait loop observes the cleared live flag and stops itself.
  const { cancelStream } = await import("../../services/streaming.js");
  const { markRunDone, queueClear } = await import("../../services/runs.js");
  cancelStream(sessionId);
  markRunDone(sessionId);
  queueClear(sessionId);
  await ctx.reply(result ? "⏹ Generation aborted." : "Nothing to abort.", {
    message_thread_id: threadOf(ctx),
  });
}

export async function shareCommand(ctx: Context): Promise<void> {
  const state = getState(stateKey(ctx.chat?.id, ctx.from!.id));
  if (!state.activeSessionId) {
    await ctx.reply("No active session.", { message_thread_id: threadOf(ctx) });
    return;
  }

  try {
    const shareData = await opencode.shareSession(state.activeSessionId);
    await ctx.reply(`🔗 Share link: ${shareData.url}`, { message_thread_id: threadOf(ctx) });
  } catch {
    await ctx.reply("Failed to create share link.", { message_thread_id: threadOf(ctx) });
  }
}

export async function forkCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const userKey = stateKey(ctx.chat?.id, userId);
  const state = getState(userKey);
  if (!state.activeSessionId) {
    await ctx.reply("No active session.", { message_thread_id: threadOf(ctx) });
    return;
  }

  const forked = await opencode.forkSession(state.activeSessionId);
  setState(userKey, { activeSessionId: forked.id });
  await ctx.reply(`🔀 Session forked: *${forked.title || forked.slug}*`, {
    parse_mode: "Markdown",
    message_thread_id: threadOf(ctx),
  });
}

/** Tell the model to keep going (same unified waiter as typed prompts). */
export async function continueCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const chatId = ctx.chat!.id;
  const userKey = stateKey(chatId, userId);
  const { getSessionFromContext } = await import("../middleware/thread.js");
  const { hasLiveRun, queuePush, queueLength, MAX_QUEUE } = await import("../../services/runs.js");
  const state = getState(userKey);
  const sessionId = getSessionFromContext(ctx) ?? state.activeSessionId;
  if (!sessionId) {
    await ctx.reply("No active session.", { message_thread_id: threadOf(ctx) });
    return;
  }
  if (state.isBusy || hasLiveRun(sessionId)) {
    if (queueLength(sessionId) >= MAX_QUEUE) {
      await ctx.reply(`⏳ Queue is full (${MAX_QUEUE}).`, { message_thread_id: threadOf(ctx) });
      return;
    }
    const pos = queuePush(sessionId, {
      key: userKey,
      chatId,
      threadId: ctx.message?.message_thread_id,
      text: "continue",
      origin: "text",
      enqueuedAt: Date.now(),
    });
    await ctx.reply(`⏳ Busy — queued #${pos}.`, { message_thread_id: threadOf(ctx) });
    return;
  }
  setState(userKey, { isBusy: true });
  const { runPrompt } = await import("../handlers/message.js");
  void runPrompt({
    api: ctx.api,
    chatId,
    key: userKey,
    threadId: ctx.message?.message_thread_id,
    draftId: ctx.update.update_id,
    sessionId,
    text: "continue",
    origin: "text",
  });
}

/** Revert the last delivered assistant reply's file changes. */
export async function undoCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const userKey = stateKey(ctx.chat?.id, userId);
  const { getSessionFromContext } = await import("../middleware/thread.js");
  const state = getState(userKey);
  const sessionId = getSessionFromContext(ctx) ?? state.activeSessionId;
  if (!sessionId || !state.opLastMessageId) {
    await ctx.reply("Nothing to undo yet.", { message_thread_id: threadOf(ctx) });
    return;
  }
  try {
    await opencode.revertMessage(sessionId, state.opLastMessageId);
    setState(userKey, { opLastMessageId: null });
    await ctx.reply("↩️ Changes reverted.", { message_thread_id: threadOf(ctx) });
  } catch {
    await ctx.reply("❌ Undo failed.", { message_thread_id: threadOf(ctx) });
  }
}

export async function compactCommand(ctx: Context): Promise<void> {
  const state = getState(stateKey(ctx.chat?.id, ctx.from!.id));
  if (!state.activeSessionId) {
    await ctx.reply("No active session.", { message_thread_id: threadOf(ctx) });
    return;
  }

  await ctx.reply("📦 Compacting session...", { message_thread_id: threadOf(ctx) });
  await opencode.summarizeSession(state.activeSessionId);
  await ctx.reply("✅ Session compacted. Token usage reduced.", { message_thread_id: threadOf(ctx) });
}

export async function statsCommand(ctx: Context): Promise<void> {
  const state = getState(stateKey(ctx.chat?.id, ctx.from!.id));
  if (!state.activeSessionId) {
    await ctx.reply("No active session. Use /new or /sessions first.", {
      message_thread_id: threadOf(ctx),
    });
    return;
  }

  const messages = await opencode.getMessages(state.activeSessionId);
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let messageCount = 0;

  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      messageCount++;
      if (msg.info.tokens) {
        totalInput += msg.info.tokens.input;
        totalOutput += msg.info.tokens.output;
      }
      if (msg.info.cost) {
        totalCost += msg.info.cost;
      }
    }
  }

  const lines = [
    "📊 *Session Stats*",
    `Messages: ${messageCount}`,
    `Input tokens: ${totalInput.toLocaleString()}`,
    `Output tokens: ${totalOutput.toLocaleString()}`,
    `Total cost: $${totalCost.toFixed(4)}`,
  ];

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", message_thread_id: threadOf(ctx) });
}
