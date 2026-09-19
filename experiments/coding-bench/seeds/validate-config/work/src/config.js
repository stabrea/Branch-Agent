/** Reads a config object, filling in defaults. */
export function loadConfig(raw) {
  return {
    host: raw.host ?? "localhost",
    port: raw.port,
  };
}
