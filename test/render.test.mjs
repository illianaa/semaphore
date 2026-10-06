import test from "node:test";
import assert from "node:assert/strict";
import { avatar, formatMessage } from "../web/render.mjs";

test("conversation formatting keeps code readable and hostile message content inert", () => {
  const html = formatMessage(
    "## Plan\n\n**Useful** and `literal`\n\n- First\n- Second\n\n```html\n<img src=x onerror=alert(1)>\n```\n\n<script>alert(1)</script>\n\n[click](javascript:alert(1))",
  );
  assert.match(html, /<h4>Plan<\/h4>/);
  assert.match(html, /<strong>Useful<\/strong>/);
  assert.match(html, /<ul><li>First<\/li><li>Second<\/li><\/ul>/);
  assert.match(html, /<pre><code>&lt;img/);
  assert.doesNotMatch(html, /<img|<script|<a /);
  assert.doesNotMatch(avatar('astra" onclick="alert(1)'), /onclick/);
});

test("links accept only absolute web and email destinations, with safe attributes", () => {
  const html = formatMessage('[**Docs**](https://example.com/a?x=1&y=2 "Read me") and [email](mailto:hello@example.com)');
  assert.match(html, /href="https:\/\/example.com\/a\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer" title="Read me"><strong>Docs<\/strong><\/a>/);
  assert.match(html, /href="mailto:hello@example.com"/);
  for (const url of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///tmp/report.html', '//example.com', '/local', '#section', 'jav&#x61;script:alert(1)', 'https:\\example.com', 'https://', 'mailto:', 'java\tscript:alert(1)']) {
    assert.doesNotMatch(formatMessage(`[click](${url})`), /<a |<script|<img/, url);
  }
  assert.doesNotMatch(formatMessage('[x](https://example.com/\"><script>alert(1)</script>)'), /<script|<img|href="[^"\n]*"[^>]*onclick/);
  const title = formatMessage('[x](https://example.com "\\\" onclick=\\\"alert(1)")');
  assert.match(title, /title="&quot; onclick=&quot;alert\(1\)"/);
});

