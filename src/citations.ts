/**
 * Numbered references shared by everything that quotes a source: web research and the person's own
 * documents. A claim carries `[1]`, and the answer ends with a short "Sources" list the message
 * column already renders as Markdown. Quotes are trimmed and the same address is never numbered
 * twice, so a long report does not end with forty entries for four pages.
 */
export interface Source {
  /** A web address, or `document:<name>` for something in the person's own library. */
  url: string;
  title: string;
  /** The words this source actually said, kept short so a report stays readable. */
  quote?: string;
}
export interface Citation extends Source {
  number: number;
}
/** The most a quote may run to before it is cut; long enough to carry a full sentence. */
export const quoteLimit = 320;
const titleLimit = 160;

const tidy = (value: string, limit: number): string => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};
/** The same page reached two ways is one source: the fragment and a trailing slash do not matter. */
export function sourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export class Citations {
  private readonly byKey = new Map<string, Citation>();
  /** Numbers a source, reusing the number a matching address already has. */
  add(source: Source): Citation {
    const key = sourceKey(source.url);
    const existing = this.byKey.get(key);
    if (existing) {
      if (!existing.quote && source.quote) existing.quote = tidy(source.quote, quoteLimit);
      return existing;
    }
    const citation: Citation = {
      number: this.byKey.size + 1,
      url: source.url,
      title: tidy(source.title || source.url, titleLimit),
      ...(source.quote ? { quote: tidy(source.quote, quoteLimit) } : {}),
    };
    this.byKey.set(key, citation);
    return citation;
  }
  list(): Citation[] {
    return [...this.byKey.values()];
  }
  get size(): number {
    return this.byKey.size;
  }
  /** `[1]`, or `[1][3]` where several sources back the same sentence. */
  static marker(citations: Citation[]): string {
    return citations.map((citation) => `[${citation.number}]`).join("");
  }
  /** The "Sources" section: one numbered line each, with the quote that was relied on. */
  markdown(heading = "Sources"): string {
    if (!this.byKey.size) return "";
    const lines = this.list().map((citation) => {
      const link = citation.url.startsWith("document:")
        ? `${citation.title} (your documents)`
        : `[${citation.title}](${citation.url})`;
      return `${citation.number}. ${link}${citation.quote ? `\n   > ${citation.quote}` : ""}`;
    });
    return `## ${heading}\n\n${lines.join("\n")}\n`;
  }
}
