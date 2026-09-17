import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { Retrieval, lexicalRerank } from "../dist/retrieval.js";
import { mergePassages, orderedStages, pipelineFor } from "../dist/retrieval-pipeline.js";
import { filterSql, nothingMatchedNote, rowPasses } from "../dist/retrieval-filters.js";
import { chooseVectorStore, openVectorFile } from "../dist/vector-store-file.js";
import { SqliteVectors } from "../dist/vector-store.js";
import { ContextProviders, RepositoryContextProvider, providerFrom } from "../dist/context-providers.js";

/**
 * Wave 9, bucket 7: a retrieval you can narrow before it is ranked, an order for the places Branch
 * looks that the owner names, and a second real place for the lists of numbers. Everything here is
 * fakes on this computer: no model service, no network, no vector service.
 */

/** A conversation partner that answers in one line and offers nothing else. */
const scripted = (answer = "Answered.") => ({
  name: "retrieval-2-fixture", requests: [],
  async complete(input) { this.requests.push(input.messages.length); return { content: answer, toolCalls: [] }; },
});

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-retrieval-2-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "notes"), { recursive: true });
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: scripted() });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, root, workspace };
}

const handbook = `# Handbook

## Invoices

Every invoice from a supplier is paid within thirty days of the date on it.
`;
const thisYear = "date,supplier,amount\n2026-02-01,Dane Heating,invoice 480\n";
const lastYear = "date,supplier,amount\n2025-02-01,Dane Heating,invoice 120\n";

/** A knowledge base over three files: one set of notes and two tables, one of them added later. */
async function library(t) {
  const { app, root, workspace } = await fixture(t);
  await writeFile(join(workspace, "notes", "handbook.md"), handbook, "utf8");
  await writeFile(join(workspace, "notes", "invoices-2025.csv"), lastYear, "utf8");
  const made = app.knowledgeBases.create("local", { name: "Work", sources: [{ kind: "folder", path: "notes" }] });
  await app.knowledgeBases.reindex("local", made.id);
  const between = new Date(Date.now() + 5).toISOString();
  await new Promise((resolve) => setTimeout(resolve, 12));
  await writeFile(join(workspace, "notes", "invoices-2026.csv"), thisYear, "utf8");
  await app.knowledgeBases.reindex("local", made.id);
  return { app, root, workspace, collection: made.id, between };
}

const names = (hits) => [...new Set(hits.map((hit) => hit.documentName))].sort();

test("V1 each filter narrows what comes back, and two together narrow it further", async (t) => {
  const { app, collection, between } = await library(t);
  const query = "invoice supplier Dane Heating";

  const everything = await app.knowledgeBases.search("local", { collection, query, limit: 10 });
  assert.deepEqual(names(everything), ["handbook.md", "invoices-2025.csv", "invoices-2026.csv"],
    "with no filter all three files can answer");

  const tablesOnly = await app.knowledgeBases.search("local", { collection, query, limit: 10, filter: { kinds: ["csv"] } });
  assert.deepEqual(names(tablesOnly), ["invoices-2025.csv", "invoices-2026.csv"], "the kind filter drops the notes");

  const oneFile = await app.knowledgeBases.search("local", { collection, query, limit: 10, filter: { files: ["notes/invoices-2025.csv"] } });
  assert.deepEqual(names(oneFile), ["invoices-2025.csv"], "the file filter keeps one file");

  const recent = await app.knowledgeBases.search("local", { collection, query, limit: 10, filter: { changedAfter: between } });
  assert.deepEqual(names(recent), ["invoices-2026.csv"], "the date filter keeps only what changed since");

  const both = await app.knowledgeBases.search("local", { collection, query, limit: 10, filter: { kinds: ["csv"], changedAfter: between } });
  assert.deepEqual(names(both), ["invoices-2026.csv"], "a kind and a date together are both required");
  assert.ok(both.length < tablesOnly.length, "two filters really do narrow it further than one");

  const folder = await app.knowledgeBases.search("local", { collection, query, limit: 10, filter: { files: ["notes"] } });
  assert.deepEqual(names(folder), ["handbook.md", "invoices-2025.csv", "invoices-2026.csv"], "a folder matches everything under it");
});

