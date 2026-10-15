import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "grammy";
import { config } from "../../config.js";
import { getState, setState, stateKey } from "../../services/session.js";
import { hasLiveRun, queuePush, queueLength, MAX_QUEUE } from "../../services/runs.js";
import { downloadToBuffer } from "../../services/download.js";
import { getSessionFromContext } from "../middleware/thread.js";
import { chatLog, runPrompt } from "./message.js";
import { threadOf } from "../middleware/thread.js";
import { logger } from "../../utils/logger.js";

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/** Snap a photo / send a file: saved locally, path handed to the agent. */
export async function mediaHandler(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const chatId = ctx.chat!.id;
  const userKey = stateKey(chatId, userId);

  const photo = ctx.message?.photo;
  const document = ctx.message?.document;
  if (!photo && !document) return;

  // Largest photo rendition, or the document itself.
  const fileId = photo ? photo[photo.length - 1]!.file_id : document!.file_id;
  const fileName = document?.file_name ?? `photo-${ctx.update.update_id}.jpg`;
  const caption = ctx.message?.caption?.trim() ?? "";
  const size = document?.file_size ?? 0;
  logger.info("Incoming media", { userId, chatId, fileName, size });

  if (size > MAX_MEDIA_BYTES) {
    await ctx.reply("📎 File too large (max 20 MB). Send a smaller one.", {
      message_thread_id: threadOf(ctx),
    });
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

  // NOTE: busy is set only when a run actually starts (below), so downloads
  // never block the chat and failures can't wedge the busy flag.
  const threadId = ctx.message?.message_thread_id;
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const dest = join(tmpdir(), `tg-media-${ctx.update.update_id}-${safeName}`);
  const working = await ctx.reply("📎 Saving attachment...", { message_thread_id: threadOf(ctx) });

  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram returned no file path");
    const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
    const data = await downloadToBuffer(url, MAX_MEDIA_BYTES);
    writeFileSync(dest, data);
    try {
      await ctx.api.deleteMessage(chatId, working.message_id);
    } catch {
      // harmless
    }

    const kind = photo ? "photo" : "document";
    const instruction = caption || (photo ? "Describe what you see and handle anything actionable in it." : "Read this file and handle anything actionable in it.");
    const text = `📎 User sent a ${kind} \`${safeName}\`, saved at \`${dest}\`. ${instruction}`;
    chatLog(`IN [media:${safeName}] chat=${chatId}: ${caption.slice(0, 200)}`);

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
        origin: "text",
        enqueuedAt: Date.now(),
      });
      chatLog(`QUEUED #${pos} [media] chat=${chatId} session=${sessionId}`);
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
      origin: "text",
    });
    // NOTE: tmp files are intentionally kept — the agent reads them by path.
  } catch (err) {
    try {
      unlinkSync(dest);
    } catch {
      // already gone
    }
    // NOTE: busy untouched here — this path never sets it, so a failure
    // can't clear another run's flag.
    logger.error("Media handling error", { error: String(err), sessionId });
    try {
      await ctx.api.editMessageText(chatId, working.message_id, "❌ Attachment failed. Please try again.");
    } catch {
      await ctx
        .reply("❌ Attachment failed. Please try again.", { message_thread_id: threadOf(ctx) })
        .catch(() => {});
    }
  }
}
