import type { OcMessage, OcMessagePart, OcTokens } from "../opencode/types.js";
import { formatTokens, formatCost, truncate, escapeHtml, markdownToTelegramHtml } from "../utils/telegram.js";

const TOOL_ICONS: Record<string, string> = {
  read: "\u{1F4D6}",
  write: "\u{1F4DD}",
  edit: "\u{270F}\u{FE0F}",
  bash: "\u{1F4BB}",
  glob: "\u{1F50D}",
  grep: "\u{1F50E}",
  fetch: "\u{1F310}",
  list: "\u{1F4C2}",
};

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "\u{1F527}";
}

function formatToolPart(part: OcMessagePart): string {
  if (part.type !== "tool" || !part.tool) return "";

  const icon = toolIcon(part.tool);
  const status = part.state?.status ?? "pending";
  const statusIcon = status === "completed" ? "\u2705" : status === "error" ? "\u274C" : "\u23F3";

  let line = `${icon} <b>${escapeHtml(part.tool)}</b> ${statusIcon}`;

  if (part.state?.title) {
    line += ` ${escapeHtml(truncate(part.state.title, 60))}`;
  } else if (part.state?.input) {
    const inputStr = typeof part.state.input === "string"
      ? part.state.input
      : JSON.stringify(part.state.input);
    line += ` ${escapeHtml(truncate(inputStr, 60))}`;
  }

  if (part.state?.output && status === "completed") {
    const outputPreview = truncate(part.state.output.trim(), 600);
    if (outputPreview) {
      // Expandable quote mirrors the terminal's click-to-expand sections.
      line += `\n<blockquote expandable>${escapeHtml(outputPreview)}</blockquote>`;
    }
  }

  if (part.state?.error) {
    line += `\n    \u2514 Error: ${escapeHtml(truncate(part.state.error, 150))}`;
  }

  if (part.state?.time) {
    const elapsed = ((part.state.time.end - part.state.time.start) / 1000).toFixed(1);
    line += ` (${elapsed}s)`;
  }

  return line;
}

function formatStepFinish(part: OcMessagePart): string {
  if (part.type !== "step-finish") return "";
  const pieces: string[] = [];

  if (part.tokens) {
    pieces.push(formatTokensSummary(part.tokens));
  }
  if (part.cost !== undefined && part.cost > 0) {
    pieces.push(formatCost(part.cost));
  }

  return pieces.length > 0 ? `\u{1F4CA} ${pieces.join(" \u2022 ")}` : "";
}

function formatTokensSummary(t: OcTokens): string {
  const parts: string[] = [`${formatTokens(t.input)}\u2192${formatTokens(t.output)}`];
  if (t.cache.read > 0) parts.push(`cache:${formatTokens(t.cache.read)}`);
  if (t.reasoning > 0) parts.push(`reasoning:${formatTokens(t.reasoning)}`);
  return parts.join(" ");
}

export function formatUserMessage(text: string): string {
  return `\u{1F464} ${escapeHtml(text)}`;
}

export function formatAssistantMessage(message: OcMessage): string {
  const sections: string[] = [];
  const toolLines: string[] = [];
  const textParts: string[] = [];
  let stepFinish = "";

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        if (part.text) textParts.push(markdownToTelegramHtml(part.text));
        break;
      case "reasoning":
        if (part.text) textParts.push(`\u{1F4AD} <blockquote expandable>${escapeHtml(truncate(part.text, 800))}</blockquote>`);
        break;
      case "tool": {
        const formatted = formatToolPart(part);
        if (formatted) toolLines.push(formatted);
        break;
      }
      case "step-finish": {
        const formatted = formatStepFinish(part);
        if (formatted) stepFinish = formatted;
        break;
      }
    }
  }

  if (toolLines.length > 0) {
    sections.push(toolLines.join("\n"));
  }

  if (textParts.length > 0) {
    sections.push(textParts.join("\n"));
  }

  if (stepFinish) {
    sections.push(stepFinish);
  }

  const modelLabel = message.info.model
    ? `${escapeHtml(message.info.model.providerID)}/${escapeHtml(message.info.model.modelID)}`
    : escapeHtml(message.info.modelID ?? "");

  const agentLabel = escapeHtml(message.info.agent ?? "");

  const header = ["\u{1F916}", agentLabel, modelLabel].filter(Boolean).join(" ");

  if (sections.length === 0) return `${header}\n(empty response)`;

  return `${header}\n${sections.join("\n\n")}`;
}

export function formatMessageForHistory(message: OcMessage): string {
  const time = new Date(message.info.time.created).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (message.info.role === "user") {
    const text = message.parts.find((p) => p.type === "text")?.text ?? "";
    return `<i>${time}</i>\n${formatUserMessage(text)}`;
  }
  if (message.info.role === "assistant") {
    // History stays readable: drop reasoning dumps, keep tools + final text.
    const slim: OcMessage = {
      ...message,
      parts: message.parts.filter((p) => p.type !== "reasoning"),
    };
    return `<i>${time}</i>\n${formatAssistantMessage(slim)}`;
  }
  return "";
}

export function formatSessionMessages(messages: OcMessage[], limit = 20): string[] {
  const relevant = messages
    .filter((m) => m.info.role === "user" || m.info.role === "assistant")
    .slice(-limit);

  return relevant.map(formatMessageForHistory).filter(Boolean);
}
