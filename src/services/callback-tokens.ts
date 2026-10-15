import { randomUUID } from "node:crypto";

/**
 * Short tokens for Telegram callback_data (64-byte hard limit).
 * Full session/message/request ids don't fit alongside action prefixes
 * (perm:allow:ses_…:per_… = 68 bytes → BUTTON_DATA_INVALID, send fails),
 * so buttons carry a token and the payload lives here. Memory-only,
 * 30-minute TTL, one-shot consume.
 */
const store = new Map<string, { data: string; at: number }>();
const TTL_MS = 30 * 60 * 1000;

export function mintToken(data: string): string {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.at > TTL_MS) store.delete(k);
  }
  const token = randomUUID().slice(0, 8);
  store.set(token, { data, at: now });
  return token;
}

/** One-shot lookup; second use (double-tap) returns undefined. */
export function takeToken(token: string): string | undefined {
  const entry = store.get(token);
  if (entry) store.delete(token);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  return entry.data;
}