test("V2 a filter that matches nothing says so rather than answering from everything", async (t) => {
  const { app, collection } = await library(t);
  const query = "invoice supplier Dane Heating";

  const none = await app.knowledgeBases.searchWithNote("local", { collection, query, limit: 10, filter: { kinds: ["pptx"] } });
  assert.deepEqual(none.hits, [], "nothing is answered from outside the filter");
  assert.match(none.note, /Nothing you have matches that filter/);
  assert.match(none.note, /pptx/, "the sentence names what was asked for");
  assert.match(none.note, /did not widen the search/, "and says plainly that it did not widen out");

  const unknown = await app.knowledgeBases.searchWithNote("local", { query, limit: 10, filter: { collections: ["Invoices I never made"] } });
  assert.deepEqual(unknown.hits, []);
  assert.match(unknown.note, /no knowledge base called "Invoices I never made"/);

  // The plain list still answers the old way, so nothing that already called `search` changed.
  assert.deepEqual(await app.knowledgeBases.search("local", { collection, query, filter: { kinds: ["pptx"] } }), []);
  const unfiltered = await app.knowledgeBases.searchWithNote("local", { collection, query, limit: 10 });
  assert.equal(unfiltered.note, "", "an ordinary search has nothing to add");
  assert.ok(unfiltered.hits.length > 0);
});

test("V3 the filter is applied to the plain scan as well as to full-text search", async (t) => {
  const { app, collection } = await library(t);
  // A question whose words are in no passage: full-text search finds nothing and the plain scan
  // takes over. That is exactly where a filter used to be lost.
  const wandered = await app.knowledgeBases.searchWithNote("local", {
    collection, query: "zzzz nothing at all like this", limit: 10, filter: { kinds: ["pptx"] },
  });
  assert.deepEqual(wandered.hits, [], "the fallback scan is filtered too");
  assert.match(wandered.note, /Nothing you have matches that filter/);

  // And the SQL itself: the clause is built whichever branch asks for it.
  const built = filterSql({ kinds: ["csv"], changedAfter: "2026-01-01" }, []);
  assert.match(built.clause, /^ AND /);
  assert.equal(built.needsDocuments, true, "a date filter reads the table that knows when a file changed");
  assert.ok(built.params.length >= 3);
  assert.equal(rowPasses({ kinds: ["csv"] }, { docId: "a/b.csv", docName: "b.csv", changedAt: "2026-05-05" }), true);
  assert.equal(rowPasses({ kinds: ["csv"] }, { docId: "a/b.md", docName: "b.md", changedAt: "2026-05-05" }), false);
  assert.match(nothingMatchedNote({ kinds: ["pdf"] }, ["Work"]), /of kind pdf/);
});

/** A retriever that always answers the same passages and remembers what it was asked for. */
function fakeRetriever(id, passages, order) {
  return {
    id, label: id,
    asked: [],
    async retrieve(owner, query, limit) {
      order.push(id);
      this.asked.push(limit);
      return passages.map((passage) => ({ ...passage, from: id }));
    },
  };
}
const passagesFor = (id, count, score) => Array.from({ length: count }, (unused, at) => ({
  key: `${id}:${at}`, source: `${id} source ${at}`, text: `invoice passage ${at} from ${id}`, score: score - at * 0.01,
}));

async function retrievalWith(t, order = []) {
  const { app } = await fixture(t);
  const made = new Retrieval(app.store, "local", undefined);
  const first = fakeRetriever("papers", passagesFor("papers", 6, 0.9), order);
  const second = fakeRetriever("notes", passagesFor("notes", 6, 0.8), order);
  const third = fakeRetriever("pasted", passagesFor("pasted", 6, 0.7), order);
  for (const retriever of [first, second, third]) made.add(retriever);
  return { app, retrieval: made, retrievers: { first, second, third } };
}

