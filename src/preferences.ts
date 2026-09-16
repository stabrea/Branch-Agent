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
    showAcorn: z.boolean().default(true),
  })
  .strict();
export type Preferences = z.infer<typeof PreferencesSchema>;
export function preferences(store: Store, owner: string) {
  return PreferencesSchema.parse(
    store.get("settings", owner, "preferences")?.data ?? {},
  );
}
