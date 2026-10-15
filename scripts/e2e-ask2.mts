import { opencode } from "../src/opencode/client.js";

const s = await opencode.createSessionInDir("/tmp/tg-asktest2");
console.log("created:", s.id);
const evtRes = await fetch("http://127.0.0.1:4096/event", {
  headers: { Accept: "text/event-stream" },
  signal: AbortSignal.timeout(95000),
}).catch(() => null);
await opencode.sendMessageAsync(s.id, "run exactly this shell command now: echo ask-probe-2. Just run it.", {
  model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
});
const reader = evtRes?.body?.getReader();
const dec = new TextDecoder();
let buf = "";
let permId: string | null = null;
const t0 = Date.now();
if (reader) {
  while (Date.now() - t0 < 85000 && !permId) {
    const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }));
    if (done || !value) break;
    buf += dec.decode(value as Uint8Array, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (l.includes("permission.asked")) {
        permId = l.match(/"id":"(per_[^"]+)"/)?.[1] ?? null;
        break;
      }
    }
  }
  reader.cancel().catch(() => {});
}
console.log("perm:", permId, `after ${Math.round((Date.now() - t0) / 1000)}s`);
if (permId) {
  const tries: [string, string, object][] = [
    ["POST", `/permission/${permId}/reply`, { reply: "once" }],
    ["POST", `/api/session/${s.id}/permission/${permId}/reply`, { reply: "once", directory: "/tmp/tg-asktest2" }],
    ["POST", `/permission/${permId}/reply`, { reply: "once", directory: "/tmp/tg-asktest2" }],
  ];
  for (const [m, p, b] of tries) {
    const r = await fetch(`http://127.0.0.1:4096${p}`, {
      method: m,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(15000),
    }).catch((e) => null);
    const txt = r ? await r.text().catch(() => "") : "FETCH_FAIL";
    console.log(m, p, "->", r?.status, txt.slice(0, 150));
    if (r?.status && r.status < 300) break;
  }
  await new Promise((r) => setTimeout(r, 20000));
  const msgs = await opencode.getMessages(s.id);
  const texts = msgs.filter((m) => m.info.role === "assistant").map((m) =>
    m.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text as string).join(" "),
  );
  console.log("answer has probe:", texts.some((t) => t.includes("ask-probe-2")));
}
await opencode.deleteSession(s.id).catch(() => {});
console.log("DONE");
