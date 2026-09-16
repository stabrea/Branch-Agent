// Bundled plain-data files (the holiday lists) belong beside the compiled code, because the
// packaged app ships dist/ and not the repository's data/ folder.
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("data");
const destination = resolve("dist");
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
