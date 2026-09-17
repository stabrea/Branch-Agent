import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * R17-006 (T-06): a Trunk's picture. Three kinds, after Hermes Bot Mode's avatars
 * (hermes-agent `website/docs/user-guide/bot-mode.md`, MIT):
 *
 *   face       drawn from the name; it follows a rename unless the owner locks it
 *   image      a picture the owner uploaded
 *   generated  a picture made by the connected picture model from a few words
 *
 * No colour is stored: a face names one of the eight `--series-N` tokens, so every theme draws it
 * in its own colours. The window animates the face while the Trunk's turn runs.
 */
const pictureData = z.string().max(400_000)
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/, "A picture must be a PNG, JPEG or WebP");

export const AvatarSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("face"), seed: z.string().trim().max(80).default(""), locked: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal("image"), dataUrl: pictureData }).strict(),
  z.object({ kind: z.literal("generated"), dataUrl: pictureData, prompt: z.string().trim().max(500).default("") }).strict(),
]);
export type Avatar = z.infer<typeof AvatarSchema>;

/** What the window draws for a face: which head, eyes and mouth, and which series colour. */
export interface Face { head: number; eyes: number; mouth: number; series: number }

/** The same name always gives the same face. */
export function faceFor(seed: string): Face {
  const bytes = createHash("sha256").update(seed.trim().toLowerCase() || "trunk").digest();
  return { head: bytes[0]! % 4, eyes: bytes[1]! % 4, mouth: bytes[2]! % 4, series: (bytes[3]! % 8) + 1 };
}

/** A face that is not locked follows the Trunk's name; everything else stays as the owner set it. */
export function settleAvatar(avatar: Avatar | undefined, name: string): Avatar {
  if (!avatar) return { kind: "face", seed: name, locked: false };
  if (avatar.kind === "face" && (!avatar.locked || !avatar.seed)) return { ...avatar, seed: name };
  return avatar;
}

/** A picture's bytes as the data address kept on the Trunk. Refuses anything that is not a small picture. */
export function pictureAddress(bytes: Buffer, mediaType: string): string {
  if (!["image/png", "image/jpeg", "image/webp"].includes(mediaType)) throw new Error("A Trunk's picture must be a PNG, JPEG or WebP");
  const address = `data:${mediaType};base64,${bytes.toString("base64")}`;
  if (address.length > 400_000) throw new Error("That picture is too large for a Trunk; use one under about 290 KB");
  return address;
}
