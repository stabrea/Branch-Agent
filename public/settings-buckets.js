/* phase2/settings: what each Settings page holds, grouped by what a person wants to do.
   Every card keeps its own id and module; public/settings-grown.js only puts the cards of a page in
   this order, draws a heading in front of each group and gives each card the least level that shows it
   (regular, advanced or technical). A card that is not listed here still shows, at the end of its page
   under "More on this page", at every level. Row: [bucket id, icon, English title, English line,
   [[card id, level], ...]]. A card id may also be the class of a block with no id (lx-look).
   Regular never hides a safety control: what Branch may do without asking, the stop switches, a second look
   at approvals, updates and what runs in the background stay regular (tests/settings-grown.test.mjs S15). */
const R = "regular", A = "advanced", T = "technical";

export const BUCKETS = {
  general: [
    ["start", "power", "How Branch starts and keeps running", "Whether it starts with your computer and keeps going when the window is closed.",
      [["deployment-card", R], ["never-break-card", A]]],
    ["projects", "folder", "Your projects", "The folders Branch works in, and what it leaves alone there.",
      [["projects-form", R], ["context-project", A], ["asks-board-card", A], ["comfort-files-card", A]]],
    ["people", "people", "People and sharing", "Who else uses Branch here, and what you share with them.",
      [["lx-collab-people", R], ["lx-collab-labels", R], ["people-signin-admin", A]]],
    ["keys", "keyboard", "Keys and typed commands", "Shortcuts, and the commands you can type with a slash.",
      [["comfort-keys-card", A], ["commands-card", A]]],
    ["whole", "sliders", "All your settings at once", "Start from a preset, put settings back, or keep them in one file.",
      [["settings-kit-presets", A], ["settings-kit-reset", A]]],
  ],
  assistant: [
    ["who", "person", "Who your assistant is", "Its name, its manner, and standing instructions.",
      [["identity-form", R], ["context-assistant", A], ["autonomy-instructions-card", A]]],
  ],
  instructions: [
    ["files", "instructions", "Its files", "The plain files that shape how Branch works and talks to you.",
      [["agent-files", R]]],
  ],
  appearance: [
    ["theme", "leaf", "Theme and lettering", "Colours, the size of the words, and the language.",
      [["lx-look", R], ["settings-form", R], ["shell-look-card", R]]],
    ["shows", "eye", "What a conversation shows", "How much of the working-out you see while it works.",
      [["panels-onscreen", R], ["knobs-show-reasoning-card", A], ["comfort-display-card", A], ["savings-round-chart-card", A], ["flows-focus-card", A]]],
    /* p2-delight's cards (integration): each is off until turned on, so showing them changes nothing. */
    ["fun", "spark", "Just for fun", "A pet, achievements and a background of your own. Each is off until you turn it on.",
      [["delight-pet-card", R], ["delight-ach-card", R], ["delight-bg-card", R]]],
  ],
  notifications: [
    ["attention", "bell", "When Branch gets your attention", "Sounds, banners and the times it should leave you alone.",
      [["comfort-notify-card", R], ["lx-collab-days-off", R], ["quiet-interruptions", A]]],
  ],
  "models:connection": [
    ["connection", "chip", "Your model connection", "Which service answers, and how Branch signs in to it.",
      [["model-settings-form", R], ["chatgpt-card", R], ["models-form", R], ["model-probe-card", R]]],
    ["services", "swap", "Other model services", "Extra services Branch can use.",
      [["gemini-signin-card", A], ["savings-openrouter-card", A], ["asks-runtimes-card", A]]],
  ],
  "models:defaults": [
    ["which", "spark", "Which model does what", "A strong model for hard work and a quick one for small jobs.",
      [["model-profiles-card", R], ["knobs-reasoning-card", R], ["savings-phases-card", A], ["savings-difficulty-card", A]]],
    ["long", "layers", "Long conversations and side jobs", "What happens when a conversation grows long or splits into side tasks.",
      [["knobs-compaction-card", A], ["knobs-subtasks-card", A]]],
    ["under", "wrench", "Under the hood", "Counting and caching details. Rarely needed.",
      [["savings-reported-tokens-card", T], ["savings-keep-alive-card", T]]],
  ],
  "models:local": [
    ["local", "chip", "Models on this computer", "Models that run here, without sending anything away.",
      [["local-models-card", R]]],
  ],
  "models:second": [
    ["second", "people", "A second opinion", "Let another model check the answer first.",
      [["second-opinion-form", R], ["savings-mixtures-card", A], ["reach-arena-card", A]]],
  ],
  "models:media": [
    ["media", "image", "Pictures, sound and video", "Reading and making pictures, sound and video.",
      [["media-form", R], ["video-programs-card", A], ["reach-video-card", A]]],
  ],
  /* phase2/accounts gave Accounts a page of its own (integration). */
  accounts: [
    ["accounts", "key", "Your accounts", "The accounts Branch signs in with, and sharing the work between them.",
      [["accounts-card", R]]],
  ],
  voice: [
    ["talk", "mic", "Talking and listening", "Speaking to Branch and how it hears you.",
      [["voice-settings-form", R], ["dictation-form", R], ["wake-word-form", A], ["comfort-voice-card", A]]],
    ["voices", "speaker", "The voices it speaks with", "How it answers out loud.",
      [["system-voice-card", A], ["personal-voice-card", A], ["speech-engines-card", T]]],
  ],
  permissions: [
    ["checks", "shield", "When Branch checks with you", "What it may do without asking, and the stop switches.",
      [["policy-card", R], ["safety-stop-card", R], ["approval-reviewer-card", R], ["pins-form", A]]],
    ["limits", "gauge", "Limits on one task and one person", "How far one task may go, and how much one person may ask for.",
      [["limits-card", A], ["knobs-limits-card", A], ["loop-guard-card", A]]],
    ["safe", "lock", "Keeping things safe", "Hiding secrets, trusted folders and security checks.",
      [["security-check", R], ["folder-trust-card", A], ["knobs-leak-guard-card", A], ["safety-codes-card", A], ["safety-extras-card", A], ["safety-chain-card", T], ["safety-wasm-card", T]]],
  ],
  computer: [
    ["screen", "monitor", "Your screen, keyboard and apps", "When Branch may look at and use your screen.",
      [["desktop-card", R], ["screen-switch-card", A], ["reach-background-card", R], ["reach-usb-card", A], ["os-permissions-card", A]]],
    ["commands", "terminal", "Running commands safely", "Where commands run and the wall around them.",
      [["sandbox-card", A], ["os-sandbox-card", A], ["knobs-commands-card", A], ["firewall-card", A], ["knobs-launch-file-card", T]]],
    ["browser", "globe", "The browser", "Sites it stays signed in to, and how carefully it clicks.",
      [["browser-card", R], ["comfort-browser-card", A]]],
    ["others", "window", "Your other computers", "Other computers running Branch.",
      [["remote-card", A], ["asks-nodes-card", A], ["reach-machines-card", A]]],
    ["under", "wrench", "Under the hood", "The network in between. Rarely needed.",
      [["comfort-network-card", T]]],
  ],
  secrets: [
    ["keys", "key", "Passwords and keys", "Keys and passwords Branch may use, one at a time.",
      [["secrets-form", R], ["vault-autofill", R], ["keychain-card", A]]],
  ],
  data: [
    ["cost", "coins", "What it costs", "Spending limits, and what each model costs.",
      [["usage", R], ["usage-report-card", R]]],
    ["kept", "archive", "What is kept, and for how long", "How long conversations stay, safety copies, and bringing things over.",
      [["retention-card", R], ["backup-card", R], ["snapshots-card", A], ["goal-undo-form", A], ["move-in-card", A], ["settings-kit-file", A]]],
    ["under", "wrench", "Under the hood", "Counting how Branch is used. Rarely needed.",
      [["asks-analytics-card", T]]],
  ],
  advanced: [
    ["fix", "wrench", "Fixing problems", "Check that everything works, and find what a stopped task needs.",
      [["health-card", R], ["diagnostics-card", R], ["activity-log-card", A], ["settings", A], ["event-loop-card", T]]],
    ["dev", "code", "For developers", "For people building on Branch.",
      [["coding-card", A], ["jev-decisions-card", A], ["developer-card", T], ["sdk-kit-card", T]]],
    ["under", "gauge", "Under the hood", "Counters, retries and limits. Rarely needed.",
      [["counters-card", T], ["knobs-retries-card", T], ["knobs-tools-card", T]]],
  ],
  about: [
    ["updates", "refresh", "Updates", "Your version, and how Branch keeps itself up to date.",
      [["updates-card", R], ["comfort-updates-card", R]]],
    ["help", "help", "Help and problems", "Tell KeepOak what went wrong.",
      [["problem-report-card", R]]],
    ["over", "warn", "Starting over", "Putting Branch back as it came.",
      [["danger-zone", A]]],
  ],
  trunks: [
    ["open", "people", "Trunks, computers and people", "Open the real places where you manage each one.",
      [["settings-directory-trunks-trunks", R], ["settings-directory-trunks-overview", R], ["settings-directory-trunks-people", R]]],
  ],
  channels: [
    ["open", "bell", "Chat apps and devices", "Open the real Channels place to set them up.",
      [["settings-directory-channels-channels", R]]],
  ],
  connections: [
    ["open", "swap", "Connections", "Open the real Connections place to manage them.",
      [["settings-directory-connections-connections", R]]],
  ],
  skills: [
    ["open", "spark", "Skills, specialists and plugins", "Open the real place for each kind of capability.",
      [["settings-directory-skills-skills", R], ["settings-directory-skills-specialists", R], ["settings-directory-skills-plugins", R]]],
  ],
  memory: [
    ["open", "memory", "Memory, documents and things made", "Open the real Library page for each kind of item.",
      [["settings-directory-memory-memory", R], ["settings-directory-memory-documents", R], ["settings-directory-memory-made", R]]],
  ],
  /* DG-198: the sample's four sections, filled in the order it fills them. The links to the Automations and Inbox
     places have no home in the sample; they wait at Technical beside what they open, for the coordinator. */
  automations: [
    ["running", "automations", "Keep it running by itself", "Check-ins and standing orders that run on their own.",
      [["quiet-checkin", R], ["autonomy-suggestions-card", R], ["autonomy-orders-card", A], ["context-heartbeat", A],
        ["autonomy-loops-card", A], ["settings-directory-automations-scheduled", T]]],
    ["limits", "gauge", "Limits and the waiting line", "How much automatic work may run, and in what order.",
      [["quiet-health", R], ["flows-board-card", R], ["flows-waiting-card", A], ["autonomy-limits-card", A],
        ["flows-travel-card", A], ["flows-recipes-card", A], ["prompts-card", A], ["context-sop", A],
        ["autonomy-procedures-card", A], ["settings-directory-automations-procedures", T]]],
    ["webhooks", "globe", "A public address for webhooks", "Chat services and triggers can reach Branch from the internet through your own tunnel program.",
      [["personal-tunnel-card", R], ["flows-installs-card", R], ["settings-directory-automations-triggers", T],
        ["settings-directory-automations-needs", T]]],
    ["watch", "eye", "Watch a task again", "Play back what a finished task did, one step at a time.",
      [["recordings-card", R], ["settings-directory-automations-history", T]]],
  ],
};

