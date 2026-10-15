import type { Context, NextFunction } from "grammy";
import { logger } from "../../utils/logger.js";

export async function errorMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  try {
    await next();
  } catch (err) {
    const msg = String(err);
    // Stale button taps (user tapped an old message's keyboard): not an error,
    // stay silent — any reply here would itself be noise.
    if (msg.includes("query is too old") || msg.includes("query ID is invalid")) {
      logger.debug("Stale callback query ignored");
      return;
    }
    logger.error("Unhandled error in handler", {
      error: msg,
      update: JSON.stringify(ctx.update).slice(0, 200),
    });
    try {
      await ctx.reply("❌ Something went wrong. Please try again.", {
        message_thread_id:
          ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id,
      });
    } catch {
      // can't even reply
    }
  }
}
