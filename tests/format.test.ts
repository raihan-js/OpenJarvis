import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitMessage, markdownToTelegramHtml, escapeHtml } from "../src/utils/telegram.js";

describe("splitMessage", () => {
  it("passes short text through untouched", () => {
    assert.deepEqual(splitMessage("hello", 4000), ["hello"]);
  });

  it("splits long text into chunks within the limit", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} abcdef`).join("\n");
    const chunks = splitMessage(text, 200);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
    assert.equal(chunks.join("\n").replace(/\n+/g, "\n"), text.replace(/\n+/g, "\n"));
  });
});

describe("markdownToTelegramHtml", () => {
  it("converts bold and inline code", () => {
    const html = markdownToTelegramHtml("**bold** and `code`");
    assert.ok(html.includes("<b>bold</b>"), html);
    assert.ok(html.includes("<code>code</code>"), html);
  });

  it("wraps fenced code blocks in pre", () => {
    const html = markdownToTelegramHtml("```js\nconst x = 1;\n```");
    assert.ok(html.includes("<pre>"), html);
    assert.ok(html.includes("const x = 1;"), html);
  });

  it("escapes raw HTML so tags never render literally", () => {
    const html = markdownToTelegramHtml("<script>alert(1)</script>");
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("escapeHtml neutralizes angle brackets and ampersands", () => {
    assert.equal(escapeHtml("a<b>&c"), "a&lt;b&gt;&amp;c");
  });
});
