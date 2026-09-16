import { mkdir, copyFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

// The evaluation suites are plain JSON, so tsc never touches them. Copy them next to the built
// program: the packaged app only ships dist/, public/ and node_modules.
const source = resolve("data/evaluation");
const destination = resolve("dist/data/evaluation");
await mkdir(destination, { recursive: true });
for (const name of await readdir(source))
  if (name.endsWith(".json")) await copyFile(join(source, name), join(destination, name));
