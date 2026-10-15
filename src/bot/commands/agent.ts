import type { Context } from "grammy";
import { opencode } from "../../opencode/client.js";
import { getState, stateKey } from "../../services/session.js";
import { agentsKeyboard } from "../keyboards/agents.js";
import { threadOf } from "../middleware/thread.js";

export async function agentCommand(ctx: Context): Promise<void> {
  const state = getState(stateKey(ctx.chat?.id, ctx.from!.id));
  const cfg = await opencode.getConfig();

  const agents: { name: string; id: string }[] = [
    { name: "Build (default)", id: "build" },
    { name: "Plan (read-only)", id: "plan" },
  ];

  if (cfg.agent && typeof cfg.agent === "object") {
    for (const [id, _info] of Object.entries(cfg.agent)) {
      if (id !== "build" && id !== "plan") {
        agents.push({ name: id, id });
      }
    }
  }

  await ctx.reply("🧠 *Select an agent:*", {
    parse_mode: "Markdown",
    message_thread_id: threadOf(ctx),
    reply_markup: agentsKeyboard(agents, state.selectedAgent),
  });
}
