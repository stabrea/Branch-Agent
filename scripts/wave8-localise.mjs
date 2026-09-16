/**
 * Wave 8 design QA, the mechanical half: the plain-language rewrites of the section screens,
 * then the wave-6 localisation finished for those sections.
 *
 * Every section intro and every card title inside a section gains a `data-t` key, and the
 * English wording is copied into public/locales/en.json. fr.json gains the same keys with the
 * English text as a draft, so every language file answers every key and nothing on screen can
 * fall back to a raw key. Run once: node scripts/wave8-localise.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

const HTML = "public/index.html";
const EN = "public/locales/en.json";
const FR = "public/locales/fr.json";
const SECTIONS = ["chat", "runs", "usage", "memory", "skills", "specialists", "procedures", "schedules", "documents", "settings"];

let html = readFileSync(HTML, "utf8");
const en = JSON.parse(readFileSync(EN, "utf8"));
const fr = JSON.parse(readFileSync(FR, "utf8"));

/* ---- 1. Plain words, and a title and a purpose on every card that lacked one. ---- */
/* The file may be stored with either line ending, so a needle matches both. */
const swap = (from, to) => {
  const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\n/g, "\\r?\\n"));
  if (!re.test(html)) throw new Error("not found: " + from.slice(0, 60));
  html = html.replace(re, () => to.replace(/\n/g, html.includes("\r\n") ? "\r\n" : "\n"));
};

/* Every card-level heading is an h2: a section's own name is the h1 in the title bar. */
for (const title of [
  "Set aside after repeated failures", "Suggested better versions",
  "Share a skill, or open one someone sent you", "Newer versions", "Might have helped lately",
  "Plugins", "Add a file from your workspace", "Or drop files here", "Search your documents",
  "Knowledge", "Made by the assistant",
]) swap(`<h3>${title}</h3>`, `<h2>${title}</h2>`);

swap(
  `            Every run has a trace. Inspect tool results, failures, and usage\n            estimates.`,
  `            Every task your assistant has done, newest first. Open one to see each step it\n            took, what came back, anything that went wrong, and what it cost.`);

swap(
  `            Focused assistants with limited permissions. A candidate must pass\n            its explicit file checks before you activate it.`,
  `            Assistants that do one job and are allowed to touch only what that job needs — the\n            one that tidies your invoices cannot open your photographs. A new one has to pass the\n            checks written into it before you can switch it on.`);

swap(
  `            Reusable tool recipes with exact expected results. Verification\n            executes the recipe; replay checks its preconditions again.`,
  `            A saved set of steps your assistant can repeat exactly, with the answer you expect\n            written down beside it. Checking one does the steps for real; replaying one first makes\n            sure everything it needs is still where it was.`);

swap(
  `            Reminders, tasks and monitoring checks: once, on an interval, or every day at a time in your timezone.\n            Branch Agent must be running to execute them. Missed periods become one run on the next\n            poll; failed or interrupted work does not retry automatically. Results can be sent to a chat that has talked to your assistant.`,
  `            Tasks your assistant starts on its own: once, every so often, or at the same time each day.\n            Branch Agent has to be running for any of them to happen. If the computer was asleep, the\n            missed times become one task the next time it looks; nothing that failed is tried again by\n            itself. The answer can be sent on to a chat you have already connected.`);

swap(
  `          <form id="schedule-form" class="card form-grid">\n            <div>`,
  `          <form id="schedule-form" class="card form-grid">\n            <h2>Set up a task</h2>\n            <p>Say what should happen and how often. You can change or stop it at any time from the list underneath.</p>\n            <div>`);

swap(
  `        <section id="memory" class="view" hidden>\n          <form id="history-search-form" class="card form-grid">\n            <div>`,
  `        <section id="memory" class="view" hidden>\n          <p class="section-intro">Everything your assistant has been told to remember, and everything you have already talked about. Nothing here leaves this computer.</p>\n          <form id="history-search-form" class="card form-grid">\n            <h2>Find an earlier conversation</h2>\n            <p>Search everything you have said and been told, back to the first day.</p>\n            <div>`);

