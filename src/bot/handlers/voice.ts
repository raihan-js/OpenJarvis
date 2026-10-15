import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { InlineKeyboard, type Context } from "grammy";
import { config } from "../../config.js";
import { getState, setState, stateKey } from "../../services/session.js";
import { hasLiveRun, queuePush, queueLength, MAX_QUEUE } from "../../services/runs.js";
import { downloadToBuffer } from "../../services/download.js";
import { getSessionFromContext } from "../middleware/thread.js";
import { chatLog, runPrompt } from "./message.js";
import { threadOf } from "../middleware/thread.js";
import { logger } from "../../utils/logger.js";

const execFileAsync = promisify(execFile);

// URL resolution (not fs path math): works in dev (src/) and prod (dist/)
// because tsc mirrors src/ and build copies transcribe.py next to it.
const TRANSCRIBE_SCRIPT = fileURLToPath(new URL("../../transcribe.py", import.meta.url));

/** Pending talk-back texts: token -> {chat, thread, session, text}. Memory-only, short-lived. */
const pendingTalkBack = new Map<string, { chatId: number; threadId?: number; sessionId: string; text: string; at: number }>();

export function takeTalkBack(token: string): { chatId: number; threadId?: number; sessionId: string; text: string } | undefined {
  const entry = pendingTalkBack.get(token);
  if (entry) pendingTalkBack.delete(token);
  // Opportunistic prune.
  const now = Date.now();
  for (const [k, v] of pendingTalkBack) {
    if (now - v.at > 15 * 60 * 1000) pendingTalkBack.delete(k);
  }
  return entry;
}

export async function voiceHandler(ctx: Context): Promise<void> {
  const voice = ctx.message?.voice;
  if (!voice) return;

  const userId = ctx.from!.id;
  const chatId = ctx.chat!.id;
  const userKey = stateKey(chatId, userId);
  const threadId = ctx.message?.message_thread_id;
  logger.info("Incoming voice message", {
    userId,
    chatId,
    duration: voice.duration,
  });

  if (voice.duration > config.voice.maxDurationSec) {
    await ctx.reply(
      `🎙️ Voice note too long (${voice.duration}s, max ${config.voice.maxDurationSec}s). Send a shorter one.`,
      { message_thread_id: threadOf(ctx) },
    );
    return;
  }

  const state = getState(userKey);
  const topicSessionId = getSessionFromContext(ctx);
  const sessionId = topicSessionId ?? state.activeSessionId;
  if (!sessionId) {
    await ctx.reply("No active session. Use /new to create one or /sessions to resume an existing one.", {
      message_thread_id: threadOf(ctx),
    });
    return;
  }
  if (topicSessionId && topicSessionId !== state.activeSessionId) {
    setState(userKey, { activeSessionId: topicSessionId });
  }

  const longNote = voice.duration > 120;
  const working = await ctx.reply(
    longNote ? "🎙️ Transcribing a long note — this can take a couple of minutes..." : "🎙️ Transcribing voice note...",
    { message_thread_id: threadOf(ctx) },
  );
  const tmp = join(tmpdir(), `tg-voice-${ctx.update.update_id}.oga`);

  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram returned no file path for the voice note");
    const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
    const audio = await downloadToBuffer(url);
    writeFileSync(tmp, audio);

    const { stdout } = await execFileAsync(
      config.voice.python,
      [TRANSCRIBE_SCRIPT, tmp, config.voice.model],
      { timeout: 600_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const text = stdout.trim();
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    try {
      await ctx.api.deleteMessage(chatId, working.message_id);
    } catch {
      // keep going; the status message is harmless
    }

    if (!text) {
      await ctx.reply("🎙️ I couldn't hear anything in that voice note. Please try again.", {
        message_thread_id: threadOf(ctx),
      });
      return;
    }

    chatLog(`IN [voice:${voice.duration}s] chat=${chatId}: ${text.slice(0, 200)}`);
    // Opt-in talk-back: the Heard message carries the button; nothing spoken unless tapped.
    const talkToken = randomUUID().slice(0, 8);
    pendingTalkBack.set(talkToken, { chatId, threadId, sessionId, text, at: Date.now() });
    const heardKb = new InlineKeyboard().text("🔊 Talk back", `voice:talk:${talkToken}`);
    await ctx
      .reply(`🎙️ Heard: "*${text.slice(0, 300)}*"`, {
        parse_mode: "Markdown",
        message_thread_id: threadOf(ctx),
        reply_markup: heardKb,
      })
      .catch(() => {});

    // Seamless queue: busy sessions take the transcript in turn, no resend needed.
    const st = getState(userKey);
    if (st.isBusy || hasLiveRun(sessionId)) {
      if (queueLength(sessionId) >= MAX_QUEUE) {
        await ctx.reply(`⏳ Queue is full (${MAX_QUEUE}). Use /abort to clear stuck work, then resend.`, {
          message_thread_id: threadOf(ctx),
        });
        return;
      }
      const pos = queuePush(sessionId, {
        key: userKey,
        chatId,
        threadId,
        text,
        origin: "voice",
        enqueuedAt: Date.now(),
      });
      chatLog(`QUEUED #${pos} [voice] chat=${chatId} session=${sessionId}`);
      await ctx.reply(`⏳ Busy — queued #${pos}. Sends automatically when free, no need to resend.`, {
        message_thread_id: threadOf(ctx),
      });
      return;
    }

    setState(userKey, { isBusy: true });
    // Fire-and-forget: runPrompt resolves only on delivery and manages its
    // own busy flag; awaiting here would block the update handler for minutes.
    void runPrompt({
      api: ctx.api,
      chatId,
      key: userKey,
      threadId,
      draftId: ctx.update.update_id,
      sessionId,
      text,
      origin: "voice",
    });
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    logger.error("Voice handling error", { error: String(err), sessionId });
    try {
      await ctx.api.editMessageText(chatId, working.message_id, "❌ Voice note failed. Please try again or type your message.");
    } catch {
      await ctx
        .reply("❌ Voice note failed. Please try again or type your message.", {
          message_thread_id: threadOf(ctx),
        })
        .catch(() => {});
    }
  }
}