/** Groups in the Settings list, before the page they start at. */
export const NAV_GROUPS = [["models", "models", "Models and voice"], ["permissions", "safety", "Safety"], ["data", "care", "Care"],
  ["trunks", "elsewhere", "Elsewhere in Branch"]];

/** Small line icons (24 × 24, stroked). The Settings pages' own glyphs are the approved sample's (DG-065). */
export const ICON_PATHS = {
  gear: "M12.2 2h-.4a2 2 0 00-2 2v.2a2 2 0 01-1 1.7l-.4.3a2 2 0 01-2 0l-.2-.1a2 2 0 00-2.7.7l-.2.4a2 2 0 00.7 2.7l.2.1a2 2 0 011 1.7v.5a2 2 0 01-1 1.7l-.2.1a2 2 0 00-.7 2.7l.2.4a2 2 0 002.7.7l.2-.1a2 2 0 012 0l.4.3a2 2 0 011 1.7v.2a2 2 0 002 2h.4a2 2 0 002-2v-.2a2 2 0 011-1.7l.4-.3a2 2 0 012 0l.2.1a2 2 0 002.7-.7l.2-.4a2 2 0 00-.7-2.7l-.2-.1a2 2 0 01-1-1.7v-.5a2 2 0 011-1.7l.2-.1a2 2 0 00.7-2.7l-.2-.4a2 2 0 00-2.7-.7l-.2.1a2 2 0 01-2 0l-.4-.3a2 2 0 01-1-1.7V4a2 2 0 00-2-2zM12 15a3 3 0 100-6 3 3 0 000 6z",
  power: "M12 3v8M7 6.5a7 7 0 1010 0",
  folder: "M3 6h6l2 2h10v11H3z",
  people: "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 6.5M18 14a6.5 6.5 0 013.5 6",
  keyboard: "M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4",
  person: "M12 11a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  instructions: "M7 3h7l5 5v13H7zM14 3v5h5",
  trunks: "M9 11a3 3 0 100-6 3 3 0 000 6zM3 20a6 6 0 0112 0M16 11a3 3 0 100-6M21 20a6 6 0 00-4-5.6",
  channels: "M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20a2 2 0 004 0",
  connections: "M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4",
  skills: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
  memory: "M12 5a3 3 0 00-5.8-1A3 3 0 004 9a3 3 0 001 5.5A3 3 0 009 19a3 3 0 003-1M12 5a3 3 0 015.8-1A3 3 0 0120 9a3 3 0 01-1 5.5A3 3 0 0115 19a3 3 0 01-3-1M12 5v13",
  leaf: "M5 19C5 10 11 5 20 4c-1 9-6 15-15 15zM5 19l7-7",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 110 6 3 3 0 010-6z",
  bell: "M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20a2 2 0 004 0",
  chip: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  swap: "M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
  layers: "M12 3 3 8l9 5 9-5zM3 13l9 5 9-5",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
  mic: "M12 3a3 3 0 013 3v5a3 3 0 01-6 0V6a3 3 0 013-3zM6 11a6 6 0 0012 0M12 17v4",
  speaker: "M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 010 6M19.5 6.5a8 8 0 010 11",
  shield: "M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z",
  gauge: "M4 17a8 8 0 1116 0M12 17l4-6",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 018 0v4",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  terminal: "M4 5h16v14H4zM7 10l3 2-3 2M12 15h5",
  globe: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  window: "M3 5h18v14H3zM3 9h18",
  key: "M15 9a4 4 0 11-3.5 6H9v2H7v2H4v-3l6.5-6.5A4 4 0 0115 9z",
  coins: "M12 4c4 0 7 1.3 7 3s-3 3-7 3-7-1.3-7-3 3-3 7-3zM5 7v5c0 1.7 3 3 7 3s7-1.3 7-3V7M5 12v5c0 1.7 3 3 7 3s7-1.3 7-3v-5",
  archive: "M3 4h18v5H3zM5 9v11h14V9M10 13h4",
  wrench: "M14.5 5.5a4 4 0 00-5.2 5.2L4 16l4 4 5.3-5.3a4 4 0 005.2-5.2l-2.6 2.6-2.6-.6-.6-2.6z",
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14",
  refresh: "M20 11a8 8 0 00-14-4.5L4 9M4 4v5h5M4 13a8 8 0 0014 4.5L20 15M20 20v-5h-5",
  help: "M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01",
  warn: "M12 4 2.5 20h19zM12 10v4M12 17h.01",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  general: "M12.2 2h-.4a2 2 0 00-2 2v.2a2 2 0 01-1 1.7l-.4.3a2 2 0 01-2 0l-.2-.1a2 2 0 00-2.7.7l-.2.4a2 2 0 00.7 2.7l.2.1a2 2 0 011 1.7v.5a2 2 0 01-1 1.7l-.2.1a2 2 0 00-.7 2.7l.2.4a2 2 0 002.7.7l.2-.1a2 2 0 012 0l.4.3a2 2 0 011 1.7v.2a2 2 0 002 2h.4a2 2 0 002-2v-.2a2 2 0 011-1.7l.4-.3a2 2 0 012 0l.2.1a2 2 0 002.7-.7l.2-.4a2 2 0 00-.7-2.7l-.2-.1a2 2 0 01-1-1.7v-.5a2 2 0 011-1.7l.2-.1a2 2 0 00.7-2.7l-.2-.4a2 2 0 00-2.7-.7l-.2.1a2 2 0 01-2 0l-.4-.3a2 2 0 01-1-1.7V4a2 2 0 00-2-2zM12 15a3 3 0 100-6 3 3 0 000 6z",
  assistant: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  appearance: "M5 19C5 10 10 5 19 5c0 9-5 14-14 14zM5 19l7-7",
  notifications: "M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20a2 2 0 004 0",
  models: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  accounts: "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 6.5M18 14a6.5 6.5 0 013.5 6",
  voice: "M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3",
  permissions: "M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z",
  computer: "M3 5h18v11H3zM8 20h8M12 16v4",
  secrets: "M15 8a4 4 0 11-3.9 5H7v3H4v-4l6.1-.1A4 4 0 0115 8zM16 8h.01",
  data: "M12 3a9 9 0 110 18 9 9 0 010-18zM12 7a5 5 0 110 10 5 5 0 010-10zM12 11a1 1 0 110 2 1 1 0 010-2z",
  advanced: "M14 6a4 4 0 005 5l-8 8a2 2 0 01-3-3l8-8a4 4 0 01-2-2z",
  about: "M12 21v-9M12 12c0-4-3-6-7-6 0 4 3 6 7 6zM12 12c0-4 3-7 7-7 0 4-3 7-7 7z",
  inbox: "M4 13l2.5-7h11L20 13v5H4zM4 13h4.5l1 2h5l1-2H20",
  automations: "M13 3 5 13h6l-1 8 8-10h-6z",
  library: "M5 4h9a4 4 0 014 4v12H9a4 4 0 01-4-4zM5 16a4 4 0 014-4h9",
  customize: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5a2 2 0 110 4 2 2 0 010-4zM10 15a2 2 0 110 4 2 2 0 010-4z",
};
