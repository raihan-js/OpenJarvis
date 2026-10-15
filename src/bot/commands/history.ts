import type { Context } from "grammy";
import { opencode } from "../../opencode/client.js";
import { getState, stateKey } from "../../services/session.js";
import { getSessionFromContext } from "../middleware/thread.js";
import { formatSessionMessages } from "../../services/formatter.js";
import { splitMessage } from "../../utils/telegram.js";
import { config } from "../../config.js";

export async function historyCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const chatId = ctx.chat!.id;
  const threadId = ctx.message?.message_thread_id;

  const topicSessionId = getSessionFromContext(ctx);
  const sessionId = topicSessionId ?? getState(stateKey(ctx.chat?.id, userId)).activeSessionId;

  if (!sessionId) {
    await ctx.reply("No active session. Use /sessions to pick one.");
    return;
  }

  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/history\s*/, "").trim();
  // Default: last 3 exchanges, newest last. Use /history N for more (max 200).
  const limit = arg ? Math.min(Math.max(parseInt(arg, 10) || 6, 1), 200) : 6;

  const session = await opencode.getSession(sessionId).catch(() => null);
  const messages = await opencode.getMessages(sessionId);
  const formatted = formatSessionMessages(messages, limit);

  if (formatted.length === 0) {
    await ctx.reply("📭 No messages in this session.");
    return;
  }

  const header =
    `🕘 <b>Last ${formatted.length} messages</b> — <i>${session?.title || session?.slug || sessionId.slice(0, 12)}</i>\n` +
    `<code>${session?.directory ?? ""}</code>`;
  await ctx.api.sendMessage(chatId, header, {
    message_thread_id: threadId,
    parse_mode: "HTML",
  });

  for (const msg of formatted) {
    const chunks = splitMessage(msg, config.stream.maxMessageLength);
    for (const chunk of chunks) {
      await ctx.api.sendMessage(chatId, chunk, {
        message_thread_id: threadId,
        parse_mode: "HTML",
      });
      // Paced: bursts trip Telegram flood control.
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
