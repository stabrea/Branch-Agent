import type { ChatGPTAuth } from "./chatgpt-auth.js";
import { ChatGPTProvider, chatgptModels } from "./chatgpt-provider.js";
import type { ModelRouter } from "./models.js";

export const chatgptPresetPrefix = "chatgpt-";
export const chatgptPresetId = (model: string): string => chatgptPresetPrefix + model.replace(/[^a-z0-9.]+/gi, "-");

/**
 * Keeps the model presets in step with the ChatGPT sign-in: signed in adds one preset per supported
 * model, signed out removes them. Returns the ids currently registered for ChatGPT.
 */
export function syncChatGPTPresets(models: ModelRouter, auth: ChatGPTAuth, signedIn: boolean, userAgent: string): string[] {
  if (!signedIn) {
    models.unregister(chatgptPresetPrefix);
    return [];
  }
  return chatgptModels.map((entry) => {
    const id = chatgptPresetId(entry.id);
    models.register({
      id, name: `ChatGPT · ${entry.label}`, model: entry.id, reasoning: entry.reasoning,
      provider: new ChatGPTProvider(auth, { model: entry.id, userAgent }),
    });
    return id;
  });
}

/** After a sign-in, make ChatGPT the default when the workspace was still on the offline demonstration. */
export function preferChatGPTAfterSignIn(models: ModelRouter, owner: string, ids: string[]): void {
  const first = ids[0];
  if (!first) return;
  const settings = models.settings(owner);
  const current = models.presets.get(settings.activePreset ?? models.default.id);
  if (!current || current.provider.name === "offline-demo-fixture")
    models.configure(owner, { activePreset: first, fallbackOrder: ids.slice(1) });
}

/** Waits for the browser approval, then registers ChatGPT presets and prefers them over the demonstration. */
export async function finishChatGPTSignIn(models: ModelRouter, auth: ChatGPTAuth, owner: string, userAgent: string) {
  const status = await auth.waitForDeviceLogin();
  const ids = syncChatGPTPresets(models, auth, status.signedIn, userAgent);
  preferChatGPTAfterSignIn(models, owner, ids);
  return status;
}
