import type { Context } from "grammy";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config.js";
import { opencode } from "../../opencode/client.js";
import { getState, setState, stateKey } from "../../services/session.js";
import { journalAdd, markRunLive, markRunDone, hasLiveRun, queuePush, queueShift, queueLength, queuedSessions, MAX_QUEUE } from "../../services/runs.js";
import { getLastPartAt } from "../../services/streaming.js";

/** Sessions currently draining their queue (re-entrancy guard). */
const draining = new Set<string>();

/**
 * Run queued prompts for a session, one at a time, in order.
 * Called when a run finishes and on boot resume.
 */
export async function drainQueue(api: Api, sessionId: string): Promise<void> {
  if (draining.has(sessionId)) return;
  draining.add(sessionId);
  try {
    for (;;) {
      // A fresh direct prompt took over: let its chain own the drain.
      if (hasLiveRun(sessionId)) return;
      const item = queueShift(sessionId);
      if (!item) return;
      setState(item.key, { isBusy: true });
      chatLog(`DEQUEUED chat=${item.chatId} session=${sessionId}: ${item.text.slice(0, 120)}`);
      try {
        await runPrompt({
          api,
          chatId: item.chatId,
          key: item.key,
          threadId: item.threadId,
          draftId: Date.now(),
          sessionId,
          text: item.text,
          origin: item.origin,
        });
      } catch (err) {
        logger.error("Queued prompt crashed", { error: String(err), sessionId });
      }
      // runPrompt's finally clears busy + chains; loop continues to next item.
    }
  } finally {
    draining.delete(sessionId);
  }
}

/** Drain every session with a waiting queue (boot resume). */
export async function drainAllQueues(api: Api): Promise<void> {
  for (const sessionId of queuedSessions()) {
    void drainQueue(api, sessionId);
  }
}
import { getSessionFromContext, threadOf } from "../middleware/thread.js";
import { startStream, sendFinalMessage, cancelStream, findReply, waitForFinalReply } from "../../services/streaming.js";
import { shortenDir } from "../commands/actions.js";
import { synthesizeVoice, takeTalkBackArm } from "../../services/speak.js";
import { logger } from "../../utils/logger.js";
import { InputFile, type Api } from "grammy";

/** PC-visible tail log: tail -f .data/chats.log in a terminal to watch phone activity. */
export function chatLog(line: string): void {
  try {
    const dir = config.auth.dataDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().slice(11, 19);
    appendFileSync(join(dir, "chats.log"), `[${ts}] ${line}\n`, "utf-8");
  } catch {
    // logging must never break message handling
  }
}

export async function messageHandler(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  const userId = ctx.from!.id;
  const chatId = ctx.chat!.id;
  logger.info("Incoming text message", { userId, chatId, len: text.length });
  const userKey = stateKey(chatId, userId);
  let state = getState(userKey);
  chatLog(`IN chat=${chatId} session pending: ${text.slice(0, 200)}`);

  const topicSessionId = getSessionFromContext(ctx);
  const sessionId = topicSessionId ?? state.activeSessionId;

  if (!sessionId) {
    await ctx.reply(
      "No active session. Use /new to create one or /sessions to resume an existing one.",
      { message_thread_id: threadOf(ctx) },
    );
    return;
  }

  if (topicSessionId && topicSessionId !== state.activeSessionId) {
    setState(userKey, { activeSessionId: topicSessionId });
  }

  if (state.isBusy || (sessionId && hasLiveRun(sessionId))) {
    // Self-heal: a busy flag with no live run and an empty queue is debris
    // from a killed process — clear it instead of blocking the chat forever.
    if (sessionId && !hasLiveRun(sessionId) && queueLength(sessionId) === 0) {
      logger.warn("Clearing stale busy flag", { sessionId });
      setState(userKey, { isBusy: false });
      state = getState(userKey);
    } else if (sessionId) {
      // Seamless queue: no abort/resend needed, runs automatically when free.
      if (queueLength(sessionId) >= MAX_QUEUE) {
        await ctx.reply(`⏳ Queue is full (${MAX_QUEUE}). Use /abort to clear stuck work, then resend.`, {
          message_thread_id: threadOf(ctx),
        });
        return;
      }
      const pos = queuePush(sessionId, {
        key: userKey,
        chatId,
        threadId: ctx.message?.message_thread_id,
        text,
        origin: "text",
        enqueuedAt: Date.now(),
      });
      chatLog(`QUEUED #${pos} chat=${chatId} session=${sessionId}: ${text.slice(0, 120)}`);
      await ctx.reply(`⏳ Busy — queued #${pos}. Sends automatically when free, no need to resend.`, {
        message_thread_id: threadOf(ctx),
      });
      return;
    } else {
      await ctx.reply("\u23F3 Still processing the previous message. Use /abort to cancel it.", {
        message_thread_id: threadOf(ctx),
      });
      return;
    }
  }

  setState(userKey, { isBusy: true });
  const threadId = ctx.message?.message_thread_id;
  const draftId = ctx.update.update_id;
  const api = ctx.api;

  // Fire-and-forget per chat: runPrompt marks the session live synchronously
  // on invocation, so a double-tap can never launch a second run.
  runPrompt({
    api,
    chatId,
    key: userKey,
    threadId,
    draftId,
    sessionId,
    text,
    origin: "text",
  }).catch((err) => {
    logger.error("Background message handler crashed", { error: String(err), sessionId });
    markRunDone(sessionId);
    setState(userKey, { isBusy: false });
  });
}