swap(
  `          <p class="section-intro">\n            Notes your assistant can retrieve. Every note carries its source and\n            time.\n          </p>\n          <form id="memory-form" class="card">`,
  `          <form id="memory-form" class="card">\n            <h2>Something to remember</h2>\n            <p>Write down anything you would otherwise have to say again. Every note keeps a record of where it came from and when.</p>`);

swap(
  `<label for="memory-entity">About (optional: a person, place or thing)</label`,
  `<label for="memory-entity">Who or what this is about</label`);
swap(`placeholder="e.g. Mum" /><label for="memory-attribute">Which detail (optional)</label`,
  `placeholder="e.g. Mum — leave empty if it is about nobody in particular" /><label for="memory-attribute">Which detail</label`);
swap(`placeholder="e.g. phone number — a newer detail replaces the older one from that day on"`,
  `placeholder="e.g. phone number — leave empty unless one newer detail should replace an older one"`);

swap(
  `            <h3>Take facts elsewhere</h3>\n            <p>One fact per line, the format other assistants read and write. Bringing facts back in never makes a second copy of something already saved.</p>`,
  `            <h3>Take facts elsewhere</h3>\n            <p class="subtle">One note per line, in the plain form other assistants read and write. Bringing notes back in never makes a second copy of something already saved.</p>`);

swap(
  `          <div class="card">\n            <p id="memory-count" role="status"></p>`,
  `          <div class="card">\n            <h2>How much it keeps</h2>\n            <p>Set how many notes your assistant may hold at once, and move them between computers.</p>\n            <p id="memory-count" role="status"></p>`);
swap(
  `            <p>Imports merge saved facts. Identical facts are skipped; conflicting IDs reject the entire import. Review imported facts before using them.</p>`,
  `            <p class="subtle">Bringing notes in adds them to what is already here. A note that is already saved is skipped. If a whole file clashes with what you have, none of it is brought in, so nothing is quietly overwritten. Read what arrives before you rely on it.</p>`);

swap(
  `          <p class="section-intro">Install a single SKILL.md file. Bundled scripts and assets are not imported. Skills do not grant tool permissions; allowed-tools metadata is informational.</p>\n          <p>Enabled skills share their names and descriptions with the assistant. The assistant reads a selected skill's instructions when needed.</p>\n          <div class="card">\n            <label for="skill-policy">If a skill looks risky (a pasted key, instructions to send your data somewhere, or attempts to override the assistant's rules)</label>`,
  `          <p class="section-intro">A skill is a page of written instructions your assistant can follow — how you like a letter laid out, the steps for a monthly report. It knows the name of every skill you keep here, and reads the one it needs. A skill never grants permission to do anything; your rules still decide that.</p>\n          <div class="card">\n            <h2>When a skill looks risky</h2>\n            <p>Some skills arrive carrying a pasted key, telling the assistant to send your work somewhere, or trying to talk it out of your rules. Choose what should happen then.</p>\n            <label for="skill-policy">What to do</label>`);

swap(
  `            <p>Saving an edit creates a new version and keeps the currently active version. Choose a version and activate it when ready.</p>`,
  `            <p>Write the instructions out, or open a file someone sent you. Saving keeps the version already in use, so you can always go back to it.</p>`);
swap(`>Import SKILL.md into editor<`, `>Open a skill file<`);
swap(`<label for="skill-document">SKILL.md document</label>`, `<label for="skill-document">The instructions</label>`);
swap(`<label for="model-endpoint">API base URL</label>`, `<label for="model-endpoint">Web address of the service</label>`);

swap(
  `          <div class="card">\n            <label class="check-row"><input type="checkbox" id="documents-use" /> Use my documents when answering</label>`,
  `          <div class="card">\n            <h2>Answering from your documents</h2>\n            <p>While this is on, your assistant looks through the documents below before it answers, and says which one it took each line from.</p>\n            <label class="check-row"><input type="checkbox" id="documents-use" /> Use my documents when answering</label>`);

