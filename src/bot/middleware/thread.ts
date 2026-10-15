import type { Context, RawApi, Transformer } from "grammy";
import { getSessionForTopic } from "../../services/topic-store.js";
import { logger } from "../../utils/logger.js";

/** Thread (topic) the incoming update belongs to, if any. */
export function threadOf(ctx: Context): number | undefined {
  return (
    ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? undefined
  );
}

export function getSessionFromContext(ctx: Context): string | undefined {
  const chatId = ctx.chat?.id;
  const threadId = threadOf(ctx);

  if (chatId && threadId) {
    return getSessionForTopic(chatId, threadId);
  }
  return undefined;
}

/**
 * Global safety net: if a topic was deleted out from under us, Telegram
 * rejects sends with "message thread not found". Retry once in the chat
 * root instead of failing the whole interaction.
 */
export const threadFallbackTransformer: Transformer<RawApi> = async (prev, method, payload, signal) => {
  try {
    return await prev(method, payload, signal);
  } catch (err) {
    const p = payload as Record<string, unknown>;
    if (p && typeof p === "object" && "message_thread_id" in p && String(err).includes("message thread not found")) {
      logger.warn("Topic gone, falling back to chat root", { method });
      const retry = { ...p };
      delete retry["message_thread_id"];
      return await prev(method, retry as typeof payload, signal);
    }
    throw err;
  }
};