test("V4 with no pipeline written down, a search returns exactly what it returned before", async (t) => {
  const { retrieval, retrievers } = await retrievalWith(t);
  const settings = retrieval.settings("local");
  const query = "invoice passage";

  // The behaviour as it was: every retriever asked at once with `candidates`, the answers merged
  // best-score-first with the first of a repeated key winning, cut to `candidates`, then the word
  // rerank. Worked here independently of the code under test, then compared.
  const gathered = [];
  for (const retriever of [retrievers.first, retrievers.second, retrievers.third])
    gathered.push(...(await retriever.retrieve("local", query, settings.candidates)));
  const merged = new Map();
  for (const passage of gathered.sort((a, b) => b.score - a.score))
    if (!merged.has(passage.key)) merged.set(passage.key, passage);
  const asBefore = lexicalRerank(query, [...merged.values()].slice(0, settings.candidates), settings.keep);

  const now = await retrieval.search("local", query);
  assert.deepEqual(now.passages, asBefore, "the default answer is the old answer, passage for passage");
  assert.equal(now.pipeline, "default");
  assert.deepEqual(now.stages, []);
  assert.deepEqual(retrievers.first.asked.slice(-1), [settings.candidates], "and every retriever is still asked for the same number");

  // Naming "default" explicitly, and naming a pipeline nobody wrote, both fall back to the same.
  assert.deepEqual((await retrieval.search("local", query, undefined, { pipeline: "default" })).passages, asBefore);
  assert.deepEqual((await retrieval.search("local", query, undefined, { pipeline: "nobody wrote this" })).passages, asBefore);
  assert.equal(pipelineFor({ pipelines: [], byCollection: {} }, { pipeline: "default" }), null);
});

test("V5 a named pipeline runs its stages in order and every cap holds", async (t) => {
  const order = [];
  const { retrieval, retrievers } = await retrievalWith(t, order);
  retrieval.configurePipelines("local", {
    pipelines: [{ name: "pasted first", stages: [
      { retriever: "pasted", cap: 4 },
      { retriever: "notes", cap: 2 },
      { retriever: "papers", cap: 1 },
      { retriever: "rerank", cap: 3 },
    ] }],
    byCollection: { Work: "pasted first" },
  });
  order.length = 0;
  const run = await retrieval.search("local", "invoice passage", undefined, { pipeline: "pasted first" });

  assert.deepEqual(order, ["pasted", "notes", "papers"], "the steps ran in the order they were written");
  assert.deepEqual(run.stages.map((stage) => [stage.retriever, stage.cap, stage.found]),
    [["pasted", 4, 4], ["notes", 2, 2], ["papers", 1, 1], ["rerank", 3, 3]],
    "each step brought back exactly its ceiling, and the rerank kept its own");
  assert.deepEqual(retrievers.third.asked.slice(-1), [4], "a step asks for no more than its ceiling");
  assert.deepEqual(retrievers.second.asked.slice(-1), [2]);
  assert.equal(run.pipeline, "pasted first");
  assert.equal(run.passages.length, 3, "the rerank's ceiling is what comes back");
  for (const passage of run.passages)
    assert.ok(["pasted", "notes", "papers"].includes(passage.from));

  // A knowledge base pointed at that pipeline picks it up without naming it.
  const byName = await retrieval.search("local", "invoice passage", undefined, { collection: "Work" });
  assert.equal(byName.pipeline, "pasted first");

  // A step naming something Branch has no retriever for is said plainly and the rest still runs.
  retrieval.configurePipelines("local", { pipelines: [{ name: "typo", stages: [
    { retriever: "papres", cap: 3 }, { retriever: "notes", cap: 2 }, { retriever: "rerank", cap: 2 }] }] });
  const typo = await retrieval.search("local", "invoice passage", undefined, { pipeline: "typo" });
  assert.match(typo.note, /is not one of the places Branch can look/);
  assert.equal(typo.passages.length, 2, "the rest of the pipeline still answered");

  assert.deepEqual(orderedStages({ name: "x", stages: [{ retriever: "notes", cap: 2 }] }, 5),
    [{ retriever: "notes", cap: 2 }, { retriever: "rerank", cap: 5 }],
    "a pipeline that forgets the rerank still ends with one");
  assert.equal(mergePassages([{ key: "a", score: 1 }, { key: "a", score: 0.2 }, { key: "b", score: 0.5 }], 9).length, 2);
});

