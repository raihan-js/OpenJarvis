import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { opencode } from "../opencode/client.js";
import { findReply, sendFinalMessage, waitForFinalReply, isSessionSettled } from "./streaming.js";
import type { OcMessage } from "../opencode/types.js";
import type { Api } from "grammy";

export interface RunEntry {
  sessionId: string;
  chatId: number;
  threadId?: number;
  thinkingMsgId: number | null;
  promptTs: number;
  userMsgId: string | null;
  startedAt: number;
}

export interface QueueItem {
  key: number;
  chatId: number;
  threadId?: number;
  text: string;
  origin: "text" | "voice";
  enqueuedAt: number;
}

const RUNS_FILE = "runs.json";
const RUN_TTL_MS = 20 * 60 * 1000;
export const MAX_QUEUE = 5;

interface RunsFile {
  runs: Record<string, RunEntry>;
  queues: Record<string, QueueItem[]>;
}

function runsPath(): string {
  return join(config.auth.dataDir, RUNS_FILE);
}

function loadFile(): RunsFile {
  try {
    if (!existsSync(runsPath())) return { runs: {}, queues: {} };
    const raw = JSON.parse(readFileSync(runsPath(), "utf-8")) as Partial<RunsFile> & Record<string, RunEntry>;
    // Back-compat: older files stored runs at the top level.
    if (raw.runs) return { runs: raw.runs, queues: raw.queues ?? {} };
    return { runs: raw as unknown as Record<string, RunEntry>, queues: {} };
  } catch {
    return { runs: {}, queues: {} };
  }
}

function saveFile(data: RunsFile): void {
  try {
    if (!existsSync(config.auth.dataDir)) mkdirSync(config.auth.dataDir, { recursive: true });
    writeFileSync(runsPath(), JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logger.debug("Failed to persist runs", { error: String(err) });
  }
}

function loadRuns(): Record<string, RunEntry> {
  return loadFile().runs;
}

function saveRuns(runs: Record<string, RunEntry>): void {
  const data = loadFile();
  data.runs = runs;
  saveFile(data);
}

/** Seamless queue: prompts that arrive while a session is busy wait their turn. */
export function queuePush(sessionId: string, item: QueueItem): number {
  const data = loadFile();
  const q = data.queues[sessionId] ?? [];
  q.push(item);
  data.queues[sessionId] = q;
  saveFile(data);
  return q.length;
}

export function queueShift(sessionId: string): QueueItem | undefined {
  const data = loadFile();
  const q = data.queues[sessionId] ?? [];
  const item = q.shift();
  if (q.length === 0) delete data.queues[sessionId];
  else data.queues[sessionId] = q;
  saveFile(data);
  return item;
}

export function queueLength(sessionId: string): number {
  return loadFile().queues[sessionId]?.length ?? 0;
}

export function queueClear(sessionId: string): void {
  const data = loadFile();
  if (data.queues[sessionId]) {
    delete data.queues[sessionId];
    saveFile(data);
  }
}

export function queuedSessions(): string[] {
  return Object.keys(loadFile().queues);
}

export function journalAdd(entry: RunEntry): void {
  const runs = loadRuns();
  runs[entry.sessionId] = entry;
  saveRuns(runs);
}

export function journalRemove(sessionId: string): void {
  const runs = loadRuns();
  if (runs[sessionId]) {
    delete runs[sessionId];
    saveRuns(runs);
  }
}

/** Live runs in this process (busy-guard + stale detection). */
const liveRuns = new Set<string>();

export function markRunLive(sessionId: string): void {
  liveRuns.add(sessionId);
}

export function markRunDone(sessionId: string): void {
  liveRuns.delete(sessionId);
  journalRemove(sessionId);
}

export function hasLiveRun(sessionId: string): boolean {
  return liveRuns.has(sessionId);
}

async function deliver(api: Api, entry: RunEntry, messages: OcMessage[]): Promise<boolean> {
  const lastAssistant = findReply(messages, entry.userMsgId, entry.promptTs);
  if (!lastAssistant) return false;
  const msgId = await sendFinalMessage(api, entry.chatId, lastAssistant, entry.threadId, entry.thinkingMsgId);
  if (!msgId) return false;
  return true;
}

/**
 * Boot resume: after a restart, finish runs that were in flight.
 * Answers that completed while we were down get delivered; runs whose
 * session is still working are re-watched briefly.
 */
export async function resumePendingRuns(api: Api): Promise<void> {
  const runs = loadRuns();
  const ids = Object.keys(runs);
  if (ids.length === 0) return;
  logger.info("Resuming interrupted runs", { count: ids.length });

  for (const id of ids) {
    const entry = runs[id]!;
    if (hasLiveRun(entry.sessionId)) {
      journalRemove(entry.sessionId);
      continue;
    }
    try {
      const messages = await opencode.getMessages(entry.sessionId);
      const reply = findReply(messages, entry.userMsgId, entry.promptTs);
      // Only fast-deliver when the run is actually finished; a completed
      // progress message on a still-busy session must keep waiting.
      if (reply && isSessionSettled(entry.sessionId)) {
        const done = await deliver(api, entry, messages);
        if (done) {
          try {
            await api.sendMessage(entry.chatId, "✅ Recovered after restart — reply above.", {
              message_thread_id: entry.threadId,
            });
          } catch {
            // receipt is best-effort
          }
          journalRemove(entry.sessionId);
          continue;
        }
      }
      const age = Date.now() - entry.startedAt;
      if (age > RUN_TTL_MS) {
        try {
          if (entry.thinkingMsgId) {
            await api.editMessageText(entry.chatId, entry.thinkingMsgId, "⚠️ Interrupted by a restart and expired. Please resend your prompt.");
          }
        } catch {
          // ignore
        }
        journalRemove(entry.sessionId);
        continue;
      }
      // Still fresh: re-watch in background for the FINAL reply, then
      // deliver or expire.
      void (async () => {
        markRunLive(entry.sessionId);
        try {
          const final = await waitForFinalReply(entry.sessionId, entry.promptTs, entry.userMsgId, {
            timeoutMs: Math.max(0, RUN_TTL_MS - age),
          });
          if (final) {
            const msgs = await opencode.getMessages(entry.sessionId);
            if (await deliver(api, entry, msgs)) {
              markRunDone(entry.sessionId);
              return;
            }
          }
          try {
            if (entry.thinkingMsgId) {
              await api.editMessageText(entry.chatId, entry.thinkingMsgId, "⚠️ Still no reply — the session may be stuck. Try /abort, then resend.");
            }
          } catch {
            // ignore
          }
          markRunDone(entry.sessionId);
        } catch (err) {
          logger.warn("Run resume failed", { sessionId: entry.sessionId, error: String(err) });
          markRunDone(entry.sessionId);
        }
      })();
    } catch (err) {
      logger.warn("Run resume failed", { sessionId: entry.sessionId, error: String(err) });
      journalRemove(entry.sessionId);
    }
  }
}
