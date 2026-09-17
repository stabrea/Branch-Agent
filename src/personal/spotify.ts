import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { clip, requirePersonal } from "./settings.js";
import { signedCall, type SignIn } from "./signin.js";

/**
 * R17-028: Spotify, through the official Web API and the owner's own sign-in: what is playing, a
 * search, and play, pause, skip, volume and shuffle. Spotify only lets Premium accounts be
 * controlled this way, and says so with a 403, which is passed on in plain words.
 * API: https://developer.spotify.com/documentation/web-api
 */
const api = "https://api.spotify.com/v1";
const spotifyUri = /^spotify:(track|album|artist|playlist|episode|show):[A-Za-z0-9]{22}$/;

export const SpotifySearchSchema = z.object({
  query: z.string().trim().min(1).max(200),
  kinds: z.array(z.enum(["track", "album", "artist", "playlist"])).min(1).max(4).default(["track"]),
  max: z.number().int().min(1).max(20).default(5),
}).strict();
export const SpotifyControlSchema = z.object({
  action: z.enum(["play", "pause", "next", "previous", "volume", "shuffle"]),
  /** For play: a track, album, artist or playlist to start (from spotify.search). Empty resumes. */
  uri: z.string().regex(spotifyUri, "Use a Spotify address such as spotify:track:… from spotify.search").optional(),
  /** For volume: 0 to 100. */
  volume: z.number().int().min(0).max(100).optional(),
  /** For shuffle: on or off. */
  shuffle: z.boolean().optional(),
}).strict();

const Named = z.object({ name: z.string().optional(), uri: z.string().optional() }).passthrough();

/** The request each control action is, in Spotify's own terms. */
export function controlRequest(input: z.infer<typeof SpotifyControlSchema>): { method: string; path: string; json?: unknown } {
  switch (input.action) {
    case "play": {
      if (!input.uri) return { method: "PUT", path: "/me/player/play" };
      const track = input.uri.startsWith("spotify:track:") || input.uri.startsWith("spotify:episode:");
      return { method: "PUT", path: "/me/player/play", json: track ? { uris: [input.uri] } : { context_uri: input.uri } };
    }
    case "pause": return { method: "PUT", path: "/me/player/pause" };
    case "next": return { method: "POST", path: "/me/player/next" };
    case "previous": return { method: "POST", path: "/me/player/previous" };
    case "volume":
      if (input.volume === undefined) throw new Error("Say how loud, from 0 to 100");
      return { method: "PUT", path: `/me/player/volume?volume_percent=${input.volume}` };
    case "shuffle":
      if (input.shuffle === undefined) throw new Error("Say whether shuffle should be on or off");
      return { method: "PUT", path: `/me/player/shuffle?state=${input.shuffle}` };
  }
}

export class SpotifyConnector {
  constructor(private readonly store: Store, private readonly owner: string, private readonly fetcher: typeof fetch,
    private readonly signIn: SignIn) {}
  private async call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<unknown> {
    requirePersonal(this.store, this.owner, "spotify");
    try {
      return await signedCall(this.fetcher, this.signIn, "Spotify", `${api}${path}`, init);
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      if (/\(403\)/.test(said)) throw new Error("Spotify refused: controlling playback needs a Premium account, and a device that is open.");
      if (/\(404\)/.test(said)) throw new Error("Spotify has no active device. Open Spotify on a phone or computer first.");
      throw error;
    }
  }

  async now() {
    const body = z.object({ is_playing: z.boolean().optional(), progress_ms: z.number().nullish(),
      device: z.object({ name: z.string().optional(), volume_percent: z.number().nullish() }).passthrough().optional(),
      item: z.object({ name: z.string().optional(), uri: z.string().optional(), duration_ms: z.number().optional(),
        artists: z.array(Named).optional(), show: Named.optional() }).passthrough().nullish(),
      shuffle_state: z.boolean().optional() }).passthrough().parse(await this.call("/me/player"));
    if (!body.item) return { playing: false, note: "Nothing is playing on Spotify right now." };
    const by = body.item.artists?.map((artist) => artist.name).filter(Boolean).join(", ") || body.item.show?.name || "";
    return { playing: body.is_playing ?? false, title: clip(body.item.name ?? "", 200), by: clip(by, 200), uri: body.item.uri ?? null,
      device: body.device?.name ?? null, volume: body.device?.volume_percent ?? null, shuffle: body.shuffle_state ?? null };
  }

  async search(input: unknown) {
    const { query, kinds, max } = SpotifySearchSchema.parse(input);
    const params = new URLSearchParams({ q: query, type: kinds.join(","), limit: String(max) });
    const body = z.record(z.string(), z.unknown()).parse(await this.call(`/search?${params}`));
    const results: { kind: string; name: string; by: string; uri: string }[] = [];
    for (const kind of kinds) {
      const items = z.object({ items: z.array(Named.extend({ artists: z.array(Named).optional(),
        owner: z.object({ display_name: z.string().nullish() }).passthrough().optional() }).nullable()).default([]) }).passthrough()
        .safeParse(body[`${kind}s`]);
      for (const item of items.success ? items.data.items : []) {
        if (!item?.uri) continue;
        const by = item.artists?.map((artist) => artist.name).join(", ") ?? item.owner?.display_name ?? "";
        results.push({ kind, name: clip(item.name ?? "", 200), by: clip(by, 200), uri: item.uri });
      }
    }
    return { results };
  }

  async control(input: unknown) {
    const value = SpotifyControlSchema.parse(input);
    const request = controlRequest(value);
    await this.call(request.path, { method: request.method, ...(request.json ? { json: request.json } : {}) });
    return { done: value.action };
  }
}

export function registerSpotify(registry: Pick<ToolRegistry, "register">, spotify: SpotifyConnector): void {
  registry.register({ name: "spotify.now", permission: "personal.read", description: "What is playing on the owner's Spotify right now, and on which device.",
    parameters: z.object({}).strict(), execute: async () => spotify.now() });
  registry.register({ name: "spotify.search", permission: "personal.read", description: "Search Spotify for tracks, albums, artists or playlists.",
    parameters: SpotifySearchSchema, execute: async (input) => spotify.search(input) });
  registry.register({ name: "spotify.control", permission: "personal.write",
    description: "Play (something found with spotify.search, or resume), pause, skip forward or back, set the volume, or turn shuffle on or off on the owner's Spotify.",
    parameters: SpotifyControlSchema, execute: async (input) => spotify.control(input) });
}
