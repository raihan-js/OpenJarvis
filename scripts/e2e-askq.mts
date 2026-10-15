import { opencode } from "../src/opencode/client.js";

// Trigger a real question.asked, reply via top-level route, confirm unblock.
const s = await opencode.createSessionInDir("/tmp/tg-askq");
console.log("created:", s.id);
const evtRes = await fetch("http://127.0.0.1:4096/event", {
  headers: { Accept: "text/event-stream" },
  signal: AbortSignal.timeout(120000),
}).catch(() => null);
await opencode.sendMessageAsync(s.id, "Use the question tool to ask me: pick a fruit. Offer exactly two options: apple and mango. Then stop and wait.", {
  model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
});
const reader = evtRes?.body?.getReader();
const dec = new TextDecoder();
let buf = "";
let qid: string | null = null;
const t0 = Date.now();
if (reader) {
  while (Date.now() - t0 < 110000 && !qid) {
    const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }));
    if (done || !value) break;
    buf += dec.decode(value as Uint8Array, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (l.includes("question.asked")) {
        qid = l.match(/"id":"(que_[^"]+)"/)?.[1] ?? null;
        break;
      }
    }
  }
  reader.cancel().catch(() => {});
}
console.log("question:", qid, `after ${Math.round((Date.now() - t0) / 1000)}s`);
if (qid) {
  const r = await fetch(`http://127.0.0.1:4096/question/${qid}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers: [["mango"]] }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  console.log("reply status:", r?.status, (await r?.text().catch(() => "") ?? "").slice(0, 100));
  await new Promise((r2) => setTimeout(r2, 25000));
  const msgs = await opencode.getMessages(s.id);
  const texts = msgs.filter((m) => m.info.role === "assistant").map((m) =>
    m.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text as string).join(" ").toLowerCase(),
  );
  console.log("answer mentions mango:", texts.some((t) => t.includes("mango")));
}
await opencode.deleteSession(s.id).catch(() => {});
console.log("DONE");
