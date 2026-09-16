/**
 * The owner's handbook, served to the app itself so Help opens beside the screen a person is on
 * rather than in a browser somewhere else. The chapters are the Markdown files in `docs/handbook`,
 * copied next to the built program by `scripts/copy-data.mjs`, exactly as the holiday list and the
 * list of model services are. Nothing here reads a path a caller chose: a name that is not one of
 * the eleven below is refused before the disk is touched.
 */
import { readFileSync } from "node:fs";

export interface HelpChapter {
  /** The file name without its ending, which is also what `/api/help/<id>` takes. */
  id: string;
  /** What the chapter is called, for the menu and the palette. */
  title: string;
  /** The sections this chapter is the help for, so Help opens the right one. */
  views: string[];
}

/** Every chapter, in reading order. The list is the allowlist; there is no other way in. */
export const helpChapters: HelpChapter[] = [
  { id: "00-start-here", title: "Start here", views: [] },
  { id: "01-connect-a-model", title: "Connect a model", views: [] },
  { id: "02-everyday-tasks", title: "Everyday tasks", views: ["chat", "documents", "runs"] },
  { id: "03-your-memory-and-knowledge", title: "Your memory and knowledge", views: ["memory"] },
  { id: "04-permissions-and-safety", title: "Permissions and safety", views: ["settings"] },
  { id: "05-reach-it-anywhere", title: "Reach it anywhere", views: [] },
  { id: "06-automate", title: "Automate", views: ["schedules", "procedures", "skills", "specialists"] },
  { id: "07-for-builders", title: "For builders", views: [] },
  { id: "08-troubleshooting", title: "Troubleshooting", views: [] },
  { id: "09-glossary", title: "Glossary", views: [] },
  { id: "10-what-branch-is-not", title: "What Branch is not", views: ["usage"] },
];

/** The chapter that answers questions about one section of the app, or the opening chapter. */
export function chapterForView(view: string): HelpChapter {
  return helpChapters.find((chapter) => chapter.views.includes(view)) ?? helpChapters[0]!;
}

/** Next to the built program first, then the repository's copy, exactly as the holiday list works. */
const places = (id: string): URL[] => [
  new URL(`./handbook/${id}.md`, import.meta.url),
  new URL(`../docs/handbook/${id}.md`, import.meta.url),
];

/** One chapter's Markdown, or undefined when the name is not one of ours. */
export function helpChapter(id: string): { chapter: HelpChapter; markdown: string } | undefined {
  const chapter = helpChapters.find((candidate) => candidate.id === id);
  if (!chapter) return undefined;
  for (const place of places(chapter.id)) {
    try {
      return { chapter, markdown: readFileSync(place, "utf8") };
    } catch { continue; }
  }
  throw new Error(`The handbook chapter "${chapter.title}" is missing from this installation`);
}

/** What `GET /api/help` and `GET /api/help/<id>` answer with. */
export function helpApi(path: string): unknown {
  const id = path.slice("/api/help".length).replace(/^\//, "");
  if (!id) return { chapters: helpChapters.map(({ id: chapterId, title, views }) => ({ id: chapterId, title, views })) };
  const found = helpChapter(id);
  if (!found) return undefined;
  return { id: found.chapter.id, title: found.chapter.title, markdown: found.markdown };
}
