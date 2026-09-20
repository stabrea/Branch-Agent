import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { HttpError, readJsonBody } from "../dist/server-http.js";

function request(body, headers = { "content-type": "application/json" }) {
  return Object.assign(Readable.from(Array.isArray(body) ? body : [body]), { headers });
}

test("the shared JSON reader accepts chunked UTF-8 objects", async () => {
  const body = await readJsonBody(request([Buffer.from('{"answer":'), Buffer.from("42}")]));
  assert.deepEqual(body, { answer: 42 });
});

test("the shared JSON reader requires the JSON content type", async () => {
  await assert.rejects(readJsonBody(request("{}", { "content-type": "text/plain" })), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 415);
    return true;
  });
});

test("the shared JSON reader rejects declared and streamed oversized bodies", async () => {
  await assert.rejects(readJsonBody(request("{}", {
    "content-type": "application/json",
    "content-length": "3",
  }), 2), (error) => error instanceof HttpError && error.status === 413);
  await assert.rejects(readJsonBody(request(["{", '"a":1}']), 4), (error) =>
    error instanceof HttpError && error.status === 413);
});

test("the shared JSON reader reports malformed JSON and UTF-8 consistently", async () => {
  for (const body of ["{", Buffer.from([0xc3, 0x28])]) {
    await assert.rejects(readJsonBody(request(body)), (error) =>
      error instanceof HttpError && error.status === 400 && error.message === "Invalid JSON");
  }
});
