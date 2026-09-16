// The bundled holiday list is plain data, so tsc never touches it. Copy it next to the built
// program: the packaged app ships dist/, public/ and node_modules, never the repository's data/
// folder. Only this one file is copied; the evaluation suites have their own copy step.
import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

await mkdir(resolve("dist"), { recursive: true });
await copyFile(resolve("data/holidays.json"), resolve("dist/holidays.json"));
