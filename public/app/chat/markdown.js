/* Answers arrive as Markdown. This draws the safe subset the conversation needs — paragraphs, line breaks, bold,
   italic, inline code, code blocks, headings, lists, tables, links and quotes — from escaped text, so nothing in an
   answer can become markup. No images, no javascript: links, all hrefs http(s) only with rel="noopener". */

import { esc } from "../core/dom.js";

const inline = (s) => {
  if (!s) return "";
  // Links: [text](url) but only http(s) urls; input is already escaped, so don't double-escape
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    if (!/^https?:\/\//.test(url)) return match; // not http(s), return literal
    return `<a href="${url}" rel="noopener">${text}</a>`;
  });
  // Code: backticks; content is already escaped
  s = s.replace(/`([^`]+)`/g, (match, code) => `<code>${code}</code>`);
  // Bold and italic; content is already escaped
  s = s.replace(/\*\*([^*]+)\*\*/g, (match, bold) => `<strong>${bold}</strong>`);
  s = s.replace(/\*([^*]+)\*/g, (match, italic) => `<em>${italic}</em>`);
  return s;
};

function block(chunk) {
  const lines = chunk.split("\n");

  // Empty
  if (!chunk.trim()) return "";

  // Heading: # ## ### etc
  const headingMatch = chunk.match(/^(#+)\s+(.+)$/m);
  if (headingMatch) {
    const level = Math.min(headingMatch[1].length, 6); // h1-h6
    return `<h${level}>${headingMatch[2]}</h${level}>`;
  }

  // Quote: > at the start
  if (/^>\s/.test(chunk)) {
    const quoted = lines.map((l) => l.replace(/^\s*>\s?/, "")).join("\n");
    return `<blockquote>${block(quoted)}</blockquote>`;
  }

  // Table: lines with | and spaces/dashes
  if (lines.length >= 3 && /^\s*\|.*\|/.test(lines[0]) && /^\s*\|[\s\-|:]+\|/.test(lines[1])) {
    const rows = lines.filter((l) => /^\s*\|/.test(l)).map((l) =>
      l.split("|").slice(1, -1).map((cell) => cell.trim())
    );
    if (rows.length > 1) {
      const [header, ...body] = rows;
      return `<table><thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
  }

  // Unordered list
  if (lines.every((l) => !l.trim() || /^\s*[-*] /.test(l))) {
    const items = lines.filter((l) => /^\s*[-*] /.test(l));
    if (items.length) return `<ul>${items.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
  }

  // Ordered list
  if (lines.every((l) => !l.trim() || /^\s*\d+[.)] /.test(l))) {
    const items = lines.filter((l) => /^\s*\d+[.)] /.test(l));
    if (items.length) return `<ol>${items.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ""))}</li>`).join("")}</ol>`;
  }

  // Paragraph with line breaks
  return `<p>${lines.map(inline).join("<br>")}</p>`;
}

export function text(markdown) {
  const safe = esc(markdown ?? "");
  return safe.split(/```/).map((part, i) => (i % 2
    ? `<pre><code>${part.replace(/^[a-z0-9-]*\n/i, "")}</code></pre>`
    : part.split(/\n{2,}/).map((c) => c.trim()).filter(Boolean).map(block).join(""))).join("");
}
