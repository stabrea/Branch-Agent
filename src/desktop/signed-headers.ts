/**
 * The headers a desktop window's /api/ request goes out with: whatever authorization the page wrote (a stand-in, in
 * any letter case: dogfood F7) is dropped, and only the app's own key is sent. Kept apart from main.ts so a test can
 * check it without Electron.
 */
export function signedHeaders(headers: Record<string, string>, token: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() !== "authorization") out[name] = value;
  out.Authorization = `Bearer ${token}`;
  return out;
}
