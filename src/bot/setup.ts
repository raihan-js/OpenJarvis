import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";

export async function setupBot(bot: Bot): Promise<void> {
  const me = await bot.api.getMe();
  logger.info("Bot identity", { id: me.id, username: me.username });

  await Promise.all([
    setCommands(bot),
    setDescription(bot),
    setShortDescription(bot),
  ]);

  if ("has_main_web_app" in me) {
    const hasTopics = (me as unknown as Record<string, unknown>)["has_topics_enabled"];
    if (!hasTopics) {
      logger.warn(
        "Forum topics NOT enabled for this bot. " +
        "Open @BotFather → Bot Settings → Forum Topics → Enable. " +
        "Per-session topics will not work until this is enabled.",
      );
    } else {
      logger.info("Forum topics enabled");
    }
  }

  logger.info("Bot setup complete");
}

async function setCommands(bot: Bot): Promise<void> {
  const commands = [
    { command: "new", description: "Create a new coding session" },
    { command: "sessions", description: "Browse and resume sessions" },
    { command: "models", description: "Switch AI model" },
    { command: "agent", description: "Switch agent" },
    { command: "project", description: "Switch project directory" },
    { command: "status", description: "Current session info and stats" },
    { command: "abort", description: "Stop current generation" },
    { command: "compact", description: "Summarize session to save tokens" },
    { command: "fork", description: "Fork current session" },
    { command: "continue", description: "Tell the model to keep going" },
    { command: "undo", description: "Revert the last reply's file changes" },
    { command: "share", description: "Get shareable link for session" },
    { command: "stats", description: "Token usage and costs" },
    { command: "history", description: "Last messages in session" },
    { command: "recent", description: "Recently active sessions, all projects" },
    { command: "whoami", description: "Show your auth status and role" },
    { command: "help", description: "List all commands" },
  ];

  try {
    await bot.api.setMyCommands(commands, {
      scope: { type: "all_private_chats" },
    });

    await bot.api.setMyCommands(commands, {
      scope: { type: "all_group_chats" },
    });

    logger.info("Bot commands registered", { count: commands.length });
  } catch (err) {
    logger.warn("Failed to set bot commands", { error: String(err) });
  }
}

async function setDescription(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyDescription(
      "Control OpenCode from your phone. Run AI coding sessions, switch models, manage projects — all from Telegram.\n\nSend /start to begin."
    );
  } catch (err) {
    logger.warn("Failed to set bot description", { error: String(err) });
  }
}

async function setShortDescription(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyShortDescription(
      "Remote control for OpenCode AI coding sessions"
    );
  } catch (err) {
    logger.warn("Failed to set bot short description", { error: String(err) });
  }
}
