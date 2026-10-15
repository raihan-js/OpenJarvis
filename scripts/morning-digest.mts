/** Morning digest via the serve API (never the `opencode run` CLI: its free-tier
 * quota path fails at night with "can only be used from within OpenCode").
 * Ephemeral session: created, prompted, polled, delivered, deleted.
 * Usage: TELEGRAM_BOT_TOKEN=... OPENCODE_DEFAULT_DIR=/tmp tsx scripts/morning-digest.mts <chatId>
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { opencode } from "../src/opencode/client.js";
import { config } from "../src/config.js";

const chatId = process.argv[2];
if (!chatId) {
  console.error("usage: morning-digest.mts <telegram-chat-id>");
  process.exit(2);
}
const token = config.telegram.token;
const MODEL = { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function send(text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(chatId), text: text.slice(0, 4000) }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.text().catch(() => "");
  console.log("telegram send:", res.status, body.slice(0, 120));
}

async function main(): Promise<void> {
  const dataDir = config.auth.dataDir;
  let logTail = "none";
  try {
    const log = join(dataDir, "chats.log");
    if (existsSync(log)) {
      const lines = readFileSync(log, "utf-8").split("\n");
      logTail = lines.slice(-150).join("\n").slice(-4000);
    }
  } catch {
    // proceed without log
  }

  let sessionLines = "session list unavailable";
  try {
    const sessions = await opencode.listAllSessions();
    const top = [...sessions]
      .sort((a, b) => b.time.updated - a.time.updated)
      .slice(0, 12);
    sessionLines = top.map((s) => `- ${(s.title || s.slug || s.id.slice(0, 10)).slice(0, 60)}`).join("\n");
  } catch {
    // proceed without list
  }

  // Plain session (no ask-rules: a 7am digest must never block on approvals).
  const s = await opencode.createSession();
  try {
    const prompt =
      "Write a compact morning digest (max 12 short lines) in plain text, no markdown headers. " +
      `Overnight Telegram activity log: ${logTail}. Recent sessions: ${sessionLines}. ` +
      "Cover: prompts handled, replies delivered vs failed, voice notes, errors needing attention, sessions touched. " +
      "End with one line: what needs attention first. Reply with exactly the digest, no tool calls needed.";
    await opencode.sendMessageAsync(s.id, prompt, { model: MODEL });
    const t0 = Date.now();
    let digest: string | null = null;
    while (Date.now() - t0 < 8 * 60 * 1000) {
      await sleep(5000);
      const messages = await opencode.getMessages(s.id).catch((): null => null);
      if (!messages) continue;
      const done = [...messages]
        .reverse()
        .find((m) => m.info.role === "assistant" && m.info.time.completed != null);
      if (done) {
        digest = done.parts
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text as string)
          .join(" ")
          .trim();
        if (digest) break;
        digest = null;
      }
    }
    const d = new Date();
    const stamp = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (digest) {
      await send(`🌅 Morning digest — ${stamp}\n${digest}`);
    } else {
      await send(
        `🌅 Morning digest — ${stamp}\nDigest generation timed out after 8 minutes (model gave no answer). ` +
          `Sessions are fine; try asking me directly. Recent sessions:\n${sessionLines}`,
      );
    }
  } finally {
    await opencode.deleteSession(s.id).catch(() => {});
  }
}

main().catch(async (err) => {
  try {
    await send(`🌅 Morning digest failed: ${err instanceof Error ? err.message : String(err)}. Sessions untouched — ask me directly.`);
  } catch {
    // last resort: log only
    console.error("digest failed twice:", err);
  }
  process.exit(1);
});
