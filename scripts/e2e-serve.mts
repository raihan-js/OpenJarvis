/** Aggressive E2E against the live serve daemon on scratch sessions only.
 * Run: TELEGRAM_BOT_TOKEN=x OPENCODE_DEFAULT_DIR=/tmp \
 *   node_modules/.bin/tsx scripts/e2e-serve.mts
 * Uses 1-2 tiny generations on the free model. Never touches real sessions.
 */
import assert from "node:assert/strict";
import { opencode } from "../src/opencode/client.js";

const MODEL = { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // 1. serve healthy
  assert.equal(await opencode.isHealthy(), true, "serve must be healthy");
  console.log("ok 1/6 healthy");

  // 2. create scratch session (headless, no TUI anywhere)
  const s = await opencode.createSession("/tmp/tg-e2e-proof");
  assert.ok(s.id.startsWith("ses_"), "session id shape");
  console.log("ok 2/6 created", s.id);

  try {
    // 3. prompt with explicit model, expect a completed answer < 150s
    await opencode.sendMessageAsync(s.id, "reply with exactly: e2e-apple", { model: MODEL });
    let answer: string | null = null;
    for (let i = 0; i < 30 && !answer; i++) {
      await sleep(5000);
      const messages = await opencode.getMessages(s.id);
      const done = [...messages]
        .reverse()
        .find((m) => m.info.role === "assistant" && m.info.time.completed != null);
      if (done) {
        answer = done.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text as string).join(" ");
      }
    }
    assert.ok(answer, "answer must complete within 150s");
    assert.ok(answer.includes("e2e-apple"), `answer content, got: ${answer.slice(0, 80)}`);
    console.log("ok 3/6 answered:", answer.slice(0, 40));

    // 4. getSession round-trip
    const back = await opencode.getSession(s.id);
    assert.equal(back.id, s.id);
    console.log("ok 4/6 getSession");

    // 5. abort returns a boolean (nothing running -> false is fine)
    const aborted = await opencode.abortSession(s.id);
    assert.equal(typeof aborted, "boolean");
    console.log("ok 5/6 abort ->", aborted);
  } finally {
    // 6. delete + verify gone
    await opencode.deleteSession(s.id);
    await assert.rejects(() => opencode.getSession(s.id), "session must be gone after delete");
    console.log("ok 6/6 deleted");
  }

  console.log("E2E PASS");
}

main().catch((err) => {
  console.error("E2E FAIL:", err);
  process.exit(1);
});
