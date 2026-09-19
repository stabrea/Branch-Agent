import { test } from "node:test";
import assert from "node:assert/strict";
import { rank } from "../src/rank.js";

test("ties keep their order", () => {
  const players = [
    { name: "a", score: 1 }, { name: "b", score: 3 }, { name: "c", score: 3 },
    { name: "d", score: 2 }, { name: "e", score: 3 }, { name: "f", score: 1 },
  ];
  assert.deepEqual(rank(players).map((p) => p.name), ["b", "c", "e", "d", "a", "f"]);
});
