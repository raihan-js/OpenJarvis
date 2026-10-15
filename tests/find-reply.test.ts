import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findReply } from "../src/services/streaming.js";
import type { OcMessage } from "../src/opencode/types.js";

function msg(
  id: string,
  role: "user" | "assistant",
  opts: { parent?: string; created?: number; completed?: number | null; text?: string } = {},
): OcMessage {
  return {
    info: {
      id,
      sessionID: "ses_test",
      role,
      time: { created: opts.created ?? 1000, completed: opts.completed ?? undefined },
      parentID: opts.parent,
    },
    parts: opts.text ? [{ id: `p-${id}`, sessionID: "ses_test", messageID: id, type: "text", text: opts.text }] : [],
  };
}

describe("findReply attribution", () => {
  it("picks the answer chained to our prompt", () => {
    const u1 = msg("u1", "user", { created: 100 });
    const a1 = msg("a1", "assistant", { parent: "u1", created: 110, completed: 120, text: "ours" });
    const u2 = msg("u2", "user", { created: 130 });
    const a2 = msg("a2", "assistant", { parent: "u2", created: 140, completed: 150, text: "theirs" });
    const got = findReply([u1, a1, u2, a2], "u1", 90);
    assert.equal(got?.info.id, "a1");
  });

  it("rejects another channel's newer answer (no stale repeats)", () => {
    const u1 = msg("u1", "user", { created: 100 });
    const u2 = msg("u2", "user", { created: 130 });
    const a2 = msg("a2", "assistant", { parent: "u2", created: 140, completed: 150, text: "theirs" });
    const got = findReply([u1, u2, a2], "u1", 90);
    assert.equal(got, undefined);
  });

  it("ignores unfinished answers (no empty snapshots)", () => {
    const u1 = msg("u1", "user", { created: 100 });
    const a1 = msg("a1", "assistant", { parent: "u1", created: 110, completed: null });
    const got = findReply([u1, a1], "u1", 90);
    assert.equal(got, undefined);
  });

  it("accepts unattributable answers (no parent links at all)", () => {
    const a1 = msg("a1", "assistant", { created: 110, completed: 120, text: "x" });
    const got = findReply([a1], "u9", 90);
    assert.equal(got?.info.id, "a1");
  });

  it("follows multi-hop chains to our prompt", () => {
    const u1 = msg("u1", "user", { created: 100 });
    const a1 = msg("a1", "assistant", { parent: "u1", created: 110, completed: 115, text: "part1" });
    const a2 = msg("a2", "assistant", { parent: "a1", created: 120, completed: 130, text: "part2" });
    const got = findReply([u1, a1, a2], "u1", 90);
    assert.equal(got?.info.id, "a2");
  });

  it("without a user id returns the newest completed answer", () => {
    const a1 = msg("a1", "assistant", { created: 110, completed: 120 });
    const a2 = msg("a2", "assistant", { created: 140, completed: 150 });
    const got = findReply([a1, a2], null, 90);
    assert.equal(got?.info.id, "a2");
  });
});
