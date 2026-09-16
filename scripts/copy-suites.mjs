import { mkdir, copyFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

// The evaluation suites are plain JSON, so tsc never touches them. Copy them next to the built
// program: the packaged app only ships dist/, public/ and node_modules.
// Wave 7: the per-tool checks are the same kind of thing and live in their own folder, so nothing
// that is not a suite is ever read by the suite loader.
for (const folder of ["evaluation", "tool-evaluations"]) {
  const source = resolve("data", folder);
  const destination = resolve("dist/data", folder);
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source))
    if (name.endsWith(".json")) await copyFile(join(source, name), join(destination, name));
}
