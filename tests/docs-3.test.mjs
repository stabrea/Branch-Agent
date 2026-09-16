import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { buildDocx } from "../dist/document-docx.js";
import { buildXlsx } from "../dist/document-xlsx.js";
import { buildPptx } from "../dist/document-pptx.js";
import { editPackage, unchangedParts } from "../dist/document-edit.js";
import { packZip, unpackRaw, entryText } from "../dist/document-package.js";
import { readDocument } from "../dist/document-readers.js";
import { blocksToHtml, blocksToMarkdown } from "../dist/document-write.js";
import { entityKey, fromNames, nounPhrases } from "../dist/knowledge-graph.js";
import { noVisionMessage } from "../dist/knowledge-pictures.js";
import { EphemeralDocuments } from "../dist/memory-ephemeral.js";
import { mirrorFolder, readOnlyRefusal } from "../dist/memory-mirror.js";

/** A stand-in model: it answers with whatever the test scripted, and records what it was shown. */
const scripted = (answer = "Answered.", extra = {}) => ({
  name: "docs3-fixture", requests: [],
  async complete(input) { this.requests.push(input); return { content: answer, toolCalls: [] }; },
  ...extra,
});
const seeing = (answer) => scripted(answer, { supportsImages: () => true });

async function fixture(t, provider) {
  const scratch = join(tmpdir(), "claude-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-docs3-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, root, workspace, context: app.runtime.context() };
}

// ---------------------------------------------------------------- writing Office files (A2145, A2263)

test("D1 a written Word file reads back with its headings, list, table and title", async () => {
  const bytes = buildDocx([
    { kind: "heading", level: 1, text: "Holiday plan" },
    { kind: "paragraph", text: "We leave on the fifth of June." },
    { kind: "list", ordered: true, items: ["Passports", "Tickets"] },
    { kind: "table", name: "", grid: [["Item", "Price"], ["Flights", "420"]] },
  ], "Trip notes");
  const read = readDocument(bytes, "trip.docx");
  assert.equal(read.type, "docx");
  assert.match(read.text, /^# Trip notes/, "the title is the first heading");
  assert.match(read.text, /# Holiday plan/);
  assert.match(read.text, /We leave on the fifth of June\./);
  assert.match(read.text, /Passports/);
  assert.deepEqual(read.tables[0].grid, [["Item", "Price"], ["Flights", "420"]]);
  const names = unpackRaw(bytes).map((entry) => entry.name);
  for (const part of ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/numbering.xml"])
    assert.ok(names.includes(part), `${part} is in the file`);
});

test("D2 a written spreadsheet keeps figures as figures and a formula with its worked-out value", async () => {
  const bytes = buildXlsx([
    { name: "Budget", rows: [["Item", "Total"], ["Flights", 420], ["Sum", { formula: "SUM(B2:B2)", value: 420 }]],
      table: "", headings: true, formats: ["plain", "money"] },
    { name: "Notes", rows: [["Booked already"]], table: "", headings: false, formats: [] },
  ]);
  const read = readDocument(bytes, "budget.xlsx");
  assert.deepEqual(read.tables.map((table) => table.name), ["Budget", "Notes"]);
  assert.deepEqual(read.tables[0].grid[2], ["Sum", "420"], "the reader sees the value the formula came to");
  const sheet = entryText(unpackRaw(bytes).find((entry) => entry.name === "xl/worksheets/sheet1.xml"));
  assert.match(sheet, /<f>SUM\(B2:B2\)<\/f><v>420<\/v>/, "the formula itself is kept, so the spreadsheet recalculates it");
  assert.match(sheet, /<c r="B2" s="2"><v>420<\/v><\/c>/, "a figure is written as a number in the shape asked for, not as words");
  assert.match(sheet, /<c r="A1" s="5" t="inlineStr">/, "and the heading row is marked as a heading");
});

test("D3 a written deck reads back slide by slide, with notes and a picture slide", async () => {
  const picture = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const bytes = buildPptx([
    { title: "Quarter review", bullets: ["Sales rose by nine per cent."], picture: "", notes: "Mention the new shop." },
    { title: "The chart", bullets: [], picture: "chart.png", notes: "" },
  ], new Map([["chart.png", picture]]));
  const read = readDocument(bytes, "review.pptx");
  assert.equal(read.pages, 2);
  assert.match(read.text, /Slide 1: Quarter review/);
  assert.match(read.text, /Sales rose by nine per cent\./);
  assert.match(read.text, /Notes: Mention the new shop\./);
  assert.match(read.text, /Slide 2: The chart/);
  const names = unpackRaw(bytes).map((entry) => entry.name);
  assert.ok(names.includes("ppt/media/image2.png"), "the picture is packed into the deck");
  assert.ok(names.includes("ppt/slideMasters/slideMaster1.xml"), "the master PowerPoint insists on is there");
  assert.match(entryText(unpackRaw(bytes).find((entry) => entry.name === "ppt/slides/_rels/slide2.xml.rels")),
    /Target="\.\.\/media\/image2\.png"/);
});

test("D4 Markdown and a web page carry the same blocks", () => {
  const blocks = [{ kind: "heading", level: 2, text: "Costs" }, { kind: "list", ordered: false, items: ["Fuel"] },
    { kind: "table", name: "", grid: [["A", "B"], ["1", "2"]] }];
  const markdown = blocksToMarkdown(blocks, "Trip");
  assert.match(markdown, /^# Trip\n\n## Costs\n\n- Fuel\n\n\| A \| B \|/);
  const html = blocksToHtml(blocks, "Trip");
  assert.match(html, /<h1>Trip<\/h1>/);
  assert.match(html, /<ul>\n {2}<li>Fuel<\/li>\n<\/ul>/);
  assert.match(html, /<th>A<\/th>/);
});

test("D5 documents.write saves into the workspace and refuses an unknown kind", async (t) => {
  const { app, workspace, context } = await fixture(t);
  const written = await app.registry.execute("documents.write", {
    path: "reports/trip.docx", title: "Trip", blocks: [{ kind: "paragraph", text: "We leave on Friday." }],
  }, context);
  assert.equal(written.format, "docx");
  assert.ok(written.bytes > 500);
  assert.match(written.limits.join(" "), /does not type in a document alongside someone else/);
  const back = readDocument(await readFile(join(workspace, "reports/trip.docx")), "trip.docx");
  assert.match(back.text, /We leave on Friday\./);
  await assert.rejects(() => app.registry.execute("documents.write", { path: "notes.zzz", blocks: [] }, context),
    /Name the file/);
});

// ---------------------------------------------------------------- editing keeps everything else (A2145)

test("D6 editing a Word file changes one part and keeps every other part byte for byte", () => {
  const before = buildDocx([
    { kind: "heading", level: 1, text: "Holiday plan" },
    { kind: "paragraph", text: "We leave on the fifth." },
    { kind: "table", name: "", grid: [["Item", "Price"], ["Flights", "420"]] },
  ], "Trip");
  const done = editPackage(before, "docx", [
    { op: "replace-text", find: "fifth", replaceWith: "sixth", all: true },
    { op: "append", blocks: [{ kind: "heading", level: 2, text: "Update" }] },
    { op: "update-table", table: 1, grid: [["Item", "Price"], ["Trains", "88"]] },
  ]);
  assert.equal(done.changes, 3);
  assert.deepEqual(done.partsTouched, ["word/document.xml"], "only the document part is rewritten");
  const kept = unchangedParts(before, done.bytes);
  for (const part of ["[Content_Types].xml", "_rels/.rels", "word/styles.xml", "word/numbering.xml", "word/_rels/document.xml.rels"])
    assert.ok(kept.includes(part), `${part} came back as the very same bytes`);
  const read = readDocument(done.bytes, "trip.docx");
  assert.match(read.text, /We leave on the sixth\./);
  assert.match(read.text, /## Update/);
  assert.deepEqual(read.tables[0].grid, [["Item", "Price"], ["Trains", "88"]]);
});

test("D7 a phrase split across differently formatted pieces is changed and reported", () => {
  const split = packZip([
    ["[Content_Types].xml", "<Types/>"],
    ["word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
      + "<w:p><w:r><w:t>The gate code is </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>4821</w:t></w:r></w:p>"
      + "</w:body></w:document>"],
  ].map(([name, body]) => ({ name, body })));
  const done = editPackage(split, "docx", [{ op: "replace-text", find: "code is 4821", replaceWith: "code is 9000", all: true }]);
  assert.equal(done.changes, 1);
  assert.match(done.notes.join(" "), /spread across differently formatted pieces/);
  assert.match(readDocument(done.bytes, "a.docx").text, /The gate code is 9000/);
});

test("D8 editing a spreadsheet replaces wording and adds a sheet; a change that matches nothing says so", () => {
  const before = buildXlsx([{ name: "Budget", rows: [["Item", "Total"], ["Flights", 420]], table: "", headings: true, formats: [] }]);
  const done = editPackage(before, "xlsx", [
    { op: "replace-text", find: "Flights", replaceWith: "Trains", all: true },
    { op: "add-sheet", sheet: { name: "Notes", rows: [["Booked already"]], table: "", headings: false, formats: [] } },
  ]);
  assert.equal(done.changes, 2);
  assert.ok(unchangedParts(before, done.bytes).includes("xl/styles.xml"), "the styles part is untouched");
  const read = readDocument(done.bytes, "budget.xlsx");
  assert.deepEqual(read.tables.map((table) => table.name), ["Budget", "Notes"]);
  assert.match(read.text, /Trains/);
  const nothing = editPackage(before, "xlsx", [{ op: "replace-text", find: "nowhere", replaceWith: "x", all: true }]);
  assert.equal(nothing.changes, 0);
  assert.match(nothing.notes.join(" "), /Nothing matched/);
});

test("D9 documents.edit writes the changed file back and reports how much was kept", async (t) => {
  const { app, workspace, context } = await fixture(t);
  await writeFile(join(workspace, "plan.docx"),
    buildDocx([{ kind: "paragraph", text: "Delivery is on Tuesday." }], "Plan"));
  const done = await app.registry.execute("documents.edit",
    { path: "plan.docx", changes: [{ op: "replace-text", find: "Tuesday", replaceWith: "Thursday" }] }, context);
  assert.equal(done.changes, 1);
  assert.ok(done.partsKeptExactly >= 4, "the untouched parts are counted for the owner");
  assert.match(readDocument(await readFile(join(workspace, "plan.docx")), "plan.docx").text, /Delivery is on Thursday\./);
  await assert.rejects(() => app.registry.execute("documents.edit",
    { path: "notes.txt", changes: [{ op: "replace-text", find: "a", replaceWith: "b" }] }, context),
    /Only Word .* and spreadsheet/);
});

// ---------------------------------------------------------------- pictures as documents (A0946)

test("D10 a picture is described once, indexed with a citation, and cached by its bytes", async (t) => {
  const { app, workspace, context } = await fixture(t, seeing("A photograph of a water meter reading 04821 cubic metres."));
  await mkdir(join(workspace, "meters"), { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
  await writeFile(join(workspace, "meters/meter.png"), png);
  await writeFile(join(workspace, "meters/copy.png"), png);
  const made = app.knowledgeParts.bases.create("local", { name: "Meters", sources: [{ kind: "folder", path: "meters" }] });
  const first = await app.registry.execute("knowledge.pictures", { collection: made.id }, context);
  assert.equal(first.described, 1, "the same bytes are only ever sent once");
  assert.equal(first.cached, 1, "the second copy came from what was already worked out");
  const found = await app.knowledgeParts.bases.search("local", { collection: made.id, query: "water meter reading" });
  assert.ok(found.length, "the description is searchable");
  assert.match(found[0].documentId, /meter\.png$/, "the citation points at the picture, not at a copy of the words");
  const again = await app.registry.execute("knowledge.pictures", { collection: made.id }, context);
  assert.equal(again.described, 0, "asking again costs nothing");
});

test("D11 with nothing that can see, describing pictures is refused plainly and nothing is sent", async (t) => {
  const { app, workspace, context } = await fixture(t, scripted("never asked"));
  await mkdir(join(workspace, "shots"), { recursive: true });
  await writeFile(join(workspace, "shots/screen.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const made = app.knowledgeParts.bases.create("local", { name: "Shots", sources: [{ kind: "folder", path: "shots" }] });
  const result = await app.registry.execute("knowledge.pictures", { collection: made.id }, context);
  assert.equal(result.described, 0);
  assert.equal(result.note, noVisionMessage);
  assert.match(result.note, /Pick a model that can see images/);
  assert.equal(app.runtime.models.plan("local", "").candidates[0].provider.requests.length, 0, "nothing was sent");
});

// ---------------------------------------------------------------- summaries (A1668, A2362)

test("D12 a summary cites its passages and is kept until the files change", async (t) => {
  const { app, workspace, context } = await fixture(t, scripted("- Staff get twenty days of leave [1]"));
  await mkdir(join(workspace, "hr"), { recursive: true });
  await writeFile(join(workspace, "hr/handbook.md"), "# Handbook\n\n## Holiday\n\nStaff get twenty days of paid leave each year.\n");
  const made = app.knowledgeParts.bases.create("local", { name: "HR", sources: [{ kind: "folder", path: "hr" }] });
  await app.knowledgeParts.bases.reindex("local", made.id);
  const first = await app.registry.execute("knowledge.summarise", { collection: made.id }, context);
  assert.equal(first.cached, false);
  assert.ok(first.citations.length, "every point can be checked against a passage");
  assert.match(first.summary, /\[1\]/);
  assert.match(first.summary, /Sources/);
  const asked = app.runtime.models.plan("local", "").candidates[0].provider.requests.length;
  const second = await app.registry.execute("knowledge.summarise", { collection: made.id }, context);
  assert.equal(second.cached, true, "the same passages are not summarised twice");
  assert.equal(app.runtime.models.plan("local", "").candidates[0].provider.requests.length, asked, "and nothing was sent again");
  await writeFile(join(workspace, "hr/handbook.md"), "# Handbook\n\n## Holiday\n\nStaff get twenty-five days now.\n");
  await app.knowledgeParts.bases.reindex("local", made.id);
  assert.notEqual(app.knowledgeParts.summaries.version("local", made.id), first.version, "a changed file changes the fingerprint");
  assert.equal((await app.registry.execute("knowledge.summarise", { collection: made.id }, context)).cached, false);
});

test("D13 when the model cannot be reached a summary still cites, and says why it reads as it does", async (t) => {
  const unreachable = scripted("", { async complete() { throw new Error("no route to the model"); } });
  const { app, workspace, context } = await fixture(t, unreachable);
  await mkdir(join(workspace, "hr"), { recursive: true });
  await writeFile(join(workspace, "hr/rules.md"), "# Rules\n\nInvoices are paid within thirty days.\n");
  const made = app.knowledgeParts.bases.create("local", { name: "Rules", sources: [{ kind: "folder", path: "hr" }] });
  await app.knowledgeParts.bases.reindex("local", made.id);
  const summary = await app.registry.execute("knowledge.summarise", { collection: made.id }, context);
  assert.ok(summary.citations.length);
  assert.match(summary.note, /could not be reached/);
  assert.match(summary.summary, /\[1\]/, "the opening of each passage still carries its number");
});

// ---------------------------------------------------------------- management (A1867, A2036)

test("D14 a knowledge base can be renamed, merged, split, saved out and brought back", async (t) => {
  const { app, workspace, context } = await fixture(t);
  await mkdir(join(workspace, "one"), { recursive: true });
  await mkdir(join(workspace, "two"), { recursive: true });
  await writeFile(join(workspace, "one/alpha.md"), "# Alpha\n\nThe boiler is serviced every March.\n");
  await writeFile(join(workspace, "two/beta.md"), "# Beta\n\nThe gate code is on the fob.\n");
  const first = app.knowledgeParts.bases.create("local", { name: "First",
    sources: [{ kind: "folder", path: "one" }, { kind: "folder", path: "two" }] });
  const second = app.knowledgeParts.bases.create("local", { name: "Second", sources: [] });
  await app.knowledgeParts.bases.reindex("local", first.id);

  const renamed = await app.registry.execute("knowledge.manage", { rename: { collection: first.id, name: "House" } }, context);
  assert.equal(renamed.renamed.name, "House");

  const split = await app.registry.execute("knowledge.manage",
    { split: { collection: first.id, folder: "two", name: "Gate" } }, context);
  assert.ok(split.split.moved > 0);
  assert.ok((await app.knowledgeParts.bases.search("local", { collection: split.split.collection, query: "gate code" })).length,
    "the passages moved and are still searchable");
  assert.equal((await app.knowledgeParts.bases.search("local", { collection: first.id, query: "gate code" })).length, 0,
    "and they are no longer in the one they came from");

  const merged = await app.registry.execute("knowledge.manage",
    { merge: { from: split.split.collection, into: second.id } }, context);
  assert.ok(merged.merged.moved > 0);
  assert.ok((await app.knowledgeParts.bases.search("local", { collection: second.id, query: "gate code" })).length);

  const saved = app.knowledgeParts.management.exportCollection("local", second.id);
  assert.ok(saved.documents > 0);
  const brought = app.knowledgeParts.management.importCollection("local", saved.bytes, "Brought back");
  assert.equal(brought.documents, saved.documents);
  assert.ok((await app.knowledgeParts.bases.search("local", { collection: brought.collection, query: "gate code" })).length,
    "a knowledge base brought back from a saved copy is searchable again");

  const sizes = app.knowledgeParts.management.sizes("local");
  assert.ok(sizes.find((size) => size.collection === second.id).characters > 0, "the size figures are real");
});

test("D15 refreshing from conversations proposes cards and adds nothing on its own", async (t) => {
  const { app, context } = await fixture(t, scripted(JSON.stringify({
    cards: [{ title: "Boiler service", body: "The boiler is serviced every March by Dane Heating.", sourceTurn: "said in passing", confidence: 0.8 }],
  })));
  const made = app.knowledgeParts.bases.create("local", { name: "House", sources: [] });
  const session = app.store.createSession("local");
  app.store.message(session, { role: "user", content: "Who services the boiler?" });
  app.store.message(session, { role: "assistant", content: "Dane Heating, every March." });
  const refreshed = await app.registry.execute("knowledge.refresh", { collection: made.id, conversations: 3 }, context);
  assert.equal(refreshed.staged.length, 1, "a suggestion was made");
  assert.equal(app.knowledgeParts.bases.one("local", made.id).documents, 0, "and nothing was added without the owner");
  app.store.review.decide("local", refreshed.staged[0].id, true);
  assert.equal(app.knowledgeParts.bases.one("local", made.id).documents, 1, "accepting it puts it in the knowledge base");
  assert.ok((await app.knowledgeParts.bases.search("local", { collection: made.id, query: "boiler serviced" })).length);
});

// ---------------------------------------------------------------- the light knowledge graph (A0994)

test("D16 names found on this computer become entities and links between them", () => {
  const names = nounPhrases("Dane Heating services the boiler at Rowan Cottage every March.");
  assert.ok(names.includes("Dane Heating"));
  assert.ok(names.includes("Rowan Cottage"));
  assert.equal(entityKey("Dane  Heating"), entityKey("dane heating"), "one name written two ways is one entity");
  const read = fromNames(["Dane Heating", "Rowan Cottage"]);
  assert.equal(read.relations.length, 1);
  assert.equal(read.relations[0].relation, "mentioned with");
});

test("D17 the map answers for one name with citations, and one hop finds its passages", async (t) => {
  const { app, workspace, context } = await fixture(t);
  await mkdir(join(workspace, "house"), { recursive: true });
  await writeFile(join(workspace, "house/boiler.md"),
    "# Boiler\n\nDane Heating services the boiler at Rowan Cottage every March.\n");
  const made = app.knowledgeParts.bases.create("local", { name: "House", sources: [{ kind: "folder", path: "house" }] });
  await app.knowledgeParts.bases.reindex("local", made.id);
  const built = await app.registry.execute("knowledge.map", { collection: made.id }, context);
  assert.ok(built.entities > 0 && built.links > 0);
  assert.match(built.how, /no model read them/);

  const around = await app.registry.execute("knowledge.graph", { collection: made.id, entity: "Dane Heating" }, context);
  assert.equal(around.found, true);
  assert.ok(around.links.length);
  assert.ok(around.links[0].citation.document, "every link says which file it came from");
  assert.match(around.limits.join(" "), /do not say how the two are related/, "the limit is stated plainly");
  assert.ok(around.entities.some((entity) => entity.name === "Rowan Cottage"));

  const missing = await app.registry.execute("knowledge.graph", { collection: made.id, entity: "Nobody At All" }, context);
  assert.equal(missing.found, false);
  assert.match(missing.limits.join(" "), /Nothing in the map is called/);

  const hopped = app.knowledgeParts.graph.passagesAround("local", made.id, "Dane Heating", 5);
  assert.ok(hopped.length, "a hop through the map reaches the passages behind it");
  assert.match(hopped[0].text, /Dane Heating/);
  assert.ok(app.retrieval.list().some((one) => one.id === "knowledge-graph"), "and it sits beside the other retrievers");
});

// ---------------------------------------------------------------- memory (A0650, A1117, A2185)

test("D18 a fact from a conversation is later found again with the knowledge base as its source", async (t) => {
  const { app, workspace, context } = await fixture(t);
  await mkdir(join(workspace, "house"), { recursive: true });
  const made = app.knowledgeParts.bases.create("local", { name: "House", sources: [{ kind: "folder", path: "house" }] });
  // What was said in a conversation, written up and accepted exactly as the review screen does it.
  const proposal = app.store.review.propose("local", { kind: "knowledge-card", source: "Suggested after a conversation",
    note: "Add it", card: { title: "Boiler service", body: "Dane Heating services the boiler every March.", collection: made.id } });
  app.store.review.decide("local", proposal.id, true);
  const answered = await app.retrieval.search("local", "who services the boiler");
  assert.ok(answered.passages.length, "the fact comes back when it is next needed");
  assert.equal(answered.passages[0].from, "knowledge", "and the knowledge base is named as where it came from");
  assert.match(answered.passages[0].text, /Dane Heating/);
  const cited = await app.knowledgeParts.bases.contextFor("local", "who services the boiler");
  assert.ok(cited === null || /Sources/.test(cited.text));
  assert.ok((await app.registry.execute("knowledge.search", { query: "boiler" }, context)).results.length);
});

test("D19 text pasted in for one job is searchable while it runs and gone when it ends", async (t) => {
  const { app, context } = await fixture(t);
  const added = await app.registry.execute("scratch.text.add",
    { name: "contract.txt", text: "Clause four says the deposit is returned within twenty-eight days." }, context);
  assert.ok(added.passages > 0);
  assert.match(added.note, /goes when the job ends/);
  const found = await app.registry.execute("scratch.text.search", { query: "deposit returned" }, context);
  assert.ok(found.results.length);
  assert.equal((await app.registry.execute("scratch.text.list", {}, context)).documents.length, 1);
  assert.ok(app.retrieval.list().some((one) => one.id === "task-text"));
  // The store on its own, so the "dropped at the end" promise is checked without a whole run.
  const store = new EphemeralDocuments();
  store.add("run-1", { name: "a.txt", text: "The deposit is returned in twenty-eight days." });
  assert.ok(store.search("run-1", { query: "deposit" }).results.length);
  assert.ok(store.release("run-1") > 0);
  assert.equal(store.search("run-1", { query: "deposit" }).results.length, 0, "nothing of it is left");
  assert.equal(store.tasks, 0);
  assert.equal(store.latestTask, "");
});

test("D20 what is remembered is mirrored into the workspace and that folder is read-only", async (t) => {
  const { app, workspace, context } = await fixture(t);
  await app.registry.execute("memory.put", { text: "Prefers tea to coffee", source: "said so", kind: "preference" }, context);
  await app.registry.execute("memory.put", { text: "The gate code is on the fob", source: "said so", kind: "fact-about-world" }, context);
  const written = await app.registry.execute("memory.mirror", {}, context);
  assert.equal(written.wrote, true);
  assert.equal(written.facts, 2);
  const preference = await readFile(join(workspace, mirrorFolder, "preference.md"), "utf8");
  assert.match(preference, /Prefers tea to coffee/);
  assert.match(preference, /Do not edit/);
  assert.match(await readFile(join(workspace, mirrorFolder, "README.md"), "utf8"), /Obsidian/);
  // Asked again with nothing changed, it says so rather than rewriting the folder.
  assert.equal((await app.registry.execute("memory.mirror", {}, context)).wrote, false);
  // And the assistant's own file tools refuse to change it.
  await assert.rejects(() => app.registry.execute("files.write",
    { path: `${mirrorFolder}/preference.md`, content: "mine now" }, context), new RegExp("undone the next time"));
  assert.match(readOnlyRefusal, /Memory screen/);
  assert.match((await readFile(join(workspace, mirrorFolder, "preference.md"), "utf8")), /Prefers tea to coffee/);
  // A fact removed leaves no note behind it.
  const facts = app.store.list("memory", "local");
  for (const fact of facts) app.store.delete("memory", "local", fact.id);
  const empty = await app.registry.execute("memory.mirror", { force: true }, context);
  assert.equal(empty.facts, 0);
  await assert.rejects(() => readFile(join(workspace, mirrorFolder, "preference.md"), "utf8"));
});

// ---------------------------------------------------------------- retention (item 7)

test("D21 a collection over its limits is proposed, never quietly emptied", async (t) => {
  const { app, workspace } = await fixture(t);
  await mkdir(join(workspace, "many"), { recursive: true });
  for (const name of ["a", "b", "c"])
    await writeFile(join(workspace, `many/${name}.md`), `# ${name}\n\nA note about ${name}.\n`);
  const made = app.knowledgeParts.bases.create("local", { name: "Many", sources: [{ kind: "folder", path: "many" }] });
  await app.knowledgeParts.bases.reindex("local", made.id);
  assert.deepEqual(app.knowledgeParts.management.proposeRetention("local").proposals, [], "no limits set means nothing is proposed");
  app.knowledgeParts.management.configure("local", { maximumDocuments: 1 });
  const checked = app.knowledgeParts.management.proposeRetention("local");
  assert.equal(checked.proposals.length, 1);
  assert.match(checked.proposals[0].note, /Save it out first/);
  assert.equal(app.knowledgeParts.bases.one("local", made.id).documents, 3, "and nothing was removed");
  assert.equal(app.store.review.proposals("local", "pending").length, 1, "it waits in the review queue");
});

// ---------------------------------------------------------------- the catalog and the routes

test("D22 every new tool falls in a real toolbox and the panel's routes answer", async (t) => {
  const { app } = await fixture(t);
  const { inferToolGroup } = await import("../dist/catalog.js");
  const added = ["documents.write", "documents.edit", "knowledge.summarise", "knowledge.graph", "knowledge.map",
    "knowledge.pictures", "knowledge.manage", "knowledge.refresh", "memory.mirror",
    "scratch.text.add", "scratch.text.search", "scratch.text.list"];
  for (const name of added) {
    assert.ok(app.registry.names().includes(name), `${name} is registered`);
    assert.notEqual(inferToolGroup(name), "other", `${name} has a toolbox of its own`);
  }
  const { knowledgeExtrasApi } = await import("../dist/knowledge-more.js");
  const view = await knowledgeExtrasApi(app.knowledgeParts, app.store, "local", "GET", "/api/knowledge/extras", async () => ({}));
  assert.ok(Array.isArray(view.graphs) && Array.isArray(view.sizes));
  assert.equal(typeof view.picturesReady, "boolean");
  assert.equal(await knowledgeExtrasApi(app.knowledgeParts, app.store, "local", "GET", "/api/knowledge/nowhere", async () => ({})), undefined);
});