export interface PromptJob {
  api: Api;
  chatId: number;
  /** Per-chat state key (chat id; equals user id in private chats). */
  key: number;
  threadId?: number;
  draftId: number;
  sessionId: string;
  text: string;
  /** "text" or "voice" — used for logging only. */
  origin: "text" | "voice";
}

/**
 * Run one prompt end-to-end and RESOLVE ONLY WHEN DELIVERED (or aborted /
 * failed). Never resolves on stream-idle alone: idle events also fire for
 * other generations on a shared session, which was the source of the
 * "no reply matched" loop. Late answers are watched, not abandoned.
 *
 * Invocation marks the session live SYNCHRONOUSLY (before the first await),
 * so concurrent callers always see the flag. Awaitable: the queue drains
 * items strictly one at a time by awaiting this.
 */
export async function runPrompt(job: PromptJob): Promise<void> {
  const { api, chatId, key, threadId, draftId, sessionId, text, origin } = job;
  markRunLive(sessionId);
  const promptTs = Date.now();
  const st = getState(key);

  let thinkingMsgId: number | null = null;
  let userMsgId: string | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let wedgedNoted = false;

  const stopHeartbeat = (): void => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const finish = (clearBusy = true): void => {
    stopHeartbeat();
    cancelStream(sessionId);
    markRunDone(sessionId);
    if (clearBusy) setState(key, { isBusy: false });
    // Chain: run whatever queued up while we were busy.
    void drainQueue(api, sessionId);
  };

  try {
    // 1. Thinking… first (instant feedback), journaled immediately so even a
    // crash seconds later resumes delivery on boot.
    try {
      const m = await api.sendMessage(chatId, "\u23F3 Thinking...", {
        message_thread_id: threadId,
      });
      thinkingMsgId = m.message_id;
    } catch (err) {
      logger.warn("Thinking message failed, continuing anyway", { error: String(err) });
    }
    journalAdd({ sessionId, chatId, threadId, thinkingMsgId, promptTs, userMsgId, startedAt: promptTs });

    // 2. Live stream edits (best-effort only — delivery does NOT depend on it).
    void startStream(api, chatId, sessionId, draftId, threadId, thinkingMsgId).catch((err) => {
      logger.debug("Stream ended with error", { error: String(err), sessionId });
    });

    // 3. Post the prompt.
    const existing = await opencode.getMessages(sessionId);
    const beforeIds = new Set(existing.map((m) => m.info.id));
    // Fresh sessions inherit the global default model (anthropic here),
    // which stalls with no API key — pin them to the working default.
    // Sessions with history keep their own model.
    const hasAssistant = existing.some((m) => m.info.role === "assistant");
    const model = st.selectedModel ?? (hasAssistant ? undefined : config.defaults.model);
    await opencode.sendMessageAsync(sessionId, text, {
      model,
      agent: st.selectedAgent ?? undefined,
    });

    // 4. Identify OUR user message (extended window: a busy server can take
    // seconds to persist it). Missing id only widens attribution, never blocks.
    for (let i = 0; i < 20 && !userMsgId; i++) {
      const messages = await opencode.getMessages(sessionId).catch((): null => null);
      if (messages) {
        userMsgId =
          messages.find(
            (m) => m.info.role === "user" && m.info.time.created >= promptTs && !beforeIds.has(m.info.id),
          )?.info.id ?? null;
      }
      if (!userMsgId) await new Promise((r) => setTimeout(r, 500));
    }
    if (!userMsgId) logger.warn("User message not located, using time-based attribution", { sessionId });
    else journalAdd({ sessionId, chatId, threadId, thinkingMsgId, promptTs, userMsgId, startedAt: promptTs });

    // 5. Liveness heartbeat: while waiting, refresh Thinking… with elapsed
    // time so a long run reads as alive, never as stuck.
    heartbeat = setInterval(() => {
      if (!thinkingMsgId) return;
      const mins = Math.floor((Date.now() - promptTs) / 60000);
      const q = queueLength(sessionId);
      const label =
        mins < 1
          ? "\u23F3 Working\u2026"
          : `\u23F3 Working\u2026 ${mins}m elapsed${q > 0 ? ` \u2022 ${q} queued` : ""}`;
      // Note: editMessageText takes no thread param — edits apply to the
      // message in place wherever it lives.
      api.editMessageText(chatId, thinkingMsgId, label).catch(() => {
        // Message deleted or chat gone — stop beating a dead chat.
        stopHeartbeat();
      });
    }, 90_000);
    heartbeat.unref?.();

    // 6. Wait for OUR FINAL reply: completed AND settled. Intermediate
    // progress messages never resolve this while tools are still running —
    // that was the "says understood, then silence" bug. The loop ends on
    // delivery, abort, session deletion, error, or the hard ceiling (after
    // which a detached watcher keeps the promise, journaled).
    const HARD_CEILING_MS = 45 * 60 * 1000;
    const deadline = promptTs + HARD_CEILING_MS;
    for (;;) {
      // Aborted elsewhere (/abort clears the live flag): stop cleanly.
      if (!hasLiveRun(sessionId)) {
        logger.info("Run aborted externally, stopping waiter", { sessionId });
        try {
          if (thinkingMsgId) await api.editMessageText(chatId, thinkingMsgId, "⏹ Aborted.");
        } catch {
          // ignore
        }
        return;
      }
      const sliceMs = Math.min(60_000, Math.max(0, deadline - Date.now()));
      if (sliceMs <= 0) break;
      const reply = await waitForFinalReply(sessionId, promptTs, userMsgId, { timeoutMs: sliceMs });
      if (reply) {
        await deliverReply(
          api,
          { chatId, key, threadId, sessionId, text, origin, promptTs, dir: shortenDir(st.activeDirectory) },
          reply,
          thinkingMsgId,
        );
        return;
      }
      // No final reply yet: session gone, or still working. Distinguish.
      const gone = await opencode.getMessages(sessionId).then(() => false).catch(() => true);
      if (gone) {
        // Session vanished mid-wait (deleted from another chat): stop cleanly.
        logger.warn("Session gone mid-wait, stopping", { sessionId });
        try {
          if (thinkingMsgId) await api.editMessageText(chatId, thinkingMsgId, "🗑 This session was deleted elsewhere. Pick another with /sessions.");
        } catch {
          // ignore
        }
        return;
      }
      {
        // Honest stall signal: no output for 10+ minutes while we keep waiting.
        // Name the stuck tool so waiting is informed, not blind.
        const lastPart = getLastPartAt(sessionId) ?? promptTs;
        if (!wedgedNoted && Date.now() - lastPart > 10 * 60 * 1000) {
          wedgedNoted = true;
          logger.warn("Run producing no output for 10m, still watching", { sessionId });
          let stuck = "";
          try {
            const all = await opencode.getMessages(sessionId).catch((): null => null);
            if (all) {
              outer: for (let i = all.length - 1; i >= 0; i--) {
                for (const p of all[i]!.parts) {
                  if (p.type === "tool" && p.state?.status === "running" && p.tool) {
                    const input = p.state.input;
                    const inputStr = typeof input === "string" ? input : JSON.stringify(input ?? {});
                    stuck = ` (stuck in \`${p.tool} ${inputStr.slice(0, 80)}\`)`;
                    break outer;
                  }
                }
              }
            }
          } catch {
            // stuck detail is best-effort
          }
          chatLog(`STALL? session=${sessionId} no output 10m${stuck}, still watching`);
          try {
            await api.sendMessage(
              chatId,
              `🐌 Still working — no output for 10 minutes${stuck}. Leaving it running; use /abort to stop it.`,
              { message_thread_id: threadId },
            );
          } catch {
            // ignore
          }
        }
      }
      if (Date.now() > deadline) {
        // Hard ceiling: detach a light watcher that delivers late instead of
        // failing. The journal entry stays, so a restart also resumes it.
        logger.warn("Run hit hard ceiling, detaching late watcher", { sessionId });
        chatLog(`LATE-WATCH session=${sessionId}`);
        try {
          await api.sendMessage(
            chatId,
            "🐌 Still working after 45 minutes — I'll deliver the answer here when it lands. No need to resend.",
            { message_thread_id: threadId },
          );
        } catch {
          // ignore
        }
        void watchLate(api, { sessionId, chatId, threadId, thinkingMsgId, promptTs, userMsgId, startedAt: promptTs });
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch (err) {
    cancelStream(sessionId);
    logger.error("Message send error", { error: String(err), sessionId });
    try {
      if (thinkingMsgId) {
        await api.editMessageText(chatId, thinkingMsgId, `\u274C Error: ${err instanceof Error ? err.message : "Unknown error"}`);
      } else {
        await api.sendMessage(chatId, `\u274C Error: ${err instanceof Error ? err.message : "Unknown error"}`, {
          message_thread_id: threadId,
        });
      }
    } catch {
      // ignore
    }
  } finally {
    finish();
  }
}

/** Detached late watcher: waits for the FINAL reply (settled, not just any
 * progress message) up to 2h and delivers when it lands. */
async function watchLate(
  api: Api,
  entry: { sessionId: string; chatId: number; threadId?: number; thinkingMsgId: number | null; promptTs: number; userMsgId: string | null; startedAt: number },
): Promise<void> {
  markRunLive(entry.sessionId);
  try {
    const reply = await waitForFinalReply(entry.sessionId, entry.promptTs, entry.userMsgId, {
      timeoutMs: 2 * 60 * 60 * 1000,
    });
    if (!reply) return;
    const dir = await opencode
      .getSession(entry.sessionId)
      .then((s) => shortenDir(s.directory))
      .catch(() => entry.sessionId.slice(0, 12));
    await deliverReply(
      api,
      { chatId: entry.chatId, key: entry.chatId, threadId: entry.threadId, sessionId: entry.sessionId, text: "", origin: "text", promptTs: entry.promptTs, dir },
      reply,
      entry.thinkingMsgId,
    );
  } finally {
    markRunDone(entry.sessionId);
  }
}

async function deliverReply(
  api: Api,
  job: { chatId: number; key: number; threadId?: number; sessionId: string; text: string; origin: "text" | "voice"; promptTs: number; dir: string },
  lastAssistant: NonNullable<ReturnType<typeof findReply>>,
  thinkingMsgId: number | null,
): Promise<void> {
  const { chatId, key: userId, threadId, sessionId, origin, promptTs, dir } = job;
  const msgId = await sendFinalMessage(api, chatId, lastAssistant, threadId, thinkingMsgId);
  if (!msgId) {
    logger.error("Reply found but Telegram send failed", { sessionId });
    return;
  }
  setState(userId, { lastMessageId: msgId, opLastMessageId: lastAssistant.info.id });
  logger.info("Reply delivered", { sessionId, msgId });
  const preview = lastAssistant.parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text as string)
    .join(" ")
    .slice(0, 200)
    .replace(/\n/g, " ");
  chatLog(`OUT [${origin}] chat=${chatId} session=${sessionId}: ${preview}`);
  // Opt-in talk-back: only when armed via the Talk-back button.
  if (origin === "voice" && preview && takeTalkBackArm(chatId, sessionId)) {
    const spoken = await synthesizeVoice(preview);
    if (spoken) {
      try {
        await api.sendVoice(chatId, new InputFile(spoken, "reply.ogg"), {
          message_thread_id: threadId,
        });
      } catch (err) {
        logger.warn("Voice reply send failed", { error: String(err) });
      }
    }
  }
  try {
    // Completion receipt with a real summary line so the iOS
    // notification preview says what finished — never emoji-only.
    const secs = Math.max(1, Math.round((Date.now() - promptTs) / 1000));
    let title = sessionId.slice(0, 12);
    try {
      const session = await opencode.getSession(sessionId);
      title = session.title || session.slug || title;
    } catch {
      // title stays a short id prefix
    }
    // No follow-up button spam: Undo/Continue live behind /undo and
    // /continue for when they're actually wanted.
    await api.sendMessage(chatId, `✅ ${title} — done in ${secs}s\n📁 ${dir}`, {
      message_thread_id: threadId,
    }).catch((err) => {
      logger.warn("Completion receipt failed", { error: String(err), sessionId });
      return null;
    });
  } catch {
    // receipt is best-effort
  }
}
