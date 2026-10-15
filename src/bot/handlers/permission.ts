import type { Api } from "grammy";
import { events } from "../../opencode/events.js";
import { permissionKeyboard } from "../keyboards/actions.js";
import { logger } from "../../utils/logger.js";
import { getTopicForSession } from "../../services/topic-store.js";
import { escapeHtml } from "../../utils/telegram.js";
import { mintToken } from "../../services/callback-tokens.js";
import type { OcEvent } from "../../opencode/types.js";

/**
 * Register SSE event handlers that push permission dialogs to Telegram.
 *
 * When OpenCode needs approval for a tool call (file write, shell command, etc.),
 * it emits a permission event via SSE. We catch that and send an inline keyboard
 * to the Telegram chat so the user can approve/deny from their phone.
 */
export function registerPermissionHandler(api: Api, chatId: number): () => void {
  // Real opencode SSE type is "permission.asked" with
  // properties {id, sessionID, permission, patterns, metadata, ...}.
  const unsubscribe = events.on("permission.asked", (event: OcEvent) => {
    const sessionId = (event.properties?.["sessionID"] as string) ?? "";
    const permissionId = (event.properties?.["id"] as string) ?? "unknown";
    const permission = (event.properties?.["permission"] as string) ?? "unknown tool";
    const patterns = event.properties?.["patterns"];
    const metadata = event.properties?.["metadata"];
    const { chatId: targetChat, threadId: targetThreadId } = targetForSession(sessionId, chatId);
    logger.info("Permission requested", { sessionId, permission: permissionId, targetChat });

    let description = `🔐 <b>Permission request</b>\n\nPermission: <code>${escapeHtml(permission)}</code>\nSession: <code>${escapeHtml(sessionId.slice(0, 16))}</code>`;
    if (Array.isArray(patterns) && patterns.length > 0) {
      const preview = patterns
        .slice(0, 3)
        .map((p) => escapeHtml(String(p).slice(0, 100)))
        .join("\n");
      description += `\n\n<pre>${preview}</pre>`;
    } else if (metadata && typeof metadata === "object") {
      const preview = Object.entries(metadata as Record<string, unknown>)
        .slice(0, 3)
        .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v).slice(0, 80))}`)
        .join("\n");
      if (preview) {
        description += `\n\n<pre>${preview}</pre>`;
      }
    }

    api
      .sendMessage(targetChat, description, {
        parse_mode: "HTML",
        message_thread_id: targetThreadId,
        reply_markup: permissionKeyboard(mintToken(JSON.stringify({ s: sessionId, r: permissionId }))),
      })
      .catch((err) => {
        logger.error("Failed to send permission dialog", { error: String(err) });
      });
  });

  return unsubscribe;
}

/** Where a session's dialogs belong: its topic thread, else the fallback chat. */
export function targetForSession(sessionId: string, fallbackChatId: number): { chatId: number; threadId?: number } {
  // Approvals belong where the session lives: its topic thread if it has
  // one, otherwise the chat the handler was registered for (private chat).
  const topic = sessionId ? getTopicForSession(sessionId) : undefined;
  if (topic) return { chatId: topic.chatId, threadId: topic.topicId };
  return { chatId: fallbackChatId };
}
