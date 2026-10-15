import { InlineKeyboard } from "grammy";
import type { OcProvider } from "../../opencode/types.js";
import { truncate } from "../../utils/telegram.js";

export function providersKeyboard(providers: OcProvider[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const provider of providers) {
    const modelCount = Object.keys(provider.models).length;
    if (modelCount === 0) continue;
    kb.text(`${provider.name} (${modelCount})`, `model:provider:${provider.id}`).row();
  }
  return kb;
}

export function modelsKeyboard(
  provider: OcProvider,
  currentModelId?: string
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const models = Object.values(provider.models);

  for (const model of models.slice(0, 15)) {
    const isCurrent = model.id === currentModelId;
    const prefix = isCurrent ? "✅ " : "";
    const label = truncate(`${prefix}${model.name}`, 40);
    kb.text(label, `model:select:${provider.id}:${model.id}`).row();
  }

  kb.text("« Back to providers", "model:list").row();
  return kb;
}
