import { InlineKeyboard, type Api, type Context } from "grammy";
import { events } from "../../opencode/events.js";
import { opencode } from "../../opencode/client.js";
import { targetForSession } from "./permission.js";
import { escapeHtml } from "../../utils/telegram.js";
import { logger } from "../../utils/logger.js";
import type { OcEvent } from "../../opencode/types.js";

interface QuestionOption {
  label: string;
  description?: string;
}

interface PendingQuestion {
  requestId: string;
  sessionId: string;
  questions: { header: string; options: QuestionOption[] }[];
  /** Chosen label per question index; null while unanswered. */
  answers: (string | null)[];
  chatId: number;
  threadId?: number;
  dialogMsgId?: number;
}

/** Test helper: build a PendingQuestion without touching Telegram. */
export function makePendingQuestion(
  requestId: string,
  questions: { header: string; options: QuestionOption[] }[],
  chatId = 1,
): PendingQuestion {
  return { requestId, sessionId: "ses_test", questions, answers: questions.map(() => null), chatId };
}

const pending = new Map<string, PendingQuestion>();

export function getPendingQuestion(requestId: string): PendingQuestion | undefined {
  return pending.get(requestId);
}

/**
 * Register the SSE listener that pushes question dialogs to Telegram.
 * The model blocks until answered, so every question must resolve to
 * exactly one reply or reject call.
 */
export function registerQuestionHandler(api: Api, chatId: number): () => void {
  return events.on("question.asked", (event: OcEvent) => {
    const sessionId = (event.properties?.["sessionID"] as string) ?? "";
    const requestId = (event.properties?.["id"] as string) ?? "";
    const raw = (event.properties?.["questions"] as unknown[]) ?? [];
    if (!requestId || raw.length === 0) return;

    const target = targetForSession(sessionId, chatId);
    const entry: PendingQuestion = {
      requestId,
      sessionId,
      questions: raw.map((q) => {
        const obj = (q ?? {}) as Record<string, unknown>;
        const opts = (obj["options"] as unknown[] ?? []).map((o) => {
          const oo = (o ?? {}) as Record<string, unknown>;
          return { label: String(oo["label"] ?? "?"), description: oo["description"] as string | undefined };
        });
        return {
          header: String(obj["header"] ?? obj["question"] ?? "Question"),
          options: opts,
        };
      }),
      answers: raw.map(() => null),
      chatId: target.chatId,
      threadId: target.threadId,
    };
    pending.set(requestId, entry);
    logger.info("Question asked", {
      sessionId,
      requestId,
      count: entry.questions.length,
      targetChat: target.chatId,
    });
    void renderDialog(api, entry);
  });
}

/** Rendered dialog text (exported for tests). */
export function dialogText(entry: PendingQuestion): string {
  const parts = entry.questions.map((q, qi) => {
    const picked = entry.answers[qi];
    const head = `❓ <b>${escapeHtml(q.header)}</b>` + (picked ? ` → <code>${escapeHtml(picked)}</code>` : "");
    const opts = q.options
      .map((o, oi) => `${oi + 1}. ${escapeHtml(o.label)}${o.description ? ` — <i>${escapeHtml(o.description)}</i>` : ""}`)
      .join("\n");
    return `${head}\n${opts}`;
  });
  return parts.join("\n\n");
}

/** Option keyboard (exported for tests). */
export function dialogKeyboard(entry: PendingQuestion): InlineKeyboard {
  const kb = new InlineKeyboard();
  entry.questions.forEach((q, qi) => {
    q.options.forEach((o, oi) => {
      const mark = entry.answers[qi] === o.label ? "✅ " : "";
      kb.text(`${mark}Q${qi + 1}: ${o.label}`.slice(0, 50), `q:ans:${entry.requestId}:${qi}:${oi}`).row();
    });
  });
  kb.text("🚫 Dismiss", `q:no:${entry.requestId}`).row();
  return kb;
}

async function renderDialog(api: Api, entry: PendingQuestion): Promise<void> {
  const text = dialogText(entry);
  const reply_markup = dialogKeyboard(entry);
  try {
    if (entry.dialogMsgId) {
      await api.editMessageText(entry.chatId, entry.dialogMsgId, text, {
        parse_mode: "HTML",
        reply_markup,
      });
    } else {
      const msg = await api.sendMessage(entry.chatId, text, {
        message_thread_id: entry.threadId,
        parse_mode: "HTML",
        reply_markup,
      });
      entry.dialogMsgId = msg.message_id;
    }
  } catch (err) {
    logger.error("Failed to render question dialog", { error: String(err), requestId: entry.requestId });
  }
}

type AnswerCtx = Pick<Context, "api" | "answerCallbackQuery" | "editMessageText">;

interface AnswerTap extends AnswerCtx {
  requestId: string;
  qIdx: number;
  oIdx: number;
}

interface DismissTap extends AnswerCtx {
  requestId: string;
}

/** Tap on an option: record it; submit once every question is answered. */
export async function answerQuestionOption(ctx: AnswerTap): Promise<void> {
  const entry = pending.get(ctx.requestId);
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "Question expired — ask the model to ask again" });
    return;
  }
  const q = entry.questions[ctx.qIdx];
  const opt = q?.options[ctx.oIdx];
  if (!q || !opt) {
    await ctx.answerCallbackQuery({ text: "Unknown option" });
    return;
  }
  entry.answers[ctx.qIdx] = opt.label;
  await ctx.answerCallbackQuery({ text: `Picked: ${opt.label}` });

  if (entry.answers.every((a) => a !== null)) {
    try {
      await opencode.replyQuestion(
        entry.requestId,
        entry.answers.map((a) => [a as string]),
      );
      pending.delete(entry.requestId);
      const summary = entry.answers.map((a, i) => `Q${i + 1}: ${a}`).join(", ");
      await ctx.editMessageText(`✅ Answered — ${summary}`);
    } catch (err) {
      logger.error("Question reply failed", { error: String(err), requestId: entry.requestId });
      await ctx.editMessageText("❌ Failed to send the answer. The session may have moved on.");
      pending.delete(entry.requestId);
    }
    return;
  }
  await renderDialog(ctx.api, entry);
}

/** Dismiss: reject the request so the model unblocks. */
export async function dismissQuestion(ctx: DismissTap): Promise<void> {
  const entry = pending.get(ctx.requestId);
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "Question already resolved" });
    return;
  }
  try {
    await opencode.rejectQuestion(entry.requestId);
    await ctx.answerCallbackQuery({ text: "Dismissed" });
    await ctx.editMessageText("🚫 Question dismissed.");
  } catch (err) {
    logger.error("Question reject failed", { error: String(err), requestId: entry.requestId });
    await ctx.answerCallbackQuery({ text: "Failed to dismiss" });
  } finally {
    pending.delete(entry.requestId);
  }
}
