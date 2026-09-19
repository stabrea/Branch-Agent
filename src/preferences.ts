import { z } from "zod";
import type { Store } from "./store.js";

/** How the workspace looks. Every field has a default so older saved records keep working. */
export const PreferencesSchema = z
  .object({
    appearance: z.enum(["forest", "daylight"]).default("forest"),
    followSystem: z.boolean().default(false),
    accent: z
      .enum(["copper", "leaf", "earth", "slate", "ink"])
      .default("copper"),
    textSize: z.enum(["small", "medium", "large"]).default("medium"),
    density: z.enum(["comfortable", "compact"]).default("comfortable"),
    font: z.enum(["geist", "system"]).default("geist"),
    reduceMotion: z.boolean().default(false),
    /** The acorn toy in the side pane. Off unless the owner switches it on. */
    showAcorn: z.boolean().default(false),
    /** The full window (every tab, meter and switch) instead of the calm one. Off by default. */
    showEverything: z.boolean().default(false),
    /** The microphone and Talk buttons beside the message box. Off by default. */
    showVoice: z.boolean().default(false),
    /** phase2/settings: how much Settings shows. Unset means "regular", or "advanced" for someone who had Show everything on. */
    settingsLevel: z.enum(["regular", "advanced", "technical"]).optional(),
  })
  .strict();
export type Preferences = z.infer<typeof PreferencesSchema>;
export function preferences(store: Store, owner: string) {
  return PreferencesSchema.parse(
    store.get("settings", owner, "preferences")?.data ?? {},
  );
}
