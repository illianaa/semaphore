export const labels = { human: "You", astra: "Astra", claude: "Claude" };
const marks = { human: "Y", astra: "✳", claude: "✺" };
export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
export function avatar(value) {
  const speaker = Object.hasOwn(labels, value) ? value : "human";
  return `<span class="avatar ${speaker === "human" ? "you" : speaker}" aria-hidden="true">${marks[speaker]}</span>`;
}

// This is a deliberately limited Markdown renderer, not an HTML parser. Every
// text/attribute value is escaped at emission; generated HTML is never reparsed.
const punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const word = /[\p{L}\p{N}]/u;
const unescapeMarkdown = value => value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
function safeHref(value) {
  value = unescapeMarkdown(value);
  if (/[\s\u0000-\u001f\u007f<>"\\]/u.test(value) || !/^(?:https?:\/\/|mailto:)/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "mailto:" ? !url.pathname : !url.hostname) return null;
    return url.href;
  } catch { return null; }
}
const anchor = (href, label, title) => `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escape(title)}"` : ""}>${label}</a>`;

function codeEnd(value, start, size, budget) {
  for (let i = start; i < value.length && budget.left-- > 0; i++) {
    if (value[i] !== "`") continue;
    let end = i;
    while (value[end] === "`") end++;
    if (end - i === size) return i;
    i = end - 1;
  }
  return -1;
}

