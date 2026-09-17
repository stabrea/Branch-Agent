# mac3/channels-parity: every chat app the other agents reach, the lawful way

Area `channels-parity`, branch `mac3/channels-parity` from `mac/cross-platform`. Rules: `docs/agents/briefs/mac1/BUILD-MAC.md`,
`docs/agents/briefs/mac2/README.md`, `docs/agents/briefs/mac3/DESIGN-EVERYWHERE.md`, `docs/places.md` (setup cards at
`customize:channels`).
**You own:** new adapter files `src/channels/<service>.ts`, `data/channels.json`, the registration list in
`src/channels/connectors.ts` (additive), `src/channels/catalog.ts` (additive), new `public/channels-more.js` if a card is
needed, tests `tests/channels-parity*.test.mjs`, and the channels section of `docs/configuration.md`.
**Do not edit** `src/channels/router.ts` or `src/channels/deliveries.ts` (mac2/chat-live owns them until it merges);
adapters must work through the existing adapter interface, and use the optional status/edit/react methods chat-live
adds when present.

1. **Inventory:** list every chat/notification service in OpenClaw `extensions/`, PicoClaw `pkg/channels/`, nanobot
   `nanobot/channels/`, OpenFang `crates/openfang-channels/src/`, ZeroClaw `crates/zeroclaw-channels/`, Hermes Agent's
   gateway, Agent Zero, IronClaw (clones in `/Users/taofikbishi/Code/agent-refs`). Put a parity table in
   `docs/configuration.md`: service → Branch status (had it / built now / not built + reason).
2. **Build every one that has an official API or an open protocol**, e.g. IRC, XMPP, Nostr, Mastodon, Bluesky, Zulip,
   Rocket.Chat, Mattermost, Google Chat, Microsoft Teams (Bot Framework), Webex, Twitch chat, Reddit (official API),
   LINE, Viber, Feishu/Lark, DingTalk, WeCom, Nextcloud Talk, Synology Chat, Gotify, ntfy, Pushover, SMS (Twilio-style
   provider API), MQTT, Keybase, Threema Gateway, Zalo OA, VK, QQ official bot API, Discourse, Guilded/Revolt if their
   official bot APIs exist, and iMessage **only** by driving the Messages app on the owner's own Mac through
   AppleScript (BlueBubbles-style, macOS only, off by default). Each adapter: pairing/allowlist like the existing ones,
   secrets only through the locker, network policy on every call, three-way switch off by default, a setup card with
   plain words and real French.
3. **Do not build** anything that needs a reverse-engineered or unofficial client that breaks the service's terms:
   WhatsApp personal accounts via WhatsApp Web emulation, personal WeChat/QQ web protocols, Instagram private API,
   Snapchat, Telegram userbots (Branch uses the official Bot API). List each with the reason in the parity table.
4. **Tests** with fake servers for every adapter (send, receive, pairing refusal, secret never logged). Never contact a
   real service.
Borrow only from MIT/Apache sources (OpenClaw, PicoClaw, nanobot, OpenFang, ZeroClaw, Hermes are MIT/Apache) with notices.
