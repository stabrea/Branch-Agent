const { app, nativeImage } = require("electron");
const { writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(resolve("public/assets/keepoak-mark.png"));
  if (source.isEmpty()) throw new Error("KeepOak logo could not be loaded");
  const png = source.resize({ width: 256, height: 256 }).toPNG();
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  writeFileSync(resolve("public/assets/keepoak.ico"), Buffer.concat([header, png]));
  app.quit();
}).catch((error) => { console.error(error.message); app.exit(1); });
