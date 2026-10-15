import { Bot } from "grammy";
import { config } from "../config.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorMiddleware } from "./middleware/error.js";
import { mentionFixMiddleware } from "./middleware/mention-fix.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { threadFallbackTransformer } from "./middleware/thread.js";
import { startCommand } from "./commands/start.js";
import { helpCommand } from "./commands/help.js";
import { sessionsCommand, newSessionCommand } from "./commands/sessions.js";
import { modelsCommand } from "./commands/models.js";
import { agentCommand } from "./commands/agent.js";
import { statusCommand } from "./commands/status.js";
import {
  projectCommand,
  abortCommand,
  shareCommand,
  forkCommand,
  compactCommand,
  statsCommand,
  continueCommand,
  undoCommand,
} from "./commands/actions.js";
import { authCommand, grantCommand, revokeCommand, whoamiCommand } from "./commands/auth.js";
import { historyCommand } from "./commands/history.js";
import { recentCommand } from "./commands/recent.js";
import { callbackHandler } from "./handlers/callback.js";
import { messageHandler } from "./handlers/message.js";
import { mediaHandler } from "./handlers/media.js";
import { voiceHandler } from "./handlers/voice.js";

export function createBot(): Bot {
  const bot = new Bot(config.telegram.token);

  bot.api.config.use(threadFallbackTransformer);

  bot.use(errorMiddleware);
  bot.use(mentionFixMiddleware);
  bot.use(rateLimitMiddleware);
  bot.use(authMiddleware);

  bot.command("auth", authCommand);
  bot.command("grant", grantCommand);
  bot.command("revoke", revokeCommand);
  bot.command("whoami", whoamiCommand);

  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("sessions", sessionsCommand);
  bot.command("new", newSessionCommand);
  bot.command("models", modelsCommand);
  bot.command("agent", agentCommand);
  bot.command("status", statusCommand);
  bot.command("project", projectCommand);
  bot.command("abort", abortCommand);
  bot.command("share", shareCommand);
  bot.command("fork", forkCommand);
  bot.command("compact", compactCommand);
  bot.command("stats", statsCommand);
  bot.command("continue", continueCommand);
  bot.command("undo", undoCommand);
  bot.command("history", historyCommand);
  bot.command("recent", recentCommand);

  bot.on("callback_query:data", callbackHandler);
  bot.on("message:text", messageHandler);
  bot.on("message:voice", voiceHandler);
  bot.on("message:photo", mediaHandler);
  bot.on("message:document", mediaHandler);

  return bot;
}
