import type { Api } from "grammy";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { splitMessage } from "../utils/telegram.js";
import { formatAssistantMessage } from "./formatter.js";
import { events } from "../opencode/events.js";
import type { OcEvent, OcMessage, OcMessagePart } from "../opencode/types.js";
interface ActiveStream {
  chatId: number;
  threadId?: number;
  thinkingMsgId: number | null;
  sessionId: string;
  parts: Map<string, OcMessagePart>;
  messageInfo: OcMessage["info"] | null;
  lastSendTime: number;
  lastText: string;
  pendingUpdate: ReturnType<typeof setTimeout> | null;
  finalized: boolean;
  resolve: (thinkingMsgId: number | null) => void;
}

const activeStreams = new Map<string, ActiveStream>();

/** Last SSE part-activity per session — distinguishes slow from wedged. */
const lastPartAt = new Map<string, number>();

export function getLastPartAt(sessionId: string): number | undefined {
  return lastPartAt.get(sessionId);
}

/**
 * Server-reported busy/idle per session. Idle alone never triggers delivery
 * (it also fires for other generations on shared sessions), but combined
 * with a completed attributed reply it marks the run truly finished —
 * including multi-step runs whose intermediate progress messages complete
 * while tools keep running.
 */
const sessionBusy = new Map<string, { busy: boolean; at: number }>();
let statusTracking = false;

export function ensureStatusTracking(): void {
  if (statusTracking) return;
  statusTracking = true;
  const mark = (sessionId: string | undefined, busy: boolean): void => {
    if (!sessionId) return;
    sessionBusy.set(sessionId, { busy, at: Date.now() });
  };
  events.on("session.status", (event: OcEvent) => {
    const sid = event.properties?.["sessionID"] as string | undefined;
    const st = (event.properties?.["status"] as { type: string } | undefined)?.type;
    if (!sid || !st) return;
    mark(sid, !(st === "idle" || st === "completed"));
  });
  events.on("session.idle", (event: OcEvent) => {
    mark(event.properties?.["sessionID"] as string | undefined, false);
  });
  // Any part activity means work in flight (covers missed busy events).
  events.on("message.part.updated", (event: OcEvent) => {
    const part = event.properties?.["part"] as OcMessagePart | undefined;
    if (part?.sessionID) mark(part.sessionID, true);
  });
}

/**
 * Settled = safe to treat the latest completed reply as final. True when the
 * server reported idle, or when nothing moved for quietMs (missed idle), or
 * when no signal was ever seen (quiet session / SSE gap — the reply itself
 * is the evidence). Never true while part activity is fresh.
 */
export function isSessionSettled(sessionId: string, quietMs = 45_000): boolean {
  const rec = sessionBusy.get(sessionId);
  const last = getLastPartAt(sessionId);
  const quiet = last === undefined || Date.now() - last > quietMs;
  if (!rec) return quiet;
  if (!rec.busy) return true;
  if (quiet) return true;
  // Ancient busy mark with no part data at all: stale, don't hang forever.
  if (Date.now() - rec.at > 10 * 60 * 1000 && last === undefined) return true;
  return false;
}

export interface FinalWait {
  timeoutMs?: number;
  isCancelled?: () => boolean;
  quietMs?: number;
}

/**
 * Wait until a completed attributed reply exists AND the session settled.
 * Returns null on timeout/cancel. Unlike the old idle-race, intermediate
 * progress messages never resolve this while tools are still running.
 */
