import type { Context } from "grammy";
import { opencode } from "../../opencode/client.js";
import { getState, setState, stateKey } from "../../services/session.js";
import { threadOf } from "../middleware/thread.js";

export async function startCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const userKey = stateKey(ctx.chat?.id, userId);
  const state = getState(userKey);

  let statusText = "🚀 *OpenCode Telegram Bot*\n\nControl OpenCode from your phone.\n\n";

  const healthy = await opencode.isHealthy();
  statusText += healthy ? "🟢 Server: connected\n" : "🔴 Server: disconnected\n";

  if (state.activeSessionId) {
    try {
      const session = await opencode.getSession(state.activeSessionId);
      statusText += `📝 Session: ${session.title || session.slug}\n`;
    } catch {
      setState(userKey, { activeSessionId: null });
      statusText += "📝 Session: none\n";
    }
  } else {
    statusText += "📝 Session: none\n";
  }

  statusText += `📁 Project: ${state.activeDirectory}\n`;

  if (state.selectedModel) {
    statusText += `🤖 Model: ${state.selectedModel.providerID}/${state.selectedModel.modelID}\n`;
  }

  statusText += "\n*Flow:* /project → pick or create a folder (`/project kaggle`) → /sessions → chat.\nUse /help to see all commands.";

  await ctx.reply(statusText, { parse_mode: "Markdown", message_thread_id: threadOf(ctx) });
}
