import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dialogText,
  dialogKeyboard,
  makePendingQuestion,
} from "../src/bot/handlers/question.js";
import { permissionKeyboard } from "../src/bot/keyboards/actions.js";
import { messageActionsKeyboard } from "../src/bot/keyboards/actions.js";
import { mintToken, takeToken } from "../src/services/callback-tokens.js";
import { targetForSession } from "../src/bot/handlers/permission.js";
import { armTalkBack, takeTalkBackArm } from "../src/services/speak.js";
import { initTopicStore, setTopicMapping } from "../src/services/topic-store.js";

describe("question dialog rendering", () => {
  it("renders headers, options, and per-option buttons", () => {
    const entry = makePendingQuestion("que_1", [
      { header: "Pick a fruit", options: [{ label: "apple", description: "Crisp" }, { label: "mango" }] },
      { header: "Size?", options: [{ label: "big" }, { label: "small" }] },
    ]);
    const text = dialogText(entry);
    assert.ok(text.includes("Pick a fruit"), text);
    assert.ok(text.includes("apple"), text);
    assert.ok(text.includes("mango"), text);
    assert.ok(!text.includes("<script>"), "must be escaped HTML");
    const kb = dialogKeyboard(entry);
    const buttons = kb.inline_keyboard.flat().map((b: any) => b.callback_data as string);
    assert.ok(buttons.some((d) => d === "q:ans:que_1:0:0"), buttons.join("|"));
    assert.ok(buttons.some((d) => d === "q:ans:que_1:1:1"), buttons.join("|"));
    assert.ok(buttons.some((d) => d === "q:no:que_1"), buttons.join("|"));
  });

  it("marks answered questions and escapes hostile labels", () => {
    const entry = makePendingQuestion("que_2", [
      { header: "Pick <b>one</b>", options: [{ label: "a<b>c" }] },
    ]);
    entry.answers[0] = "a<b>c";
    const text = dialogText(entry);
    assert.ok(!text.includes("<b>one</b>"), text);
    assert.ok(text.includes("a&lt;b&gt;c"), "picked label shown escaped");
    const kb = dialogKeyboard(entry);
    const labels = kb.inline_keyboard.flat().map((b: any) => b.text as string);
    assert.ok(labels.some((t) => t.startsWith("✅")), labels.join("|"));
  });
});

describe("permission dialog routing", () => {
  it("approve/deny buttons fit in 64 bytes and round-trip", () => {
    const tok = mintToken(JSON.stringify({ s: "ses_abc", r: "per_xyz" }));
    const kb = permissionKeyboard(tok);
    const data = kb.inline_keyboard.flat().map((b: any) => b.callback_data as string);
    for (const d of data) assert.ok(d.length <= 64, `too long: ${d}`);
    assert.ok(data.some((d) => d === `perm:allow:${tok}`), data.join("|"));
    assert.ok(data.some((d) => d === `perm:deny:${tok}`), data.join("|"));
    assert.equal(takeToken(tok), JSON.stringify({ s: "ses_abc", r: "per_xyz" }));
    assert.equal(takeToken(tok), undefined, "one-shot");
  });

  it("undo/continue buttons fit in 64 bytes", () => {
    const kb = messageActionsKeyboard("ses_ec4a39832ffeVGg5S6S5mI2TeW", "msg_136353dbf001NZ6jrB8B53cUak");
    const data = kb.inline_keyboard.flat().map((b: any) => b.callback_data as string);
    for (const d of data) assert.ok(d.length <= 64, `too long: ${d}`);
  });

  it("routes to the topic thread when mapped, else fallback chat", () => {
    initTopicStore();
    assert.deepEqual(targetForSession("ses_nomap", 111), { chatId: 111 });
    setTopicMapping(-100, "ses_mapped", 25, "[K] - T");
    assert.deepEqual(targetForSession("ses_mapped", 111), { chatId: -100, threadId: 25 });
  });
});

describe("talk-back opt-in", () => {
  it("arms once and only once per session", () => {
    assert.equal(takeTalkBackArm(1, "ses_a"), false);
    armTalkBack(1, "ses_a");
    assert.equal(takeTalkBackArm(1, "ses_a"), true);
    assert.equal(takeTalkBackArm(1, "ses_a"), false);
    armTalkBack(1, "ses_a");
    assert.equal(takeTalkBackArm(2, "ses_a"), false, "other chats unaffected");
  });
});