export async function waitForFinalReply(
  sessionId: string,
  promptTs: number,
  userMsgId: string | null,
  opts: FinalWait = {},
): Promise<OcMessage | null> {
  ensureStatusTracking();
  const { opencode } = await import("../opencode/client.js");
  const timeout = opts.timeoutMs ?? 12 * 60 * 1000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (opts.isCancelled?.()) return null;
    try {
      const messages = await opencode.getMessages(sessionId);
      const reply = findReply(messages, userMsgId, promptTs);
      if (reply && isSessionSettled(sessionId, opts.quietMs)) return reply;
    } catch {
      // transient read failure: keep waiting
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

function touchPart(sessionId: string): void {
  lastPartAt.set(sessionId, Date.now());
}

function streamKey(sessionId: string): string {
  return sessionId;
}

function buildCurrentText(stream: ActiveStream): string {
  if (!stream.messageInfo) return "\u23F3 Thinking...";

  const message: OcMessage = {
    info: stream.messageInfo,
    parts: [...stream.parts.values()],
  };

  const text = formatAssistantMessage(message);
  return text || "\u23F3 Thinking...";
}

async function sendStreamUpdate(api: Api, stream: ActiveStream): Promise<void> {
  if (stream.finalized || !stream.thinkingMsgId) return;

  const text = buildCurrentText(stream);
  const truncated = text.slice(0, 4096);

  if (truncated === stream.lastText) return;

  try {
    await api.editMessageText(stream.chatId, stream.thinkingMsgId, truncated, {
      parse_mode: "HTML",
    });
    stream.lastText = truncated;
    stream.lastSendTime = Date.now();
  } catch (err) {
    logger.debug("Stream edit failed", { error: String(err) });
  }
}

function scheduleUpdate(api: Api, stream: ActiveStream): void {
  if (stream.finalized) return;

  const elapsed = Date.now() - stream.lastSendTime;
  const delay = Math.max(0, config.stream.throttleMs - elapsed);

  if (stream.pendingUpdate) {
    clearTimeout(stream.pendingUpdate);
  }

  stream.pendingUpdate = setTimeout(() => {
    stream.pendingUpdate = null;
    sendStreamUpdate(api, stream).catch(() => {});
  }, delay);
}

export async function startStream(
  api: Api,
  chatId: number,
  sessionId: string,
  _draftId: number,
  threadId?: number,
  existingThinkingId?: number | null,
): Promise<number | null> {
  // The caller may already own a Thinking message (posted before the stream
  // so it can be journaled for crash-resume). Reuse it; post only if absent.
  let thinkingMsgId: number | null = existingThinkingId ?? null;
  if (thinkingMsgId === null) {
    try {
      const msg = await api.sendMessage(chatId, "\u23F3 Thinking...", {
        message_thread_id: threadId,
      });
      thinkingMsgId = msg.message_id;
    } catch (err) {
      logger.error("Failed to send thinking message", { error: String(err) });
    }
  }

  return new Promise<number | null>((resolve) => {
    const key = streamKey(sessionId);

    const existing = activeStreams.get(key);
    if (existing) {
      existing.finalized = true;
      if (existing.pendingUpdate) clearTimeout(existing.pendingUpdate);
      existing.resolve(existing.thinkingMsgId);
    }

    const stream: ActiveStream = {
      chatId,
      threadId,
      thinkingMsgId,
      sessionId,
      parts: new Map(),
      messageInfo: null,
      lastSendTime: 0,
      lastText: "",
      pendingUpdate: null,
      finalized: false,
      resolve,
    };

    activeStreams.set(key, stream);

    const unsubscribers: (() => void)[] = [];

    const cleanup = () => {
      for (const unsub of unsubscribers) unsub();
      activeStreams.delete(key);
    };

    unsubscribers.push(
      events.on("message.part.updated", (event: OcEvent) => {
        if ((event.properties?.["sessionID"] as string | undefined) !== sessionId) return;
        const part = event.properties?.["part"] as OcMessagePart | undefined;
        if (!part) return;

        touchPart(sessionId);
        stream.parts.set(part.id, part);

        if (!stream.messageInfo && event.properties?.["info"]) {
          stream.messageInfo = event.properties["info"] as OcMessage["info"];
        }

        scheduleUpdate(api, stream);
      }),
    );

    unsubscribers.push(
      events.on("message.part.delta", (event: OcEvent) => {
        if ((event.properties?.["sessionID"] as string | undefined) !== sessionId) return;
        const partId = event.properties?.["partID"] as string | undefined;
        const field = event.properties?.["field"] as string | undefined;
        const delta = event.properties?.["delta"] as string | undefined;
        if (!partId || !delta) return;

        const existing = stream.parts.get(partId);
        if (existing) {
          if (field === "text" && existing.type === "text") {
            existing.text = (existing.text ?? "") + delta;
            touchPart(sessionId);
          } else if (field === "text" && existing.type === "reasoning") {
            existing.text = (existing.text ?? "") + delta;
            touchPart(sessionId);
          }
        }

        scheduleUpdate(api, stream);
      }),
    );

    unsubscribers.push(
      events.on("message.updated", (event: OcEvent) => {
        if ((event.properties?.["sessionID"] as string | undefined) !== sessionId) return;
        if (event.properties?.["info"]) {
          stream.messageInfo = event.properties["info"] as OcMessage["info"];
        }
      }),
    );

    // The server sometimes announces completion as session.idle instead of
    // session.status→idle (seen in live captures). Missing it strands the
    // waiter until the backstop, so listen for both.
    const settleIdle = (): void => {
      if (stream.finalized) return;
      stream.finalized = true;
      if (stream.pendingUpdate) clearTimeout(stream.pendingUpdate);
      cleanup();
      resolve(stream.thinkingMsgId);
    };

    unsubscribers.push(
      events.on("session.status", (event: OcEvent) => {
        if ((event.properties?.["sessionID"] as string | undefined) !== sessionId) return;
        const status = event.properties?.["status"] as { type: string } | undefined;
        if (status?.type === "idle" || status?.type === "completed") {
          settleIdle();
        }
      }),
    );

    unsubscribers.push(
      events.on("session.idle", (event: OcEvent) => {
        if ((event.properties?.["sessionID"] as string | undefined) !== sessionId) return;
        settleIdle();
      }),
    );

    // Generation errors never produce idle — without this the bot shows
    // "Thinking..." until the 5-minute backstop.
    unsubscribers.push(
      events.on("session.error", (event: OcEvent) => {
        if ((event.properties?.["sessionID"] as string | undefined) !== sessionId) return;
        logger.warn("Session error event", {
          sessionId,
          error: String(event.properties?.["error"] ?? "unknown"),
        });
        stream.finalized = true;
        if (stream.pendingUpdate) clearTimeout(stream.pendingUpdate);
        cleanup();
        resolve(stream.thinkingMsgId);
      }),
    );

    // Long-work backstop (12 min): resolve so the caller can deliver or
    // report, instead of hanging forever.
    setTimeout(() => {
      if (!stream.finalized) {
        stream.finalized = true;
        if (stream.pendingUpdate) clearTimeout(stream.pendingUpdate);
        cleanup();
        resolve(stream.thinkingMsgId);
      }
    }, 12 * 60 * 1000);
  });
}

export function cancelStream(sessionId: string): void {
  const key = streamKey(sessionId);
  const stream = activeStreams.get(key);
  if (stream) {
    stream.finalized = true;
    if (stream.pendingUpdate) clearTimeout(stream.pendingUpdate);
    stream.resolve(stream.thinkingMsgId);
    activeStreams.delete(key);
  }
}

export function isStreaming(sessionId: string): boolean {
  return activeStreams.has(streamKey(sessionId));
}

/**
 * Pick the reply that belongs to OUR prompt: the newest completed assistant
 * message reachable from our user message via parent links. Without this, a
 * shared/live session delivers somebody else's (or an older) answer.
 */
export function findReply(
  messages: OcMessage[],
  userMsgId: string | null,
  sinceTs: number,
): OcMessage | undefined {
  const byId = new Map(messages.map((m) => [m.info.id, m]));
  const reachesOurs = (m: OcMessage): boolean => {
    if (!userMsgId) return true;
    let cur: OcMessage | undefined = m;
    const seen = new Set<string>();
    let sawLink = false;
    while (cur && !seen.has(cur.info.id)) {
      seen.add(cur.info.id);
      if (cur.info.id === userMsgId) return true;
      const parent: string | undefined = cur.info.parentID;
      if (!parent) break;
      sawLink = true;
      cur = byId.get(parent);
    }
    // No parent links at all: unattributable, accept. A chain leading
    // elsewhere (another channel's answer): reject.
    return !sawLink;
  };
  const candidates = messages.filter(
    (m) =>
      m.info.role === "assistant" &&
      m.info.time.created >= sinceTs &&
      m.info.time.completed != null &&
      reachesOurs(m),
  );
  return candidates[candidates.length - 1];
}

/**
 * Polling fallback for final delivery: resolves true as soon as OUR answer
 * exists. Used in a race with the SSE stream so answers arrive even if the
 * event stream drops completion events.
 */
export async function pollForReply(
  sessionId: string,
  sinceTs: number,
  timeoutMs = 12 * 60 * 1000,
  isCancelled?: () => boolean,
  userMsgId?: string | null,
): Promise<boolean> {
  const { opencode } = await import("../opencode/client.js");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isCancelled?.()) return false;
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const messages = await opencode.getMessages(sessionId);
      // Only a *finished* answer counts: freshly created assistant messages
      // start out part-less, and delivering that snapshot yields "(empty response)".
      if (findReply(messages, userMsgId ?? null, sinceTs)) return true;
    } catch {
      // retry until deadline
    }
  }
  return false;
}

