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

// All input is escaped before this small formatting subset is applied. There is
// no HTML passthrough, remote media, or executable link syntax.
export function formatMessage(text) {
  const parts = String(text).split(/```[^\n]*\n([\s\S]*?)```/g);
  const inline = (value) =>
    escape(value)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\s)@(Claude|Astra)\b/g, '$1<span class="mention">@$2</span>');
  return parts
    .map((part, index) => {
      if (index % 2)
        return `<pre><code>${escape(part.replace(/\n$/, ""))}</code></pre>`;
      return part
        .trim()
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((block) => {
          if (/^#{1,3} /.test(block) && !block.includes("\n"))
            return `<h3>${inline(block.replace(/^#{1,3} /, ""))}</h3>`;
          const lines = block.split("\n");
          if (lines.every((line) => /^[-*•] /.test(line)))
            return `<ul>${lines.map((line) => `<li>${inline(line.slice(2))}</li>`).join("")}</ul>`;
          if (lines.every((line) => /^\d+\. /.test(line)))
            return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\d+\. /, ""))}</li>`).join("")}</ol>`;
          return `<p>${inline(block).replace(/\n/g, "<br>")}</p>`;
        })
        .join("");
    })
    .join("");
}
