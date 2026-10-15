import type { Context } from "grammy";
import { opencode } from "../../opencode/client.js";
import { getState, stateKey } from "../../services/session.js";
import { providersKeyboard } from "../keyboards/models.js";
import { threadOf } from "../middleware/thread.js";

export async function modelsCommand(ctx: Context): Promise<void> {
  const providersData = await opencode.getProviders();
  const state = getState(stateKey(ctx.chat?.id, ctx.from!.id));

  let text = "🤖 *Select a provider:*\n";
  if (state.selectedModel) {
    text += `\nCurrent: \`${state.selectedModel.providerID}/${state.selectedModel.modelID}\``;
  }

  await ctx.reply(text, {
    parse_mode: "Markdown",
    message_thread_id: threadOf(ctx),
    reply_markup: providersKeyboard(providersData.providers),
  });
}
