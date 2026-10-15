import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

interface TopicEntry {
  sessionId: string;
  topicId: number;
  chatId: number;
  name: string;
  createdAt: number;
}

interface TopicStoreData {
  /** sessionId → TopicEntry */
  bySession: Record<string, TopicEntry>;
  /** `${chatId}:${topicId}` → sessionId */
  byTopic: Record<string, string>;
  /**
   * sessionId → INTENDED project dir. The serve daemon pins every API-created
   * session to its own directory, so the bot tracks which project a session
   * was created FOR. Used for filtering, receipts, and topic names.
   */
  intended: Record<string, string>;
}

const STORE_FILE = "topics.json";
let data: TopicStoreData = { bySession: {}, byTopic: {}, intended: {} };
let storePath = "";

function topicKey(chatId: number, topicId: number): string {
  return `${chatId}:${topicId}`;
}

function persist(): void {
  try {
    writeFileSync(storePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logger.error("Failed to persist topic store", { error: String(err) });
  }
}

export function initTopicStore(): void {
  const dir = config.auth.dataDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  storePath = join(dir, STORE_FILE);

  if (existsSync(storePath)) {
    try {
      const raw = readFileSync(storePath, "utf-8");
      data = JSON.parse(raw) as TopicStoreData;
      if (!data.intended) data.intended = {};
      const count = Object.keys(data.bySession).length;
      logger.info("Topic store loaded", { count });
    } catch (err) {
      logger.warn("Failed to load topic store, starting fresh", {
        error: String(err),
      });
      data = { bySession: {}, byTopic: {}, intended: {} };
    }
  }
}

export function setTopicMapping(
  chatId: number,
  sessionId: string,
  topicId: number,
  name: string,
): void {
  const entry: TopicEntry = {
    sessionId,
    topicId,
    chatId,
    name,
    createdAt: Date.now(),
  };
  data.bySession[sessionId] = entry;
  data.byTopic[topicKey(chatId, topicId)] = sessionId;
  persist();
}

export function getTopicForSession(sessionId: string): TopicEntry | undefined {
  return data.bySession[sessionId];
}

export function getSessionForTopic(
  chatId: number,
  topicId: number,
): string | undefined {
  return data.byTopic[topicKey(chatId, topicId)];
}

export function removeSessionMapping(sessionId: string): void {
  const entry = data.bySession[sessionId];
  if (entry) {
    delete data.byTopic[topicKey(entry.chatId, entry.topicId)];
    delete data.bySession[sessionId];
    persist();
  }
}

export function updateTopicName(sessionId: string, name: string): void {
  const entry = data.bySession[sessionId];
  if (entry) {
    entry.name = name;
    persist();
  }
}

export function removeTopicMapping(chatId: number, topicId: number): void {
  const key = topicKey(chatId, topicId);
  const sessionId = data.byTopic[key];
  if (sessionId) {
    delete data.bySession[sessionId];
    delete data.byTopic[key];
    persist();
  }
}

export function getTopicsForChat(chatId: number): TopicEntry[] {
  return Object.values(data.bySession).filter((e) => e.chatId === chatId);
}

/** Record which project dir a session was created FOR (see type doc). */
export function setIntendedDir(sessionId: string, dir: string): void {
  data.intended[sessionId] = dir;
  persist();
}

export function getIntendedDir(sessionId: string): string | undefined {
  return data.intended[sessionId];
}

/** Effective project dir: intended project first, server record as fallback. */
export function effectiveDir(sessionId: string, serverDir: string): string {
  return data.intended[sessionId] ?? serverDir;
}

export function hasAnyTopics(): boolean {
  return Object.keys(data.bySession).length > 0;
}

export function formatTopicName(directory: string, title: string): string {
  const parts = directory.replace(/\/+$/, "").split("/");
  const project = parts[parts.length - 1] || "project";
  return `[${project.toUpperCase()}] - ${title}`.slice(0, 128);
}
