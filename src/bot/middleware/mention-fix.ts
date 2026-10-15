import type { Context, NextFunction } from "grammy";

/**
 * In groups Telegram appends the bot name to tapped commands
 * ("/sessions@your_bot"). Without stripping, arg-parsing
 * commands treat "@bot" as a directory/project argument and misbehave.
 * Only strips our own username so other bots' commands pass through.
 */
export async function mentionFixMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const msg = ctx.message;
  const me = ctx.me?.username;
  if (msg && "text" in msg && typeof msg.text === "string" && me) {
    const fixed = msg.text.replace(new RegExp(`^(/[A-Za-z_]+)@${me}\\b`, "i"), "$1");
    if (fixed !== msg.text) msg.text = fixed;
  }
  await next();
}
