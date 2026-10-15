import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Context } from "grammy";
import { opencode } from "../../opencode/client.js";
import { config } from "../../config.js";
import { getState, setState, stateKey } from "../../services/session.js";
import { sessionsKeyboard } from "../keyboards/sessions.js";
import { openOrCreateTopic } from "../handlers/callback.js";
import { threadOf } from "../middleware/thread.js";
import { effectiveDir, setIntendedDir } from "../../services/topic-store.js";
import { InlineKeyboard } from "grammy";

function resolveDir(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  if (trimmed.startsWith("/")) return resolve(trimmed);
  // Bare names resolve inside the projects root, same as /project.
  return resolve(config.opencode.defaultDir, trimmed);
}

function shortenDir(dir: string): string {
  return dir.replace(new RegExp(`^${homedir()}/`), "~/");
}

export async function sessionsCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const userKey = stateKey(ctx.chat?.id, userId);
  const state = getState(userKey);

  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/sessions\s*/, "").trim();

  if (arg) {
    const dir = resolveDir(arg);

    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        await ctx.reply(`❌ Cannot create directory: \`${dir}\`\n${String(err)}`, {
          message_thread_id: threadOf(ctx),
        });
        return;
      }
    }

    setState(userKey, { activeDirectory: dir, activeSessionId: null });
    const shortDir = shortenDir(dir);

    const allSessions = await opencode.listSessions(dir);
    const filtered = allSessions.filter((s) => s.directory === dir);

    if (filtered.length === 0) {
      await ctx.reply(
        `📁 Switched to *${shortDir}*\n\nNo sessions in this directory yet. Use /new to create one.`,
        { parse_mode: "Markdown", message_thread_id: threadOf(ctx) }
      );
      return;
    }

    await ctx.reply(
      `📁 *${shortDir}* — ${filtered.length} session${filtered.length > 1 ? "s" : ""}\n\nSelect a session to resume:`,
      {
        parse_mode: "Markdown",
        message_thread_id: threadOf(ctx),
        reply_markup: sessionsKeyboard(filtered, 0),
      }
    );
    return;
  }

  // Union across all known project dirs: the plain list endpoint only
  // returns the daemon's current-project subset.
  const sessions = await opencode.listAllSessions([state.activeDirectory]);

  if (sessions.length === 0) {
    await ctx.reply("No sessions yet. Use /new to create one.", {
      message_thread_id: threadOf(ctx),
    });
    return;
  }

  // Scope to the active project; `/sessions all` bypasses the filter.
  // Paths are normalized (trailing slashes) so equivalent dirs always match.
  // Matching uses the EFFECTIVE dir (intended project first): the server
  // pins its own directory on every API-created session.
  const norm = (d: string): string => d.replace(/\/+$/, "");
  const eff = (s: { id: string; directory: string }): string => norm(effectiveDir(s.id, s.directory));
  if (arg.toLowerCase() !== "all") {
    const inDir = sessions.filter((s) => eff(s) === norm(state.activeDirectory));
    if (inDir.length > 0) {
      const others = sessions.length - inDir.length;
      const shortDir = shortenDir(state.activeDirectory);
      const suffix = others > 0 ? `\n_${others} more in other projects — /sessions all_` : "";
      await ctx.reply(`📋 *Sessions in ${shortDir}*${suffix}\n\nSelect a session to resume:`, {
        parse_mode: "Markdown",
        message_thread_id: threadOf(ctx),
        reply_markup: sessionsKeyboard(inDir, 0, (s) => effectiveDir(s.id, s.directory)),
      });
      return;
    }
    const shortDir = shortenDir(state.activeDirectory);
    await ctx.reply(
      `📭 No sessions in *${shortDir}* yet.\n\nTap below to create one here, or /sessions all for everything.`,
      {
        parse_mode: "Markdown",
        message_thread_id: threadOf(ctx),
        reply_markup: new InlineKeyboard().text("🆕 New Session", "session:new"),
      },
    );
    return;
  }

  const activeLabel = state.activeSessionId
    ? ` (active: ${sessions.find((s) => s.id === state.activeSessionId)?.slug ?? "unknown"})`
    : "";

  await ctx.reply(`📋 *Sessions*${activeLabel}\n\nSelect a session to resume:`, {
    parse_mode: "Markdown",
    message_thread_id: threadOf(ctx),
    reply_markup: sessionsKeyboard(sessions, 0, (s) => effectiveDir(s.id, s.directory)),
  });
}

export async function newSessionCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const userKey = stateKey(ctx.chat?.id, userId);
  if (getState(userKey).isBusy) {
    await ctx.reply("⏳ Still processing the previous message. Use /abort to cancel it.", {
      message_thread_id: threadOf(ctx),
    });
    return;
  }
  setState(userKey, { isBusy: true });
  const state = getState(userKey);

  const working = await ctx.reply("🆕 Creating session in this project...", {
    message_thread_id: threadOf(ctx),
  });
  try {
    const intendedDir = state.activeDirectory;
    const session = await opencode.createSessionInDir(
      intendedDir,
      state.selectedModel ?? config.defaults.model,
    );
    // The server pins its own directory: remember which project this
    // session was created FOR so lists, topics, and receipts stay correct.
    setIntendedDir(session.id, intendedDir);
    setState(userKey, { activeSessionId: session.id, isBusy: false });

    // In forum groups each session gets its own topic thread.
    if (ctx.chat?.type !== "private") {
      const topicId = await openOrCreateTopic(
        ctx, session.id, session.title || session.slug, intendedDir,
      );
      if (topicId) {
        await ctx.api.deleteMessage(ctx.chat!.id, working.message_id).catch(() => {});
        await ctx.api.sendMessage(
          ctx.chat!.id,
          `✅ New session: *${session.title || session.slug}*\n📁 ${intendedDir}\n🔐 Approvals ON — I'll ask here before running shell commands or editing files.\n\nOpened in its own topic thread — chat there.`,
          { message_thread_id: topicId, parse_mode: "Markdown" },
        );
        return;
      }
    }
    await ctx.api.editMessageText(
      ctx.chat!.id,
      working.message_id,
      `✅ New session created: *${session.title || session.slug}*\n📁 ${intendedDir}\n🔐 Approvals ON — I'll ask here before running shell commands or editing files.\n\nSend me a message to start coding.`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    setState(userKey, { isBusy: false });
    await ctx.api
      .editMessageText(ctx.chat!.id, working.message_id, `❌ Could not create session: ${err instanceof Error ? err.message : "unknown error"}`)
      .catch(() => {});
  }
}
