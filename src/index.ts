import { config } from "./config.js";
import { setLogLevel, logger } from "./utils/logger.js";
import { initAuthStore } from "./services/auth-store.js";
import { initTopicStore } from "./services/topic-store.js";
import { startServer, stopServer } from "./opencode/server.js";
import { events } from "./opencode/events.js";
import { registerPermissionHandler } from "./bot/handlers/permission.js";
import { registerQuestionHandler } from "./bot/handlers/question.js";
import { resumePendingRuns } from "./services/runs.js";
import { registerTopicSyncHandler } from "./bot/handlers/topic-sync.js";
import { createBot } from "./bot/bot.js";
import { setupBot } from "./bot/setup.js";

async function withRetries<T>(fn: () => Promise<T>, label: string, attempts = 12): Promise<T> {
  let lastErr: unknown = new Error("unreachable");
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const waitMs = Math.min(4000 * i, 30000);
      logger.warn(`${label} failed`, { attempt: `${i}/${attempts}`, error: String(err), retryInMs: waitMs });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  setLogLevel(config.logLevel);
  logger.info("Starting OpenCode Telegram Bot");

  // Hygiene: drop orphaned voice/TTS temp files from crashed runs.
  try {
    const { readdirSync, unlinkSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = tmpdir();
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("tg-voice-") && !name.startsWith("tg-tts-")) continue;
      try {
        const p = join(dir, name);
        if (Date.now() - statSync(p).mtimeMs > 60 * 60 * 1000) unlinkSync(p);
      } catch {
        // ignore
      }
    }
  } catch {
    // hygiene must never block startup
  }

  initAuthStore();
  initTopicStore();

  if (config.opencode.autoStart) {
    await startServer();
  }

  const bot = createBot();

  // Telegram API is flaky from some networks — retry setup instead of
  // crash-looping (each crash used to wipe in-memory session selection).
  await withRetries(() => setupBot(bot), "Bot setup");

  await events.start();
  // Visible event flow: log every non-heartbeat SSE type so stalls are diagnosable.
  events.onAny((e) => {
    if (!e.type.startsWith("server.")) logger.info("SSE event", { type: e.type });
  });
  registerTopicSyncHandler(bot.api);
  logger.info("SSE event listener started");

  if (config.telegram.allowedUsers.length > 0) {
    for (const chatId of config.telegram.allowedUsers) {
      registerPermissionHandler(bot.api, chatId);
      registerQuestionHandler(bot.api, chatId);
    }
  }

  // Finish runs orphaned by a previous restart (deliver late answers).
  void resumePendingRuns(bot.api);
  // Drain queues that waited out the restart.
  const { drainAllQueues } = await import("./bot/handlers/message.js");
  void drainAllQueues(bot.api);

  const shutdown = async () => {
    logger.info("Shutting down...");
    events.stop();
    await bot.stop();
    if (config.opencode.autoStart) {
      stopServer();
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await withRetries(
    () =>
      bot.start({
        onStart: () => logger.info("Bot is running"),
      }),
    "Bot polling",
    1000,
  );
}

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) });
  process.exit(1);
});
