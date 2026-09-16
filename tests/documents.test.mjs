import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { DocumentLibrary } from "../dist/documents.js";

const testDb = () => {
  const db = new DatabaseSync(":memory:");
  return db;
};

test("DocumentLibrary initialization", () => {
  const db = testDb();
  const lib = new DocumentLibrary(db);
  ok(lib, "library created");
});

test("addDocument works", async () => {
  const db = testDb();
  const lib = new DocumentLibrary(db);

  const docId = await lib.addDocument("user1", "test", "Hello world", "txt");
  strictEqual(typeof docId, "string", "returns document id");
});

test("list documents", async () => {
  const db = testDb();
  const lib = new DocumentLibrary(db);

  await lib.addDocument("user1", "doc1", "content1", "txt");
  const docs = lib.list("user1");
  strictEqual(docs.length, 1, "document listed");
});

test("search finds content", async () => {
  const db = testDb();
  const lib = new DocumentLibrary(db);

  await lib.addDocument("user1", "doc1", "The quick brown fox", "txt");
  const results = await lib.search("user1", "quick");
  strictEqual(results.length > 0, true, "found results");
});

test("remove deletes document", async () => {
  const db = testDb();
  const lib = new DocumentLibrary(db);

  const docId = await lib.addDocument("user1", "doc1", "content", "txt");
  await lib.remove("user1", docId);
  const docs = lib.list("user1");
  strictEqual(docs.length, 0, "document removed");
});

test("owner isolation", async () => {
  const db = testDb();
  const lib = new DocumentLibrary(db);

  await lib.addDocument("user1", "doc1", "secret data", "txt");
  await lib.addDocument("user2", "doc2", "public info", "txt");

  const user2Docs = lib.list("user2");
  strictEqual(user2Docs.length, 1, "user2 sees only their doc");
});
