import { InlineKeyboard } from "grammy";
import { mintToken } from "../../services/callback-tokens.js";

export function messageActionsKeyboard(sessionId: string, messageId: string): InlineKeyboard {
  // Tokenized: raw ids exceed Telegram's 64-byte callback_data limit.
  const undoTok = mintToken(JSON.stringify({ s: sessionId, m: messageId }));
  const contTok = mintToken(JSON.stringify({ s: sessionId }));
  return new InlineKeyboard()
    .text("↩️ Undo", `action:undo:${undoTok}`)
    .text("🔄 Continue", `action:continue:${contTok}`);
}

export function confirmKeyboard(action: string, id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Yes", `confirm:${action}:${id}`)
    .text("❌ No", "confirm:cancel");
}

export function permissionKeyboard(token: string): InlineKeyboard {
  // Tokenized: raw ids exceed Telegram's 64-byte callback_data limit.
  return new InlineKeyboard()
    .text("✅ Allow", `perm:allow:${token}`)
    .text("❌ Deny", `perm:deny:${token}`);
}
