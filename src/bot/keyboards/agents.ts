import { InlineKeyboard } from "grammy";

interface AgentInfo {
  name: string;
  id: string;
}

export function agentsKeyboard(
  agents: AgentInfo[],
  currentAgentId?: string | null
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const agent of agents) {
    const isCurrent = agent.id === currentAgentId;
    const prefix = isCurrent ? "✅ " : "";
    kb.text(`${prefix}${agent.name}`, `agent:select:${agent.id}`).row();
  }
  return kb;
}
