import type { Context, NextFunction } from "grammy";
import { isAuthorized } from "../../services/auth-store.js";
import { logger } from "../../utils/logger.js";

const AUTH_COMMANDS = new Set(["auth", "start"]);

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (isAuthorized(userId)) {
    await next();
    return;
  }

  // Only interactive content gets an auth verdict. Service messages
  // (topic created/closed, pins, join/leave notices — including ones
  // posted BY THIS BOT, e.g. forum_topic_created after we open a topic)
  // and unsupported content are ignored silently instead of scaring the
  // user with a "not authorized" reply to something they didn't send.
  const msg = ctx.message;
  const interactive =
    ctx.callbackQuery !== undefined ||
    (msg !== undefined &&
      ("text" in msg || "voice" in msg || "photo" in msg || "document" in msg));
  if (!interactive) return;

  // 1087968824 = GroupAnonymousBot: the sender is posting as the group
  // (anonymous admin), so their real user id is hidden. Tell them the fix.
  if (userId === 1087968824) {
    await ctx.reply(
      "You're messaging as the *group* (anonymous admin), so I can't see who you are. " +
        "Tap the group name, Administrators, your name, then turn OFF *Remain Anonymous* and try again.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  const command = ctx.message && "text" in ctx.message
    ? ctx.message.text?.split(" ")[0]?.replace("/", "")
    : undefined;

  if (command && AUTH_COMMANDS.has(command)) {
    await next();
    return;
  }

  logger.warn("Unauthorized access attempt", {
    userId,
    username: ctx.from?.username,
    chatId: ctx.chat?.id,
    senderChat: ctx.message && "sender_chat" in ctx.message ? ctx.message.sender_chat?.title : undefined,
    text: ctx.message && "text" in ctx.message ? ctx.message.text?.slice(0, 60) : undefined,
  });

  // Posting as a linked channel (sender_chat set): same invisibility problem
  // as anonymous admins — must switch to the personal profile.
  if (ctx.message && "sender_chat" in ctx.message && ctx.message.sender_chat) {
    await ctx.reply(
      "You're messaging as a channel, so I can't see who you are. Switch to your personal profile and try again.",
    );
    return;
  }

  await ctx.reply("⛔ Not authorized. Use /auth <PIN> to authenticate.");
}
