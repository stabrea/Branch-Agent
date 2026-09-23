import { z } from "zod";

/**
 * phase2/shell (critique #7): how a Trunk looks, beside its picture (`avatar`). The owner chooses
 * what the face is made of, its colour, its shape and how it moves; the window draws it the same
 * way in the strip, the studio, the sidebar and on every reply.
 *
 * A colour is one of the approved sample's fixed colours or any colour the owner picks, kept as
 * `#rrggbb` (DG-105); "theme" for the theme's own highlight; or, for a Trunk styled before that,
 * one of the eight `--series-N` tokens, which every theme draws in its own colours.
 * Leaving colour or shape empty keeps what the name gives, which is how every Trunk made before
 * this looked, so nothing changes for a Trunk nobody has restyled.
 */
export const trunkFaces = ["drawn", "letters", "emoji", "pattern"] as const;
export const trunkShapes = ["circle", "squircle", "leaf", "acorn", "shield", "hexagon", "pebble"] as const;
export const trunkMotions = ["none", "breathe", "sway", "shimmer", "pulse", "dots"] as const;

/** An emoji or two: a short run with no letters, digits, spaces or markup in it. */
const emoji = z.string().max(16).regex(/^[^\x00-\x7F]*$/u, "Choose an emoji, not letters");

export const TrunkLookSchema = z.object({
  /** drawn: the face made from the name; letters; emoji; pattern: pixel art made from the name. A photo is `avatar`. */
  face: z.enum(trunkFaces).default("drawn"),
  letters: z.string().trim().max(2).regex(/^[\p{L}\p{N}]*$/u, "Use one or two letters").default(""),
  emoji: emoji.default(""),
  /** Changes the pixel pattern without renaming the Trunk. */
  shuffle: z.number().int().min(0).max(999999).default(0),
  /** A colour as `#rrggbb` (kept in lower case), a series token (1 to 8), the theme's highlight, or null for the colour its name gives. */
  colour: z.union([
    z.string().regex(/^#[0-9a-f]{6}$/i, "Choose a colour such as #1f5139").transform((value) => value.toLowerCase()),
    z.number().int().min(1).max(8), z.literal("theme"),
  ]).nullable().default(null),
  /** null keeps the shape its name gives. */
  shape: z.enum(trunkShapes).nullable().default(null),
  motion: z.enum(trunkMotions).default("none"),
  /** The procedural 3D stand-in; only drawn while "3D faces" is switched on (src/shell-look.ts). */
  depth: z.enum(["flat", "3d"]).default("flat"),
}).strict();
export type TrunkLook = z.infer<typeof TrunkLookSchema>;