/* ---- 2. Names for the controls that had none, so every control can be read aloud. ---- */
for (const [needle, name] of [
  [`<input id="composer-media-file" type="file" class="sr-only"`, "Choose a picture or a sound file"],
  [`<input id="checkpoint-label" maxlength="120"`, "Name this checkpoint"],
  [`<input id="documents-file" type="file"`, "Choose documents to add"],
  [`<input id="knowledge-folder" type="text"`, "Folder to read"],
  [`<input id="snapshot-label" maxlength="120"`, "Name this snapshot"],
  [`<input id="local-model-name" maxlength="160"`, "Model name"],
]) swap(needle, `${needle} aria-label="${name}"`);

/* ---- 3. The composer's helper line and room meter share one quiet row under the box. ---- */
swap(
  `          <!-- Wave 6: how much room this conversation has used, and what it has cost\n               (public/token-meter.js). Quiet by default; the numbers open on click. -->\n          <div id="meter-row" class="meter-row" hidden>\n            <button id="meter-button" class="meter-button" type="button" aria-haspopup="true" aria-expanded="false">\n              <span class="meter-track"><span id="meter-fill" class="meter-fill"></span></span>\n              <span id="meter-text"></span>\n              <span id="meter-cost"></span>\n            </button>\n            <div id="meter-popover" class="meter-popover" hidden role="dialog" aria-label="This conversation"></div>\n          </div>\n          <p class="composer-note"><span id="voice-talk-status" class="meta" hidden></span></p>\n          <p class="composer-note"><span id="session-label">New conversation · tools leave a record</span></p>`,
  `          <p class="composer-note"><span id="voice-talk-status" class="meta" hidden></span></p>\n          <!-- Wave 8: the helper line and the room meter share one quiet row under the box. -->\n          <div class="composer-foot">\n            <p class="composer-note"><span id="session-label">New conversation · tools leave a record</span></p>\n            <!-- Wave 6: how much room this conversation has used, and what it has cost\n                 (public/token-meter.js). Quiet by default; the numbers open on click. -->\n            <div id="meter-row" class="meter-row" hidden>\n              <button id="meter-button" class="meter-button" type="button" aria-haspopup="true" aria-expanded="false" aria-label="How much room this conversation has left" data-t-label="composer.room">\n                <span class="meter-track"><span id="meter-fill" class="meter-fill"></span></span>\n                <span id="meter-text"></span>\n                <span id="meter-cost"></span>\n              </button>\n              <div id="meter-popover" class="meter-popover" hidden role="dialog" aria-label="This conversation"></div>\n            </div>\n          </div>`);
en["composer.room"] = "How much room this conversation has left";
fr["composer.room"] = "La place qu'il reste à cette conversation";

/* ---- 4. The localisation itself: every section intro and card title behind a key. ---- */
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 5).join("-");
let added = 0;
/* Split on the section openings themselves, so an empty section cannot swallow the next one. */
const marks = SECTIONS
  .map((view) => ({ view, at: html.indexOf(`<section id="${view}" class="view"`) }))
  .filter((m) => m.at >= 0)
  .sort((a, b) => a.at - b.at);
for (let i = marks.length - 1; i >= 0; i -= 1) {
  const { view, at } = marks[i];
  const stop = i + 1 < marks.length ? marks[i + 1].at : html.indexOf(`\n      </div>`, at);
  let block = html.slice(at, stop);
  for (const [re, kind] of [[/<p class="section-intro">([^<]+)<\/p>/g, "intro"], [/<h2>([^<]+)<\/h2>/g, "card"]]) {
    block = block.replace(re, (whole, text) => {
      const words = text.trim().replace(/\s+/g, " ");
      if (!words || whole.includes("data-t")) return whole;
      const key = `${view}.${kind}.${slug(words)}`;
      en[key] = words;
      if (!(key in fr)) fr[key] = words;
      added += 1;
      return whole.replace(/^<(p|h2)([^>]*)>/, `<$1$2 data-t="${key}">`);
    });
  }
  html = html.slice(0, at) + block + html.slice(stop);
}

writeFileSync(HTML, html);
writeFileSync(EN, JSON.stringify(en, null, 2) + "\n");
writeFileSync(FR, JSON.stringify(fr, null, 2) + "\n");
console.log(`${added} strings put behind a key; en.json now has ${Object.keys(en).length}.`);