test("V6 a citation still names its source after the pipeline and the rerank", async (t) => {
  const { app, collection } = await library(t);
  const hits = await app.knowledgeBases.search("local", { collection, query: "invoice paid within thirty days", limit: 3 });
  assert.ok(hits.length > 0);
  for (const hit of hits) {
    assert.equal(hit.collectionName, "Work", "the knowledge base is still named");
    assert.ok(hit.documentName.length > 0, "and so is the file");
    assert.equal(typeof hit.chunkId, "string");
  }
  assert.ok(hits.some((hit) => hit.documentName === "handbook.md" && /thirty days/.test(hit.text)));

  // And through a named pipeline, where a stage could have rebuilt the passages and lost the key.
  const order = [];
  const { retrieval } = await retrievalWith(t, order);
  retrieval.configurePipelines("local", { pipelines: [{ name: "keep sources", stages: [
    { retriever: "papers", cap: 3 }, { retriever: "notes", cap: 3 }, { retriever: "rerank", cap: 2 }] }] });
  const run = await retrieval.search("local", "invoice passage", undefined, { pipeline: "keep sources" });
  assert.equal(run.passages.length, 2);
  for (const passage of run.passages) {
    assert.match(passage.source, /source \d/, "every passage still says where it came from");
    assert.ok(passage.key.startsWith(`${passage.from}:`), "and still carries the key that maps it back");
  }
});

test("V7 the second place for the vectors round-trips, and refuses plainly when it is not reachable", async (t) => {
  const { app, root } = await fixture(t);
  const shipped = app.knowledgeBases.vectors;
  const vector = Float32Array.from([1, 0]);
  await shipped.upsert("local", [{ collection: "c", docId: "d", chunkId: "k1", model: "m", vector, textHash: "h1" }]);

  // Reachable: a file of the owner's own, in a folder that does not exist yet.
  const path = join(root, "vectors", "mine.db").replaceAll("\\", "/");
  const opened = openVectorFile(path);
  assert.ok(opened.backend, "a missing folder is made rather than refused");
  assert.match(opened.backend.name, /a database file you chose/);
  assert.equal(await opened.backend.upsert("local", [
    { collection: "c", docId: "d", chunkId: "k1", model: "m", vector, textHash: "h1" },
    { collection: "c", docId: "d", chunkId: "k2", model: "m", vector: Float32Array.from([0, 1]), textHash: "h2" },
  ]), 2);
  const found = await opened.backend.search("local", "c", vector, 5);
  assert.equal(found[0].chunkId, "k1", "what went in comes back out, best first");
  assert.equal(await opened.backend.count("local", "c"), 2);
  assert.equal(opened.backend.countNow("local", "c"), 2, "and the panel can ask without waiting");
  assert.deepEqual([...(await opened.backend.fingerprints("local", "c", "m"))], [["k1", "h1"], ["k2", "h2"]]);
  assert.equal(await opened.backend.removeDocument("local", "c", "d"), 2);
  opened.backend.close();

  // Not reachable: a path through something that is not a folder, and a path that is not a full one.
  await writeFile(join(root, "in-the-way"), "not a folder", "utf8");
  const blocked = openVectorFile(join(root, "in-the-way", "deeper", "mine.db"));
  assert.ok(blocked.refusal, "an unreachable file is refused, not thrown");
  assert.match(blocked.refusal, /could not open/);
  assert.match(blocked.refusal, /using its own database instead/);
  assert.match(blocked.refusal, /Nothing you have already read has been lost/);
  assert.match(openVectorFile("vectors.db").refusal, /is not a full path/);
  assert.match(openVectorFile("  ").refusal, /No file was named/);

  // The refusal keeps the shipped store and every vector already in it.
  const fallen = chooseVectorStore({ vectorsIn: "file", vectorsFile: join(root, "in-the-way", "x.db") }, shipped);
  assert.equal(fallen.backend, shipped, "Branch carries on with its own database");
  assert.match(fallen.note, /could not open/);
  assert.equal(await shipped.count("local", "c"), 1, "and nothing in it was lost");
  assert.equal(chooseVectorStore({ vectorsIn: "database", vectorsFile: "" }, shipped).note, "");
});

test("V8 choosing the second place moves where new vectors go and says so on the panel", async (t) => {
  const { app, root } = await fixture(t);
  const path = join(root, "chosen", "vectors.db").replaceAll("\\", "/");
  const answer = app.knowledgeBases.chooseVectorStore("local", { vectorsIn: "file", vectorsFile: path });
  assert.equal(answer.note, "");
  assert.match(answer.backend, /a database file you chose/);
  assert.match(app.knowledgeBases.view("local").backend, /a database file you chose/);
  assert.deepEqual(app.knowledgeBases.view("local").vectorStore, { vectorsIn: "file", vectorsFile: path });
  assert.ok(app.knowledgeBases.vectors instanceof SqliteVectors, "the shipped comparison is reused against the new file");

  const refused = app.knowledgeBases.chooseVectorStore("local", { vectorsIn: "file", vectorsFile: "not-a-full-path.db" });
  assert.match(refused.note, /is not a full path/);
  assert.equal(app.knowledgeBases.view("local").backendNote, refused.note, "the panel shows the same sentence");
  assert.equal(app.knowledgeBases.chooseVectorStore("local", { vectorsIn: "database" }).note, "",
    "and going back to Branch's own database lets go of the file");
});

