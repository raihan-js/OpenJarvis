import { describe, it } from "node:test";
import assert from "node:assert/strict";

// NOTE: run with AUTH_DATA_DIR pointing at a scratch dir (see package/test
// command), because config binds the data dir at import time.
describe("prompt queue persistence", () => {
  it("queues survive a reload (restart-proof)", async () => {
    const runs = await import("../src/services/runs.js");
    assert.equal(runs.queueLength("ses_q"), 0);
    const p1 = runs.queuePush("ses_q", { key: 1, chatId: 1, text: "first", origin: "text", enqueuedAt: 1 });
    const p2 = runs.queuePush("ses_q", { key: 1, chatId: 1, text: "second", origin: "voice", enqueuedAt: 2 });
    assert.equal(p1, 1);
    assert.equal(p2, 2);
    // Fresh import state can't be forced; verify file contents directly.
    const { readFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const raw = JSON.parse(readFileSync(joinPath(process.env["AUTH_DATA_DIR"]!, "runs.json"), "utf-8"));
    assert.equal(raw.queues["ses_q"].length, 2);
    assert.equal(runs.queueShift("ses_q")?.text, "first");
    assert.equal(runs.queueShift("ses_q")?.text, "second");
    assert.equal(runs.queueShift("ses_q"), undefined);
    runs.queuePush("ses_q", { key: 1, chatId: 1, text: "x", origin: "text", enqueuedAt: 3 });
    runs.queueClear("ses_q");
    assert.equal(runs.queueLength("ses_q"), 0);
  });
});
