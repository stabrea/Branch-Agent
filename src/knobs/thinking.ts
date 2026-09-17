/**
 * R17-S12: hiding a model's written-out thinking. Models that think aloud (many local ones) wrap it
 * in `<think>…</think>` or `<thinking>…</thinking>` inside the answer itself. With "show reasoning"
 * off, those blocks are taken out of the kept answer and out of the live text as it arrives.
 */
const block = /<(think|thinking|reasoning)>[\s\S]*?(?:<\/\1>\s*|$)/gi;

/** The answer without its thinking blocks; an unfinished block runs to the end and is removed too. */
export function withoutThinking(text: string): string {
  if (!/<(think|thinking|reasoning)>/i.test(text)) return text;
  return text.replace(block, "").replace(/^\s+/, "");
}

const opening = /<(think|thinking|reasoning)>/i;

/**
 * Wraps a live-text callback so nothing between the marks reaches the page. Text is held back only
 * while it could still be the start of a mark, so ordinary answers stream as before.
 */
export function thinkingFilter(forward: (text: string) => void): (text: string) => void {
  let held = "", inside: string | null = null;
  return (chunk: string) => {
    held += chunk;
    for (;;) {
      if (inside) {
        const close = held.toLowerCase().indexOf(`</${inside}>`);
        if (close < 0) { held = held.slice(Math.max(0, held.length - inside.length - 3)); return; }
        held = held.slice(close + inside.length + 3).replace(/^\s+/, "");
        inside = null;
        continue;
      }
      const open = opening.exec(held);
      if (open) {
        if (open.index > 0) forward(held.slice(0, open.index));
        inside = open[1]!.toLowerCase();
        held = held.slice(open.index + open[0].length);
        continue;
      }
      const cut = held.lastIndexOf("<");
      const maybeMark = cut >= 0 && held.length - cut < 12 && /^<[a-z]*$/i.test(held.slice(cut));
      const ready = maybeMark ? held.slice(0, cut) : held;
      if (ready) forward(ready);
      held = maybeMark ? held.slice(cut) : "";
      return;
    }
  };
}
