// A test reporter that records how long each file's work took, so the build machines can be given
// an even share of it.
//
// Splitting the suite across machines by counting files does not work: one file here runs for seven
// minutes and hundreds finish in under a second, so equal counts make wildly unequal machines. This
// writes a plain map of file to seconds, which `npm test` reads back to pack the shares by time.
//
// It is a second reporter, so the usual output still goes to the screen. Node hands each reporter
// its own destination; this one's destination is the file the timings are written to.
/** Sum the top-level tests in each file; nested ones are already inside their parent's time. */
export default async function* timings(source) {
  const seconds = new Map();
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { file, nesting, details } = event.data;
    if (!file || nesting !== 0) continue;
    const key = file.replace(/\\/g, "/").replace(/^.*?((tests|packages)\/)/, "$1");
    seconds.set(key, (seconds.get(key) ?? 0) + (details?.duration_ms ?? 0) / 1000);
  }
  const rounded = Object.fromEntries([...seconds].sort().map(([file, value]) => [file, Math.round(value * 1000) / 1000]));
  yield `${JSON.stringify(rounded, null, 2)}\n`;
}
