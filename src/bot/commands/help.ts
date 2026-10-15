import type { Context } from "grammy";
import { threadOf } from "../middleware/thread.js";

const HELP_TEXT = `*OpenCode Telegram Bot — Commands*

*Session Management*
/new — Create a new coding session
/sessions — Browse this project's sessions (/sessions all for everything)
/recent — Last 8 touched sessions across all projects
/history — Last exchanges (default 6, /history 20 for more)
/fork — Fork current session
/share — Get shareable link
/compact — Summarize to save tokens
/continue — Tell the model to keep going
/undo — Revert the last reply's file changes

*AI Control*
/models — Switch AI model
/agent — Switch agent (Build, Plan, etc.)
/abort — Stop current generation

*Project*
/project — Switch project directory
/status — Current session info + stats

*Auth*
/auth <PIN> — Authenticate with PIN
/whoami — Show your auth status
/grant <id> [owner|user] — Grant access (owner only)
/revoke <id> — Revoke access (owner only)

*Other*
/stats — Token usage and costs
/help — This message

Any text message is sent as a prompt to the active session.`;

export async function helpCommand(ctx: Context): Promise<void> {
  await ctx.reply(HELP_TEXT, { parse_mode: "Markdown", message_thread_id: threadOf(ctx) });
}
