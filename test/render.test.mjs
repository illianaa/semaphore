import test from "node:test";
import assert from "node:assert/strict";
import { avatar, formatMessage } from "../web/render.mjs";

test("conversation formatting keeps code readable and hostile message content inert", () => {
  const html = formatMessage(
    "## Plan\n\n**Useful** and `literal`\n\n- First\n- Second\n\n```html\n<img src=x onerror=alert(1)>\n```\n\n<script>alert(1)</script>\n\n[click](javascript:alert(1))",
  );
  assert.match(html, /<h3>Plan<\/h3>/);
  assert.match(html, /<strong>Useful<\/strong>/);
  assert.match(html, /<ul><li>First<\/li><li>Second<\/li><\/ul>/);
  assert.match(html, /<pre><code>&lt;img/);
  assert.doesNotMatch(html, /<img|<script|<a /);
  assert.doesNotMatch(avatar('astra" onclick="alert(1)'), /onclick/);
});
