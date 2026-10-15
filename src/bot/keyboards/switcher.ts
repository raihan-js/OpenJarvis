import { InlineKeyboard } from "grammy";
import type { OcProvider } from "../../opencode/types.js";
import { truncate } from "../../utils/telegram.js";

const ITEMS_PER_PAGE = 5;

// ── Main switcher row ──────────────────────────────────────

export function switcherKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🤖 Model", "sw:model:providers:0")
    .text("🔀 Variant", "sw:variant:list:0")
    .text("🧠 Agent", "sw:agent:list:0");
}

// ── Provider list (model step 1) ───────────────────────────

export function switcherProvidersKeyboard(
  providers: OcProvider[],
  page = 0,
): InlineKeyboard {
  const nonEmpty = providers.filter((p) => Object.keys(p.models).length > 0);
  const totalPages = Math.ceil(nonEmpty.length / ITEMS_PER_PAGE);
  const start = page * ITEMS_PER_PAGE;
  const pageItems = nonEmpty.slice(start, start + ITEMS_PER_PAGE);

  const kb = new InlineKeyboard();

  for (const provider of pageItems) {
    const modelCount = Object.keys(provider.models).length;
    kb.text(`${provider.name} (${modelCount})`, `sw:model:provider:${provider.id}:0`).row();
  }

  if (totalPages > 1) {
    if (page > 0) kb.text("◀ Prev", `sw:model:providers:${page - 1}`);
    kb.text(`${page + 1}/${totalPages}`, "noop");
    if (page < totalPages - 1) kb.text("Next ▶", `sw:model:providers:${page + 1}`);
    kb.row();
  }

  kb.text("« Back", "sw:back").row();
  return kb;
}

// ── Model list for a provider (model step 2) ───────────────

export function switcherModelsKeyboard(
  provider: OcProvider,
  currentModelId: string | undefined,
  page = 0,
): InlineKeyboard {
  const models = Object.values(provider.models);
  const totalPages = Math.ceil(models.length / ITEMS_PER_PAGE);
  const start = page * ITEMS_PER_PAGE;
  const pageItems = models.slice(start, start + ITEMS_PER_PAGE);

  const kb = new InlineKeyboard();

  for (const model of pageItems) {
    const isCurrent = model.id === currentModelId;
    const prefix = isCurrent ? "✅ " : "";
    const label = truncate(`${prefix}${model.name}`, 40);
    kb.text(label, `sw:model:select:${provider.id}:${model.id}`).row();
  }

  if (totalPages > 1) {
    if (page > 0) kb.text("◀ Prev", `sw:model:provider:${provider.id}:${page - 1}`);
    kb.text(`${page + 1}/${totalPages}`, "noop");
    if (page < totalPages - 1) kb.text("Next ▶", `sw:model:provider:${provider.id}:${page + 1}`);
    kb.row();
  }

  kb.text("« Providers", "sw:model:providers:0").row();
  return kb;
}

// ── Variant list ───────────────────────────────────────────
export interface VariantGroup {
  label: string;
  providerID: string;
  modelID: string;
}

export function extractVariants(providers: OcProvider[], currentModelId?: string): VariantGroup[] {
  const variants: VariantGroup[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    for (const model of Object.values(provider.models)) {
      const variant = model.family ?? extractFamilyFromName(model.name);
      if (!variant) continue;

      const key = variant.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      variants.push({
        label: variant,
        providerID: provider.id,
        modelID: model.id,
      });
    }
  }

  variants.sort((a, b) => {
    const aCurrent = a.modelID === currentModelId ? -1 : 0;
    const bCurrent = b.modelID === currentModelId ? -1 : 0;
    if (aCurrent !== bCurrent) return aCurrent - bCurrent;
    return a.label.localeCompare(b.label);
  });

  return variants;
}

function extractFamilyFromName(name: string): string | null {
  const lower = name.toLowerCase();
  const patterns = [
    "opus", "sonnet", "haiku",
    "max", "thinking", "mini", "pro", "flash", "ultra",
    "large", "medium", "small",
    "turbo", "preview",
  ];
  for (const p of patterns) {
    if (lower.includes(p)) return p.charAt(0).toUpperCase() + p.slice(1);
  }
  return name;
}

export function switcherVariantsKeyboard(
  variants: VariantGroup[],
  currentModelId: string | undefined,
  page = 0,
): InlineKeyboard {
  const totalPages = Math.ceil(variants.length / ITEMS_PER_PAGE);
  const start = page * ITEMS_PER_PAGE;
  const pageItems = variants.slice(start, start + ITEMS_PER_PAGE);

  const kb = new InlineKeyboard();

  for (const v of pageItems) {
    const isCurrent = v.modelID === currentModelId;
    const prefix = isCurrent ? "✅ " : "";
    const label = truncate(`${prefix}${v.label}`, 40);
    kb.text(label, `sw:variant:select:${v.providerID}:${v.modelID}`).row();
  }

  if (totalPages > 1) {
    if (page > 0) kb.text("◀ Prev", `sw:variant:list:${page - 1}`);
    kb.text(`${page + 1}/${totalPages}`, "noop");
    if (page < totalPages - 1) kb.text("Next ▶", `sw:variant:list:${page + 1}`);
    kb.row();
  }

  kb.text("« Back", "sw:back").row();
  return kb;
}

// ── Agent list ─────────────────────────────────────────────

export interface AgentInfo {
  name: string;
  id: string;
}

export function switcherAgentsKeyboard(
  agents: AgentInfo[],
  currentAgentId: string | null | undefined,
  page = 0,
): InlineKeyboard {
  const totalPages = Math.ceil(agents.length / ITEMS_PER_PAGE);
  const start = page * ITEMS_PER_PAGE;
  const pageItems = agents.slice(start, start + ITEMS_PER_PAGE);

  const kb = new InlineKeyboard();

  for (const agent of pageItems) {
    const isCurrent = agent.id === currentAgentId;
    const prefix = isCurrent ? "✅ " : "";
    kb.text(`${prefix}${agent.name}`, `sw:agent:select:${agent.id}`).row();
  }

  if (totalPages > 1) {
    if (page > 0) kb.text("◀ Prev", `sw:agent:list:${page - 1}`);
    kb.text(`${page + 1}/${totalPages}`, "noop");
    if (page < totalPages - 1) kb.text("Next ▶", `sw:agent:list:${page + 1}`);
    kb.row();
  }

  kb.text("« Back", "sw:back").row();
  return kb;
}
