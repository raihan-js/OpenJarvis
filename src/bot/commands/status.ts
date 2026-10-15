import type { Context } from "grammy";
import { opencode } from "../../opencode/client.js";
import { getState, stateKey } from "../../services/session.js";
import { formatTokens, formatCost } from "../../utils/telegram.js";
import { threadOf, getSessionFromContext } from "../middleware/thread.js";

export async function statusCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const userKey = stateKey(ctx.chat?.id, userId);
  const state = getState(userKey);
  // Inside a topic the status is about THAT session, not the controller's.
  const topicSessionId = getSessionFromContext(ctx);
  const sessionId = topicSessionId ?? state.activeSessionId;

  const healthy = await opencode.isHealthy();
  const lines: string[] = [];

  lines.push(healthy ? "🟢 *Server:* connected" : "🔴 *Server:* disconnected");

  if (sessionId) {
    try {
      const session = await opencode.getSession(sessionId);
      lines.push(`📝 *Session:* ${session.title || session.slug}`);
      lines.push(`📁 *Directory:* \`${session.directory}\``);
      if (topicSessionId && topicSessionId !== state.activeSessionId) {
        lines.push(`🎛 *Controller active:* \`${(state.activeSessionId ?? "none").slice(0, 16)}\` (this topic keeps its own)`);
      }

      if (session.summary) {
        lines.push(
          `📊 *Changes:* +${session.summary.additions}/-${session.summary.deletions} in ${session.summary.files} files`
        );
      }

      const statuses = await opencode.getSessionStatus();
      const sessionStatus = statuses[sessionId];
      if (sessionStatus) {
        const icon = sessionStatus.type === "busy" ? "⏳" : "💤";
        lines.push(`${icon} *Status:* ${sessionStatus.type}`);
      }

      const { queueLength } = await import("../../services/runs.js");
      const q = queueLength(sessionId);
      if (q > 0) lines.push(`⏳ *Queued:* ${q}`);

      const messages = await opencode.getMessages(sessionId);
      const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant");
      if (lastAssistant?.info.tokens) {
        const t = lastAssistant.info.tokens;
        lines.push(`🔢 *Last tokens:* ${formatTokens(t.total)} (${formatTokens(t.input)}→${formatTokens(t.output)})`);
      }
      if (lastAssistant?.info.cost !== undefined) {
        lines.push(`💰 *Last cost:* ${formatCost(lastAssistant.info.cost)}`);
      }
    } catch {
      lines.push("📝 *Session:* (error loading)");
    }
  } else {
    lines.push("📝 *Session:* none — use /new or /sessions");
  }

  if (state.selectedModel) {
    lines.push(`🤖 *Model:* \`${state.selectedModel.providerID}/${state.selectedModel.modelID}\``);
  }

  if (state.selectedAgent) {
    lines.push(`🧠 *Agent:* ${state.selectedAgent}`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", message_thread_id: threadOf(ctx) });
}
