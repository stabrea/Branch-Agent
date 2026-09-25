/* Answers arrive as Markdown. This draws the safe subset the conversation needs — paragraphs, line breaks, bold,
   italic, inline code, code blocks and lists — from escaped text, so nothing in an answer can become markup. */

import { esc } from "../core/dom.js";

const inline = (s) => s
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

function block(chunk) {
  const lines = chunk.split("\n");
  if (lines.every((l) => /^\s*[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
  if (lines.every((l) => /^\s*\d+[.)] /.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ""))}</li>`).join("")}</ol>`;
  return `<p>${lines.map(inline).join("<br>")}</p>`;
}

export function text(markdown) {
  const safe = esc(markdown ?? "");
  return safe.split(/```/).map((part, i) => (i % 2
    ? `<pre><code>${part.replace(/^[a-z0-9-]*\n/i, "")}</code></pre>`
    : part.split(/\n{2,}/).map((c) => c.trim()).filter(Boolean).map(block).join(""))).join("");
}
