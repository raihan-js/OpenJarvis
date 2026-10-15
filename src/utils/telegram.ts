const MAX_TG_LENGTH = 4096;

/** Escape special characters for Telegram MarkdownV2 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/** Escape HTML special characters for Telegram HTML parse mode */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert Markdown to Telegram-compatible HTML.
 *
 * Handles: fenced code blocks, inline code, bold, italic, strikethrough,
 * links, headings (→ bold), blockquotes, and horizontal rules.
 * Nested/overlapping markup is handled on a best-effort basis.
 */
export function markdownToTelegramHtml(md: string): string {
  // Split into fenced code blocks vs everything else.
  // Pattern: ```lang?\n...``` (with optional language tag)
  const segments: string[] = [];
  const codeBlockRe = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(md)) !== null) {
    // Text before this code block
    if (match.index > lastIndex) {
      segments.push(convertInlineMarkdown(md.slice(lastIndex, match.index)));
    }
    // Code block — escape HTML inside, wrap in <pre><code>
    const lang = match[1];
    const code = escapeHtml(match[2]!);
    if (lang) {
      segments.push(`<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>`);
    } else {
      segments.push(`<pre>${code}</pre>`);
    }
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block
  if (lastIndex < md.length) {
    segments.push(convertInlineMarkdown(md.slice(lastIndex)));
  }

  return segments.join("");
}

/** Convert inline Markdown (everything except fenced code blocks) to Telegram HTML */
function convertInlineMarkdown(text: string): string {
  // Inline code — protect first so inner markup isn't processed
  const inlineCodePlaceholders: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    const idx = inlineCodePlaceholders.length;
    inlineCodePlaceholders.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  // Escape HTML entities in the remaining text
  text = escapeHtml(text);

  // Headings: ### Heading → bold line
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Blockquotes: > text → <blockquote>
  // Merge consecutive blockquote lines
  text = text.replace(
    /(?:^&gt;\s?(.*)$\n?)+/gm,
    (block) => {
      const inner = block
        .split("\n")
        .map((line) => line.replace(/^&gt;\s?/, ""))
        .join("\n")
        .trim();
      return `<blockquote>${inner}</blockquote>\n`;
    },
  );

  // Horizontal rules
  text = text.replace(/^[-*_]{3,}$/gm, "———");

  // Bold + italic: ***text*** or ___text___
  text = text.replace(/\*{3}(.+?)\*{3}/g, "<b><i>$1</i></b>");
  text = text.replace(/_{3}(.+?)_{3}/g, "<b><i>$1</i></b>");

  // Bold: **text** or __text__
  text = text.replace(/\*{2}(.+?)\*{2}/g, "<b>$1</b>");
  text = text.replace(/_{2}(.+?)_{2}/g, "<b>$1</b>");

  // Italic: *text* or _text_
  // Avoid matching mid-word underscores (e.g. some_var_name)
  text = text.replace(/\*(.+?)\*/g, "<i>$1</i>");
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Unordered list markers: - item or * item → • item
  text = text.replace(/^(\s*)[-*]\s+/gm, "$1• ");

  // Restore inline code placeholders
  text = text.replace(/\x00IC(\d+)\x00/g, (_m, idx: string) => inlineCodePlaceholders[Number(idx)]!);

  return text;
}

/** Split a long message into chunks that fit Telegram's limit */
export function splitMessage(text: string, maxLen = MAX_TG_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.3) {
      // If newline is too early, split at space
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      // Hard split
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/** Truncate text with ellipsis */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/** Format a timestamp to a human-readable relative time */
export function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Format token count compactly */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Format cost in dollars */
export function formatCost(cost: number): string {
  if (cost === 0) return "free";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
