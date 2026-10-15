import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface UserState {
  activeSessionId: string | null;
  activeDirectory: string;
  selectedModel: { providerID: string; modelID: string } | null;
  selectedAgent: string | null;
  lastMessageId: number | null;
  /** OpenCode message id of the last delivered assistant reply (for /undo). */
  opLastMessageId: string | null;
  isBusy: boolean;
}

const states = new Map<number, UserState>();

/**
 * Per-chat state key: the chat id, falling back to the user id.
 * In a private chat both are identical, so existing persisted state keeps
 * working. In groups each group gets isolated project/session/model
 * selection — required for multi-group parallel workflows.
 */
export function stateKey(chatId: number | undefined, userId: number): number {
  return chatId ?? userId;
}

const STATE_FILE = "session-state.json";

function stateFilePath(): string {
  return join(config.auth.dataDir, STATE_FILE);
}

function persist(): void {
  try {
    if (!existsSync(config.auth.dataDir)) mkdirSync(config.auth.dataDir, { recursive: true });
    const obj: Record<string, UserState> = {};
    for (const [id, s] of states) obj[String(id)] = s;
    writeFileSync(stateFilePath(), JSON.stringify(obj, null, 2), "utf-8");
  } catch (err) {
    logger.debug("Failed to persist session state", { error: String(err) });
  }
}

function loadPersisted(userId: number): UserState | null {
  try {
    if (!existsSync(stateFilePath())) return null;
    const obj = JSON.parse(readFileSync(stateFilePath(), "utf-8")) as Record<string, UserState>;
    const saved = obj[String(userId)];
    if (!saved) return null;
    // Never restore a busy flag — a restart must not wedge the user.
    return { ...createDefault(), ...saved, isBusy: false, activeDirectory: saved.activeDirectory || createDefault().activeDirectory };
  } catch {
    return null;
  }
}

function createDefault(): UserState {
  return {
    activeSessionId: null,
    activeDirectory: config.opencode.defaultDir,
    selectedModel: null,
    selectedAgent: null,
    lastMessageId: null,
    opLastMessageId: null,
    isBusy: false,
  };
}

export function getState(userId: number): UserState {
  if (!states.has(userId)) {
    states.set(userId, loadPersisted(userId) ?? createDefault());
  }
  return states.get(userId)!;
}

export function setState(userId: number, patch: Partial<UserState>): UserState {
  const current = getState(userId);
  const updated = { ...current, ...patch };
  states.set(userId, updated);
  persist();
  return updated;
}

export function clearState(userId: number): void {
  states.delete(userId);
  persist();
}