test("link labels handle nested brackets and images become links without remote media", () => {
  assert.equal(formatMessage('[outer [inner]](https://example.com/a_(b))'), '<p><a href="https://example.com/a_(b)" target="_blank" rel="noopener noreferrer">outer [inner]</a></p>');
  const nested = formatMessage('[outer [inner](https://inner.example)](https://outer.example)');
  assert.equal((nested.match(/<a /g) ?? []).length, 1);
  assert.match(nested, /href="https:\/\/outer.example\/"/);
  const image = formatMessage('![A <b>photo</b>](https://example.com/photo.png)');
  assert.match(image, /<a [^>]+>A &lt;b&gt;photo&lt;\/b&gt;<\/a>/);
  assert.doesNotMatch(image, /<img|<b>/);
  assert.match(formatMessage('![](https://example.com/photo.png)'), />Image<\/a>/);
  assert.match(formatMessage('[`a[b`](https://example.com)'), /<a [^>]+><code>a\[b<\/code><\/a>/);
});

test("bare and angle links exclude prose punctuation but preserve balanced parentheses", () => {
  const html = formatMessage('See https://example.com/wiki/Thing_(example). Then (https://example.com/path), <https://example.com/angle> and <mailto:a@example.com>.');
  assert.match(html, /href="https:\/\/example.com\/wiki\/Thing_\(example\)"[^>]*>[^<]+<\/a>\./);
  assert.match(html, /\(<a href="https:\/\/example.com\/path"[^>]*>[^<]+<\/a>\),/);
  assert.match(html, /href="https:\/\/example.com\/angle"/);
  assert.match(html, /href="mailto:a@example.com"/);
});

test("code stays literal across fences and spans, including Markdown and URLs", () => {
  const html = formatMessage('`**bold** [x](https://example.com) @GPT`\n\n``use `ticks` and https://example.com``\n\n~~~~html\n<script>x</script>\n```\n[x](https://example.com)\n~~~~\n\n```\nAn unclosed fence\nhttps://example.com');
  assert.match(html, /<code>\*\*bold\*\* \[x\]\(https:\/\/example.com\) @GPT<\/code>/);
  assert.match(html, /<code>use `ticks` and https:\/\/example.com<\/code>/);
  assert.match(html, /<pre><code>&lt;script&gt;x&lt;\/script&gt;\n```/);
  assert.match(html, /<pre><code>An unclosed fence\nhttps:\/\/example.com<\/code><\/pre>$/);
  assert.doesNotMatch(html, /<a |<script|<strong|class="mention"/);
  assert.equal(formatMessage('**before `**inside**` after**'), '<p><strong>before <code>**inside**</code> after</strong></p>');
});

test("inline emphasis, strike, escaped syntax and mentions do not alter identifiers", () => {
  const html = formatMessage('*em* and _em_ and **bold with _em_** and ~~old~~; snake_case and some_long_name. \\*literal\\* @GPT');
  assert.match(html, /<em>em<\/em> and <em>em<\/em>/);
  assert.match(html, /<strong>bold with <em>em<\/em><\/strong>/);
  assert.match(html, /<del>old<\/del>/);
  assert.match(html, /snake_case and some_long_name/);
  assert.match(html, /\*literal\* <span class="mention">@GPT<\/span>/);
  assert.equal(formatMessage('***both***'), '<p><strong><em>both</em></strong></p>');
});

test("mixed paragraphs, lists, headings and quotes do not require blank separators", () => {
  const html = formatMessage('# Plan\nIntro:\n- first\n  - nested\n  - nested two\n- second\nAfter.\n## Detail\n3. third\n4. fourth\n> A **quote**\n> - quoted item\n---\n### Next\nFinish.');
  assert.match(html, /^<h3>Plan<\/h3><p>Intro:<\/p><ul><li>first<ul><li>nested<\/li><li>nested two<\/li><\/ul><\/li><li>second<\/li><\/ul><p>After\.<\/p>/);
  assert.match(html, /<h4>Detail<\/h4><ol start="3"><li>third<\/li><li>fourth<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>A <strong>quote<\/strong><\/p><ul><li>quoted item<\/li><\/ul><\/blockquote><hr><h5>Next<\/h5><p>Finish\.<\/p>$/);
});

test("tables render escaped cells, alignment, inline code and links with a scroll region", () => {
  const html = formatMessage('Before\n| Item | Notes | Count |\n| :--- | :---: | ---: |\n| [Docs](https://example.com) | `a|b` | 2 |\n| <img src=x> | a\\|b | 3 |\n\nAfter');
  assert.match(html, /<p>Before<\/p><div class="markdown-table" role="region" aria-label="Message table" tabindex="0"><table>/);
  assert.match(html, /<th scope="col" class="align-center">Notes<\/th>/);
  assert.match(html, /<td class="align-center"><code>a\|b<\/code><\/td>/);
  assert.match(html, /<td class="align-left">&lt;img src=x&gt;<\/td><td class="align-center">a\|b<\/td><td class="align-right">3<\/td>/);
  assert.match(html, /<\/table><\/div><p>After<\/p>$/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(formatMessage('a | b\nnot | a separator'), /<table>/);
});

test("malformed and deeply nested syntax stays bounded and inert", () => {
  const html = formatMessage('['.repeat(40_000) + 'end\n\n' + '> '.repeat(30) + '<script>x</script>');
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /end/);
  assert.ok((html.match(/<blockquote>/g) ?? []).length <= 8);
  assert.doesNotMatch(formatMessage('<'.repeat(40_000)), /<a /);
  assert.match(formatMessage('https://example.com/' + ')'.repeat(20_000)), /^<p><a href="https:\/\/example.com\/"/);
});