export function getThinkingMessageId(sessionId: string): number | null {
  return activeStreams.get(streamKey(sessionId))?.thinkingMsgId ?? null;
}

export async function sendFinalMessage(
  api: Api,
  chatId: number,
  response: OcMessage,
  threadId?: number,
  thinkingMsgId?: number | null,
): Promise<number | null> {
  const text = formatAssistantMessage(response);
  const chunks = splitMessage(text, config.stream.maxMessageLength);

  if (chunks.length === 0) {
    if (thinkingMsgId) {
      try {
        await api.editMessageText(chatId, thinkingMsgId, "(empty response)");
        return thinkingMsgId;
      } catch {
      }
    }
    const msg = await api.sendMessage(chatId, "(empty response)", {
      message_thread_id: threadId,
    });
    return msg.message_id;
  }

  let lastMsgId: number | null = null;

  // Flaky network to api.telegram.org observed — retry each chunk.
  const sendChunk = async (fn: () => Promise<number>, label: string): Promise<number | null> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        logger.warn("Telegram send failed, retrying", { label, attempt, error: String(err) });
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    logger.error("Failed to send final message chunk", { label });
    return null;
  };

  // Same retry for message edits (the Thinking... swap is equally exposed).
  const editChunk = async (
    fn: () => Promise<unknown>,
    label: string,
  ): Promise<boolean> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await fn();
        return true;
      } catch (err) {
        const msg = String(err);
        // The live stream already shows the final text — nothing to do.
        if (msg.includes("message is not modified")) return true;
        logger.warn("Telegram edit failed, retrying", { label, attempt, error: msg });
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    logger.error("Failed to edit message", { label });
    return false;
  };

  for (let i = 0; i < chunks.length; i++) {
    try {
      if (i === 0 && thinkingMsgId) {
        const ok = await editChunk(
          () =>
            api.editMessageText(chatId, thinkingMsgId, chunks[i]!, {
              parse_mode: "HTML",
            }),
          "final-edit",
        );
        if (ok) lastMsgId = thinkingMsgId;
        else {
          const msgId = await sendChunk(
            () =>
              api.sendMessage(chatId, chunks[i]!, {
                message_thread_id: threadId,
                parse_mode: "HTML",
              }).then((m) => m.message_id),
            "final-fallback",
          );
          if (msgId) lastMsgId = msgId;
        }
      } else {
        const msgId = await sendChunk(
          () =>
            api.sendMessage(chatId, chunks[i]!, {
              message_thread_id: threadId,
              parse_mode: "HTML",
            }).then((m) => m.message_id),
          `chunk-${i}`,
        );
        if (msgId) lastMsgId = msgId;
      }
    } catch (err) {
      logger.error("Failed to send final message chunk", { error: String(err) });
    }
  }

  return lastMsgId;
}