test("V9 what is put in front of a task is a list of providers, in the order it always used", async (t) => {
  const asked = [];
  const providers = new ContextProviders();
  const block = (id) => ({ text: `from ${id}`, sources: [id], citations: [] });
  providers.add(providerFrom("knowledge", "Your knowledge bases", async () => { asked.push("knowledge"); return null; }));
  providers.add(providerFrom("documents", "Your documents", async () => { asked.push("documents"); return block("documents"); }));
  providers.add(providerFrom("never", "Never reached", async () => { asked.push("never"); return block("never"); }));

  assert.deepEqual(await providers.contextFor("local", "anything"), block("documents"));
  assert.deepEqual(asked, ["knowledge", "documents"], "the first with something to say wins, and the rest are not asked");
  assert.deepEqual(providers.list(), [
    { id: "knowledge", label: "Your knowledge bases" },
    { id: "documents", label: "Your documents" },
    { id: "never", label: "Never reached" },
  ]);

  // A provider that fails is treated as having nothing to say; the task is never failed by it.
  const fragile = new ContextProviders();
  fragile.add(providerFrom("broken", "Broken", async () => { throw new Error("the disk went away"); }));
  fragile.add(providerFrom("documents", "Your documents", async () => block("documents")));
  assert.deepEqual(await fragile.contextFor("local", "anything"), block("documents"));
  assert.equal(await new ContextProviders().contextFor("local", "anything"), null);
});

test("V10 the two providers that already existed behave exactly as the expression they replaced", async (t) => {
  const { app, workspace } = await fixture(t);
  await writeFile(join(workspace, "notes", "handbook.md"), handbook, "utf8");
  const made = app.knowledgeBases.create("local", { name: "Work", sources: [{ kind: "folder", path: "notes" }] });
  await app.knowledgeBases.reindex("local", made.id);
  app.knowledgeBases.attach("local", made.id, true);

  const prompt = "how soon is an invoice paid";
  const asBefore = (await app.knowledgeBases.contextFor("local", prompt).catch(() => null))
    ?? await app.documents.contextFor("local", prompt);
  const now = await app.runtime.documents.contextFor("local", prompt);
  assert.deepEqual(now, asBefore, "the list of providers gives what the old expression gave");
  assert.ok(now.text.includes("thirty days"));
  assert.deepEqual(app.contextProviders.list().map((entry) => entry.id), ["knowledge", "documents", "repository"]);

  // The one switch still turns all of them off together.
  app.documents.configure("local", { useDocuments: false });
  assert.equal(await app.runtime.documents.contextFor("local", prompt), null);
});

test("V11 the files of this project can be named in front of a task, and are off until asked for", async (t) => {
  const ranked = {
    calls: [],
    async rank(request, limit) {
      this.calls.push({ request, limit });
      return { considered: 9, files: [
        { path: "src/invoices.ts", language: "typescript", score: 3, why: "the words you used appear here", symbols: ["payInvoice"] },
        { path: "src/ledger.ts", language: "typescript", score: 1, why: "it is connected to a file that matches", symbols: [] },
      ] };
    },
  };
  let settings = { repositoryContext: false, repositoryContextFiles: 5 };
  const provider = new RepositoryContextProvider(ranked, () => settings);
  assert.equal(await provider.provide("local", "where is an invoice paid"), null, "off until it is asked for");
  assert.deepEqual(ranked.calls, [], "and nothing is even read while it is off");

  settings = { repositoryContext: true, repositoryContextFiles: 2 };
  const found = await provider.provide("local", "where is an invoice paid");
  assert.deepEqual(ranked.calls, [{ request: "where is an invoice paid", limit: 2 }]);
  assert.match(found.text, /\[1\] src\/invoices\.ts \(typescript\) — the words you used appear here\. It declares payInvoice\./);
  assert.match(found.text, /No names were found in it\./);
  assert.deepEqual(found.sources, ["src/invoices.ts", "src/ledger.ts"]);
  assert.equal(found.citations.length, 2, "every file named carries a numbered source");
  assert.equal(found.citations[0].title, "src/invoices.ts");

  const silent = new RepositoryContextProvider({ async rank() { return { files: [], considered: 0 }; } }, () => settings);
  assert.equal(await silent.provide("local", "nothing matches"), null);
  const broken = new RepositoryContextProvider({ async rank() { throw new Error("no workspace"); } }, () => settings);
  assert.equal(await broken.provide("local", "anything"), null, "a project that cannot be read is simply quiet");
});

