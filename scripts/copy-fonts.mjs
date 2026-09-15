import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const destination = resolve("public/fonts");
await mkdir(destination, { recursive: true });
for (const [family, axis] of [
  ["archivo", "standard"],
  ["geist", "wght"],
  ["geist-mono", "wght"],
]) {
  const source = resolve("node_modules/@fontsource-variable", family);
  await copyFile(
    `${source}/files/${family}-latin-${axis}-normal.woff2`,
    `${destination}/${family}.woff2`,
  );
  await copyFile(`${source}/LICENSE`, `${destination}/${family}-LICENSE.txt`);
}
