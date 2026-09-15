import { z } from "zod";
import type { Store } from "./store.js";

export const PreferencesSchema = z
  .object({ appearance: z.enum(["forest", "daylight"]) })
  .strict();
export function preferences(store: Store, owner: string) {
  return PreferencesSchema.parse(
    store.get("settings", owner, "preferences")?.data ?? {
      appearance: "forest",
    },
  );
}
