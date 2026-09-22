import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const reviewed = new Map([
  ["actions/checkout", ["3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"]],
  ["actions/setup-node", ["820762786026740c76f36085b0efc47a31fe5020", "v7.0.0"]],
  ["actions/setup-python", ["5fda3b95a4ea91299a34e894583c3862153e4b97", "v7.0.0"]],
  ["actions/cache", ["55cc8345863c7cc4c66a329aec7e433d2d1c52a9", "v6.1.0"]],
  ["actions/upload-artifact", ["043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "v7.0.1"]],
  ["actions/download-artifact", ["3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", "v8.0.1"]],
]);

test("every workflow pins the reviewed Node 24 action releases by immutable commit", async () => {
  const folder = join(".github", "workflows");
  const files = (await readdir(folder)).filter((name) => name.endsWith(".yml"));
  let uses = 0;
  for (const file of files) {
    const source = await readFile(join(folder, file), "utf8");
    for (const match of source.matchAll(/uses:\s+(actions\/[\w-]+)@([a-f0-9]{40})\s+#\s+(v\S+)/g)) {
      uses++;
      const expected = reviewed.get(match[1]);
      assert.ok(expected, `${file} uses an unreviewed first-party action: ${match[1]}`);
      assert.deepEqual([match[2], match[3]], expected, `${file} must pin ${match[1]} to its reviewed Node 24 release`);
    }
  }
  assert.equal(uses, 27, "every first-party workflow action remains covered by this review");
});
