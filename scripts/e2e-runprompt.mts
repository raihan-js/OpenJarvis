/** Live E2E of runPrompt with a stub Telegram api (no real sends).
 * Scratch session only. Run:
 * TELEGRAM_BOT_TOKEN=test-token OPENCODE_DEFAULT_DIR=/tmp \
 *   node_modules/.bin/tsx scripts/e2e-runprompt.mts
 */
import { opencode } from "../src/opencode/client.js";
import { runPrompt } from "../src/bot/handlers/message.js";

const calls: string[] = [];
const stubApi: any = {
  sendMessage: async (chatId: number, text: string) => {
    calls.push(`send:${String(text).slice(0, 400)}`);
    return { message_id: Math.floor(Math.random() * 100000) };
  },
  editMessageText: async (chatId: number, msgId: number, text: string) => {
    calls.push(`edit:${String(text).slice(0, 400)}`);
    return true;
  },
};

async function main(): Promise<void> {
  const s = await opencode.createSessionInDir("/tmp/tg-e2e-runprompt");
  console.log("session:", s.id, s.directory);
  try {
    await runPrompt({
      api: stubApi,
      chatId: 1,
      key: 1,
      sessionId: s.id,
      text: "reply with exactly: runprompt-e2e-ok",
      origin: "text",
      draftId: 1,
    });
    const delivered = calls.some((c) => c.includes("runprompt-e2e-ok"));
    console.log("calls:", calls.length, "| delivered:", delivered);
    if (!delivered) {
      console.log(calls.slice(0, 10).join("\n"));
      throw new Error("answer never delivered through runPrompt");
    }
    console.log("RUNPROMPT E2E PASS");
  } finally {
    await opencode.deleteSession(s.id).catch(() => {});
  }
}

main().catch((err) => {
  console.error("RUNPROMPT E2E FAIL:", err);
  process.exit(1);
});
