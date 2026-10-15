import { opencode } from "../src/opencode/client.js";

// 1. Union listing must find sessions across projects.
const all = await opencode.listAllSessions([process.env["E2E_PROBE_DIR"] ?? "/tmp/tg-e2e-probe"]);
console.log("union total:", all.length);
const dirs = new Set(all.map((s) => s.directory));
console.log("dirs covered:", dirs.size);
console.log("has RSNA:", all.some((s) => s.id === "ses_ecc39a0eeffer7nKUDGj1BhqSJ"));
console.log("has VETR sessions:", all.filter((s) => s.directory.includes("VETR")).length);

// 2. Ask-mode creation: bash must trigger permission.asked.
const s = await opencode.createSessionInDir("/tmp/tg-asktest");
console.log("created:", s.id);
const evtRes = await fetch("http://127.0.0.1:4096/event", {
  headers: { Accept: "text/event-stream" },
  signal: AbortSignal.timeout(95000),
}).catch(() => null);
await opencode.sendMessageAsync(s.id, "run exactly this shell command now: echo ask-probe-1. Just run it.", {
  model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
});
// Watch SSE manually for permission.asked.
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
        const m = l.match(/"id":"(per_[^"]+)"/);
        permId = m?.[1] ?? "PARSE_FAIL";
        break;
      }
    }
  }
  reader.cancel().catch(() => {});
}
console.log("permission request:", permId);
// 3. Reply "once" via the fixed route and confirm the run continues.
if (permId && permId !== "PARSE_FAIL") {
  await opencode.replyPermission(s.id, permId, "once");
  console.log("replied once OK");
  await new Promise((r) => setTimeout(r, 25000));
  const msgs = await opencode.getMessages(s.id);
  const texts = msgs.filter((m) => m.info.role === "assistant").map((m) =>
    m.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text as string).join(" "),
  );
  console.log("answer contains probe:", texts.some((t) => t.includes("ask-probe-1")));
}
await opencode.deleteSession(s.id).catch(() => {});
console.log("ASK E2E DONE");
