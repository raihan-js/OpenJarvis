import { InlineKeyboard } from "grammy";
import type { OcSession } from "../../opencode/types.js";
import { truncate, timeAgo } from "../../utils/telegram.js";

const SESSIONS_PER_PAGE = 5;

export function sessionsKeyboard(
  sessions: OcSession[],
  page = 0,
  dirOf?: (s: OcSession) => string,
): InlineKeyboard {
  const sorted = [...sessions].sort((a, b) => b.time.updated - a.time.updated);
  const totalPages = Math.ceil(sorted.length / SESSIONS_PER_PAGE);
  const start = page * SESSIONS_PER_PAGE;
  const pageItems = sorted.slice(start, start + SESSIONS_PER_PAGE);

  const kb = new InlineKeyboard();

  for (const session of pageItems) {
    const title = truncate(session.title || session.slug, 28);
    const ago = timeAgo(session.time.updated);
    // Effective project dir (intended project first) so sessions created
    // for a project are findable even though the server pins its own dir.
    const dir = dirOf ? dirOf(session) : session.directory;
    const dirName = dir.replace(/\/+$/, "").split("/").pop() ?? "";
    kb.text(`${title} · ${dirName} (${ago})`.slice(0, 60), `session:resume:${session.id}`).row();
  }

  if (totalPages > 1) {
    if (page > 0) kb.text("◀ Prev", `session:page:${page - 1}`);
    kb.text(`${page + 1}/${totalPages}`, "noop");
    if (page < totalPages - 1) kb.text("Next ▶", `session:page:${page + 1}`);
    kb.row();
  }

  kb.text("🆕 New Session", "session:new").row();

  return kb;
}

export function sessionActionsKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("📦 Compact", `session:compact:${sessionId}`)
    .text("🗑 Delete", `session:delete:${sessionId}`)
    .row()
    .text("« Back to sessions", "session:list");
}