function readLink(value, start, budget) {
  const image = value[start] === "!", labelStart = start + (image ? 2 : 1);
  let i = labelStart, brackets = 1;
  for (; i < value.length && budget.left-- > 0; i++) {
    if (value[i] === "\\") { i++; continue; }
    if (value[i] === "`") {
      const size = /^`+/.exec(value.slice(i))[0].length;
      const end = codeEnd(value, i + size, size, budget);
      if (end >= 0) { i = end + size - 1; continue; }
    }
    if (value[i] === "[") brackets++;
    if (value[i] === "]" && --brackets === 0) break;
  }
  if (brackets || value[i + 1] !== "(") return null;
  const label = value.slice(labelStart, i);
  i += 2;
  while (/[ \t]/.test(value[i] ?? "") && i < value.length) i++;
  let destination = "";
  if (value[i] === "<") {
    const end = value.indexOf(">", i + 1);
    budget.left -= (end < 0 ? value.length : end) - i;
    if (end < 0) return null;
    destination = value.slice(i + 1, end); i = end + 1;
  } else {
    const from = i; let parentheses = 0;
    for (; i < value.length && budget.left-- > 0; i++) {
      if (value[i] === "\\") { i++; continue; }
      if (value[i] === "(") parentheses++;
      else if (value[i] === ")") { if (!parentheses) break; parentheses--; }
      else if (/\s/.test(value[i]) && !parentheses) break;
    }
    destination = value.slice(from, i);
  }
  let spaced = false;
  while (/[ \t]/.test(value[i] ?? "") && i < value.length) { spaced = true; i++; }
  let title;
  if (spaced && (value[i] === '"' || value[i] === "'")) {
    const quote = value[i++], from = i;
    while (i < value.length && budget.left-- > 0 && value[i] !== quote) {
      if (value[i] === "\\") i++;
      i++;
    }
    if (value[i] !== quote) return null;
    title = unescapeMarkdown(value.slice(from, i++));
    while (/[ \t]/.test(value[i] ?? "") && i < value.length) i++;
  }
  if (value[i] !== ")") return null;
  return { end: i + 1, label: image && !label ? "Image" : label, href: safeHref(destination), title };
}

function bareDestination(value) {
  const pairs = { "(": ")", "[": "]", "{": "}" }, balance = { ")": 0, "]": 0, "}": 0 };
  for (const character of value) {
    if (pairs[character]) balance[pairs[character]]++;
    else if (Object.hasOwn(balance, character)) balance[character]--;
  }
  let end = value.length;
  while (end) {
    const character = value[end - 1];
    if (/[.,!?:;*_~]/.test(character)) end--;
    else if (balance[character] < 0) { balance[character]++; end--; }
    else break;
  }
  return value.slice(0, end);
}

function inline(value, { links = true, depth = 0, budget = { left: Math.max(1024, value.length * 32) } } = {}) {
  if (depth > 8) return escape(value);
  let html = "";
  for (let i = 0; i < value.length;) {
    if (budget.left-- <= 0) { html += escape(value.slice(i)); break; }
    const character = value[i];
    if (character === "\\" && punctuation.test(value[i + 1] ?? "")) {
      html += escape(value[i + 1]); i += 2; continue;
    }
    if (character === "`") {
      const size = /^`+/.exec(value.slice(i))[0].length;
      const end = codeEnd(value, i + size, size, budget);
      if (end >= 0) {
        let code = value.slice(i + size, end).replace(/\n/g, " ");
        if (/^ .* $/.test(code) && /\S/.test(code)) code = code.slice(1, -1);
        html += `<code>${escape(code)}</code>`; i = end + size; continue;
      }
      html += escape(value.slice(i, i + size)); i += size; continue;
    }
    if (links && (character === "[" || (character === "!" && value[i + 1] === "["))) {
      const link = readLink(value, i, budget);
      if (link) {
        html += link.href ? anchor(link.href, inline(link.label, { links: false, depth: depth + 1, budget }), link.title) : escape(value.slice(i, link.end));
        i = link.end; continue;
      }
    }
    if (links && character === "<" && /^<(?:https?:\/\/|mailto:)/i.test(value.slice(i))) {
      const end = value.indexOf(">", i + 1);
      budget.left -= (end < 0 ? value.length : end) - i;
      const href = end >= 0 && safeHref(value.slice(i + 1, end));
      if (href) { html += anchor(href, escape(value.slice(i + 1, end))); i = end + 1; continue; }
    }
    if (links && /[hH]/.test(character) && (i === 0 || !/[\w@]/.test(value[i - 1]))) {
      const match = /^https?:\/\/[^\s<>"'`]+/i.exec(value.slice(i));
      if (match) {
        // Prose punctuation is not part of a bare URL. Keep balanced URL pairs.
        const url = bareDestination(match[0]);
        const href = safeHref(url);
        if (href) { html += anchor(href, escape(url)); i += url.length; continue; }
      }
    }
    const delimiter = ["***", "___", "**", "__", "~~", "*", "_"].find(mark => value.startsWith(mark, i));
    if (delimiter && !/\s/.test(value[i + delimiter.length] ?? " ") &&
        !(delimiter[0] === "_" && word.test(value[i - 1] ?? ""))) {
      let end = i + delimiter.length;
      for (; end < value.length && budget.left-- > 0; end++) {
        if (value[end] === "\\") { end++; continue; }
        if (value[end] === "`") {
          const size = /^`+/.exec(value.slice(end))[0].length;
          const close = codeEnd(value, end + size, size, budget);
          if (close >= 0) { end = close + size - 1; continue; }
        }
        if (value.startsWith(delimiter, end) && !/\s/.test(value[end - 1]) &&
            !(delimiter[0] === "_" && word.test(value[end + delimiter.length] ?? ""))) break;
      }
      if (end < value.length && budget.left > 0) {
        const content = inline(value.slice(i + delimiter.length, end), { links, depth: depth + 1, budget });
        const tag = delimiter === "~~" ? "del" : delimiter.length === 2 ? "strong" : "em";
        html += delimiter.length === 3 ? `<strong><em>${content}</em></strong>` : `<${tag}>${content}</${tag}>`;
        i = end + delimiter.length; continue;
      }
    }
    const mention = character === "@" && (i === 0 || /\s/.test(value[i - 1])) && /^@(Claude|Astra)\b/.exec(value.slice(i));
    if (mention) { html += `<span class="mention">${mention[0]}</span>`; i += mention[0].length; continue; }
    html += character === "\n" ? "<br>" : escape(character); i++;
  }
  return html;
}

const fence = line => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const heading = line => /^ {0,3}(#{1,3})[ \t]+(.+)$/.exec(line);
const quote = line => /^ {0,3}>[ \t]?(.*)$/.exec(line);
const rule = line => /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
function listItem(line) {
  const match = /^([ \t]*)([-+*•]|\d{1,9}[.)])[ \t]+(.*)$/.exec(line);
  return match && { indent: match[1].replace(/\t/g, "    ").length, tag: /^\d/.test(match[2]) ? "ol" : "ul", start: parseInt(match[2], 10), text: match[3] };
}
function tableCells(line) {
  const cells = []; let cell = "", codeSize = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && i + 1 < line.length) { cell += line[i] + line[++i]; continue; }
    if (line[i] === "`") {
      const size = /^`+/.exec(line.slice(i))[0].length;
      codeSize = !codeSize ? size : codeSize === size ? 0 : codeSize;
      cell += line.slice(i, i + size); i += size - 1; continue;
    }
    if (line[i] === "|" && !codeSize) { cells.push(cell.trim()); cell = ""; }
    else cell += line[i];
  }
  cells.push(cell.trim());
  if (cells[0] === "" && line.trimStart().startsWith("|")) cells.shift();
  if (cells.at(-1) === "" && line.trimEnd().endsWith("|")) cells.pop();
  return cells;
}
function tableHeader(lines, index) {
  if (!lines[index]?.includes("|") || !lines[index + 1]) return null;
  const cells = tableCells(lines[index]), separators = tableCells(lines[index + 1]);
  if (!cells.length || cells.length !== separators.length || !separators.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  return { cells, align: separators.map(cell => cell.endsWith(":") ? cell.startsWith(":") ? "center" : "right" : "left") };
}
function renderList(lines, from, depth = 0) {
  const first = listItem(lines[from]); let i = from, items = "";
  while (i < lines.length) {
    const item = listItem(lines[i]);
    if (!item || item.indent !== first.indent || item.tag !== first.tag) break;
    let contents = inline(item.text); i++;
    while (i < lines.length && lines[i].trim()) {
      const child = listItem(lines[i]);
      if (child && child.indent > first.indent && depth < 4) {
        const nested = renderList(lines, i, depth + 1); contents += nested.html; i = nested.end;
      } else if (/^[ \t]+/.test(lines[i]) && (!child || child.indent > first.indent)) {
        contents += `<br>${inline(lines[i].trim())}`; i++;
      } else break;
    }
    items += `<li>${contents}</li>`;
  }
  const start = first.tag === "ol" && first.start !== 1 ? ` start="${first.start}"` : "";
  return { end: i, html: `<${first.tag}${start}>${items}</${first.tag}>` };
}
function blocks(lines, depth = 0) {
  const output = [];
  const startsBlock = i => fence(lines[i]) || heading(lines[i]) || rule(lines[i]) || quote(lines[i]) || listItem(lines[i]) || tableHeader(lines, i);
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue; }
    const code = fence(lines[i]), title = heading(lines[i]), table = tableHeader(lines, i);
    if (code) {
      const contents = [], closing = new RegExp(`^ {0,3}${code[1][0]}{${code[1].length},}[ \\t]*$`); i++;
      while (i < lines.length && !closing.test(lines[i])) contents.push(lines[i++]);
      if (i < lines.length) i++;
      output.push(`<pre><code>${escape(contents.join("\n"))}</code></pre>`); continue;
    }
    if (title) { const level = title[1].length + 2; output.push(`<h${level}>${inline(title[2].replace(/[ \t]+#+[ \t]*$/, ""))}</h${level}>`); i++; continue; }
    if (rule(lines[i])) { output.push("<hr>"); i++; continue; }
    if (quote(lines[i]) && depth < 8) {
      const quoted = [];
      while (i < lines.length && quote(lines[i])) quoted.push(quote(lines[i++])[1]);
      output.push(`<blockquote>${blocks(quoted, depth + 1)}</blockquote>`); continue;
    }
    if (table) {
      const row = (cells, tag) => `<tr>${table.cells.map((_, column) => `<${tag}${tag === "th" ? ' scope="col"' : ""} class="align-${table.align[column]}">${inline(cells[column] ?? "")}</${tag}>`).join("")}</tr>`;
      i += 2; const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|") && !fence(lines[i])) rows.push(row(tableCells(lines[i++]), "td"));
      output.push(`<div class="markdown-table" role="region" aria-label="Message table" tabindex="0"><table><thead>${row(table.cells, "th")}</thead><tbody>${rows.join("")}</tbody></table></div>`); continue;
    }
    if (listItem(lines[i])) { const list = renderList(lines, i); output.push(list.html); i = list.end; continue; }
    const paragraph = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !startsBlock(i)) paragraph.push(lines[i++]);
    output.push(`<p>${inline(paragraph.join("\n"))}</p>`);
  }
  return output.join("");
}

export function formatMessage(text) {
  return blocks(String(text ?? "").replace(/\r\n?/g, "\n").split("\n"));
}
