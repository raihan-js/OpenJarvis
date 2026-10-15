import type { Context } from "grammy";
import { opencode } from "../../opencode/client.js";
import { sessionsKeyboard } from "../keyboards/sessions.js";
import { effectiveDir } from "../../services/topic-store.js";
import { threadOf } from "../middleware/thread.js";

/** Last 8 touched sessions across ALL projects — nothing can hide. */
export async function recentCommand(ctx: Context): Promise<void> {
  const sessions = await opencode.listAllSessions();
  if (sessions.length === 0) {
    await ctx.reply("No sessions yet. Use /new to create one.", {
      message_thread_id: threadOf(ctx),
    });
    return;
  }
  const recent = [...sessions]
    .sort((a, b) => b.time.updated - a.time.updated)
    .slice(0, 8);
  await ctx.reply("🕘 *Recently active (all projects):*\n\nSelect a session to resume:", {
    parse_mode: "Markdown",
    message_thread_id: threadOf(ctx),
    reply_markup: sessionsKeyboard(recent, 0, (s) => effectiveDir(s.id, s.directory)),
  });
}