test("V12 the switch for naming project files is saved and read back through its route", async (t) => {
  const { startServer } = await import("../dist/server.js");
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method, headers: { origin: server.url, authorization: `Bearer ${server.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.json();
  };
  const before = await api("GET", "/api/retrieval");
  assert.equal(before.repositoryContext, false);
  assert.deepEqual(before.providers.map((entry) => entry.id), ["knowledge", "documents", "repository"]);
  assert.deepEqual(before.pipelines, []);
  assert.deepEqual(before.byCollection, {});

  const saved = await api("POST", "/api/retrieval/context", { repositoryContext: true, repositoryContextFiles: 3 });
  assert.deepEqual(saved, { repositoryContext: true, repositoryContextFiles: 3 });
  const after = await api("GET", "/api/retrieval");
  assert.equal(after.repositoryContext, true);
  assert.equal(after.repositoryContextFiles, 3);

  // The named orders and the filter both travel over the same routes the panel uses.
  const pipelines = await api("POST", "/api/retrieval/pipelines", {
    pipelines: [{ name: "notes first", stages: [{ retriever: "memory", cap: 2 }, { retriever: "rerank", cap: 2 }] }],
    byCollection: { Work: "notes first" },
  });
  assert.deepEqual(pipelines.pipelines[0].stages[0], { retriever: "memory", cap: 2 });
  assert.equal((await api("GET", "/api/retrieval")).byCollection.Work, "notes first");
  const searched = await api("POST", "/api/retrieval/search", { query: "anything at all", pipeline: "notes first" });
  assert.equal(searched.pipeline, "notes first");
  assert.deepEqual(searched.stages.map((stage) => stage.retriever), ["memory", "rerank"]);
});

test("V13 a pipeline chosen on a knowledge base's card is found by its id or by its name", async (t) => {
  const { startServer } = await import("../dist/server.js");
  const { app, root, collection } = await library(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method, headers: { origin: server.url, authorization: `Bearer ${server.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.json();
  };
  // Exactly what the card writes: keyed by the knowledge base's id, never by its name.
  await api("POST", "/api/retrieval/pipelines", {
    pipelines: [{ name: "notes first", stages: [{ retriever: "memory", cap: 2 }, { retriever: "rerank", cap: 2 }] }],
    byCollection: { [collection]: "notes first" },
  });
  assert.equal((await api("POST", "/api/retrieval/search", { query: "invoice", collection })).pipeline,
    "notes first", "found by the id the card wrote");
  assert.equal((await api("POST", "/api/retrieval/search", { query: "invoice", collection: "Work" })).pipeline,
    "notes first", "and by the name the owner uses, which is what the documentation promises");
  assert.equal((await api("POST", "/api/retrieval/search", { query: "invoice" })).pipeline, "default");
});

test("V14 a project that names its own knowledge bases cannot silently empty a filtered search", async (t) => {
  const { app, collection } = await library(t);
  // The active project is pointed at a knowledge base that is not the one holding the passages, so
  // the rows survive the filter and are then dropped by the project's own list.
  const other = app.knowledgeBases.create("local", { name: "Somewhere else", sources: [] });
  app.store.projects.save("local", { id: "narrow", name: "Narrow", instructions: "", modelPreset: null,
    repository: "", folder: "", profile: null, knowledgeBases: [other.id] });
  app.store.projects.setActive("local", { active: "narrow" });
  const answer = await app.knowledgeBases.searchWithNote("local", {
    query: "invoice supplier", limit: 10, filter: { kinds: ["csv"] },
  });
  assert.deepEqual(answer.hits, []);
  assert.match(answer.note, /Nothing you have matches that filter/, "an empty filtered answer always says so");
  assert.ok(collection);
});
