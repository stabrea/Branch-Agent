/**
 * mac5/key-sweep: what a short-lived key (`branch token create`) may send, in one place.
 *
 * The rule fails closed. A key that is not this computer's own may only look (GET), and a "run"
 * key may in addition use the routes listed here, each of which starts, steers, stops or answers a
 * task, or only looks something up. Every other change — settings, permissions, secrets, the
 * sandbox and network, chat apps and pairing, integrations, backups and restores, updates, profiles —
 * is refused, including any route added later that nobody put on this list.
 *
 * A few reads are refused as well, because what they hand back outlives the key: a trigger's or
 * outgoing webhook's secret, the secret chat-app addresses, and the full backup of every profile.
 *
 * This only decides for short-lived keys. The master key is checked before any of this is asked,
 * so a mistake here can hold up a script and never lock the owner out of the app window.
 */
export interface TaskRoute {
  /** The method the route answers with; "*" for any method other than GET. */
  method: "POST" | "DELETE" | "*";
  pattern: RegExp;
  /** Why a "run" key may use it, in a few words. */
  why: string;
}

const id = "[a-f0-9-]{36}";
const exact = (path: string): RegExp => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const post = (pattern: RegExp | string, why: string): TaskRoute =>
  ({ method: "POST", pattern: typeof pattern === "string" ? exact(pattern) : pattern, why });

/** The routes a "run" key may change something through. Everything else that is not a GET is refused. */
export const shortLivedKeyTaskRoutes: readonly TaskRoute[] = [
  // Starting a task, and talking to Branch the way other programs do.
  post("/api/run", "starts a task"),
  post("/api/action", "runs one tool the approval rules allow outright (src/tool-gate.ts, one gate for every hand-run tool)"),
  post("/api/tools/try", "runs one tool the approval rules allow; a short-lived key cannot confirm its own question"),
  post("/api/commands/run", "a slash command; each command checks the key again"),
  post("/api/goals", "starts working toward a goal"),
  post("/v1/chat/completions", "the OpenAI-style chat"),
  post("/a2a", "another assistant's task"),
  post("/ap/v1/agent/tasks", "an Agent Protocol task"),
  post(new RegExp(`^/ap/v1/agent/tasks/${id}/(steps|artifacts)$`), "an Agent Protocol step or file"),
  { method: "*", pattern: /^\/mcp$/, why: "tool calls from another AI tool; only the tools the owner shared" },
  // Steering, stopping and answering a task that is already going.
  post(new RegExp(`^/api/runs/${id}/(cancel|resume|steer|plan|replay)$`), "stops, resumes, steers or replays a task"),
  post(new RegExp(`^/api/sessions/${id}/(followups|goal|model)$`), "the next message, the goal or the model of one conversation"),
  post("/api/models/switch", "the model of one conversation"),
  post("/api/policy/approve", "answers a question a task asked"),
  post("/api/deferred/settle", "finishes a job a task handed over"),
  post("/api/ask-first", "questions to ask before a task"),
  post("/api/ask-first/answers", "a task prompt with the answers in it"),
  post("/api/processes", "stops a program a task left running"),
  post(new RegExp(`^/api/teams/${id}/run$`), "starts a team on a task"),
  // R17-A: talking to a Trunk, and to a room of Trunks, is a task; changing them is the owner's.
  post(new RegExp(`^/api/trunks/${id}/say$`), "a message to one of the owner's Trunks"),
  post(new RegExp(`^/api/trunks/rooms/${id}/(send|stop)$`), "a message to a room of Trunks, or stopping it"),
  post("/api/queue", "puts a task in the waiting line"),
  post(new RegExp(`^/api/queue/${id}/cancel$`), "takes a task out of the waiting line"),
  post(new RegExp(`^/api/flows/${id}/(run|resume|pause)$`), "runs, resumes or pauses a saved flow"),
  post(new RegExp(`^/api/workflows/${id}/(run|pause)$`), "runs or pauses a saved workflow"),
  post(new RegExp(`^/api/schedules/${id}/trigger$`), "runs a schedule now"),
  post("/api/channels/slack-automations/run", "starts an automation a Slack event is waiting on (mac6/bucket-16)"),
  post(new RegExp(`^/api/monitors/${id}/check$`), "checks a watched page now"),
  // What a task says and hears.
  post("/api/voice/transcribe", "speech to text for a message"),
  post("/api/voice/speak", "reads an answer aloud"),
  post("/api/voice/live", "a live voice conversation"),
  post("/api/voice/command", "whether a phrase is a spoken command"),
  post("/api/media/understand", "what a video or sound file shows and says"),
  post("/api/artifacts/page", "an address for a reply's page"),
  post("/api/artifacts/save", "keeps a reply's page beside its task"),
  post("/api/mcp/app", "an address for a page a tool sent"),
  // Looking things up; sent with POST only because the question is long.
  post("/api/sessions/search", "searches conversations"),
  post("/api/memory/search", "searches what is remembered"),
  post("/api/documents/search", "searches documents"),
  post("/api/knowledge/search", "searches knowledge bases"),
  post("/api/knowledge/ask", "asks the knowledge bases"),
  post("/api/retrieval/search", "searches passages"),
  post("/api/tools/meaning-search", "finds a tool by what it does"),
  // R17-F (src/learning-more/api.ts): finding past conversations by meaning, and facts by label and date.
  post("/api/learning-more/search", "searches conversations by meaning"),
  post("/api/learning-more/memory/find", "searches what is remembered by label and date"),
  post("/api/receipts/verify", "checks a task's receipt"),
  post("/api/security-check/run", "runs the security check, which only reads"),
  // mac7/r17-d: the project's review checks (read-only helpers) and a conversation forked into its own copy.
  post("/api/coding/checks/run", "runs the project's review checks, each by a helper that may only read"),
  post("/api/coding/worktrees/fork", "carries a conversation on in its own copy of the project"),
  // r17-i: another of the owner's computers hands a message to a Trunk here with the "run" key it was given;
  // the message is quoted as that computer's text, capped and limited per hour (src/reach/remote-trunks.ts).
  post("/api/reach/trunks/inbox", "a message from a Trunk on another of the owner's computers"),
  // mac7/r17-g: the safety extras. Everything else under /api/safety-extras (the switches, letting the
  // emergency stop go, setting up authenticator codes, installing or running WebAssembly add-ons) is
  // refused by the rule above. Reading /api/safety-extras is allowed: it never carries the code key.
  post("/api/safety-extras/activity/verify", "checks the tamper-evident activity chain, which only reads"),
  post("/api/safety-extras/scan", "checks one command for hidden codes and look-alike letters, which only reads"),
  post("/api/safety-extras/stop", "presses the emergency stop, which only stops things; letting it go is the owner's"),
  post("/api/safety-extras/codes/confirm", "types an authenticator code for a question it may answer"),
  // w911 (A1753) hook: an accepted page test scenario, run through the suite runner.
  post(new RegExp(`^/api/qa/scenarios/${id}/run$`), "runs a page test the owner already accepted"),
  // w911 (A2144) hook: a page note is work for a task, and a dealt-with one is taken off the list.
  post("/api/browser/notes", "points a task at one thing on a web page"),
  post(new RegExp(`^/api/browser/notes/${id}/resolve$`), "marks a page note as dealt with"),
];

/** Reads a short-lived key may not make: what they return is a secret, or everybody's data. */
const ownerOnlyReads: readonly RegExp[] = [
  /^\/api\/backup$/,
  new RegExp(`^/api/(triggers|webhooks)(/${id})?$`),
  /^\/api\/channels\/addresses$/,
  // integration review (bucket 16, merged into bucket 19): the waiting Slack events carry message text.
  /^\/api\/channels\/slack-automations$/,
  // bucket 19: who may sign in, their linked accounts and devices, and the share list.
  /^\/api\/people\/(settings|shares\/export)$/,
  // mac6/bucket-23 (A2240): the live pages' list carries each page's frame address, which opens without a key.
  /^\/api\/asks\/surfaces$/,
  // mac7/nodes: the owner's devices, their switches and who they are shared with. Changes are refused
  // by the fail-closed rule above; the device socket and pairing carry their own proof, not a key.
  /^\/api\/devices(\/.*)?$/,
  // R17-S-A: the settings file outlives the key, and the owner's own files say who they are.
  /^\/api\/settings-kit\/(export|files)(\/.*)?$/,
  // mac7/r17-d: the shell snapshot holds the owner's PATH, aliases and functions.
  /^\/api\/coding\/shell$/,
  // R17-C: the owner's mail, calendar, house, sign-ins and public webhook address (src/personal/api.ts).
  /^\/api\/personal(\/|$)/,
  // r17-h integration review: the widgets' list carries each widget's frame address, which opens without a key.
  /^\/api\/flows-boards\/widgets$/,
];

/**
 * R17-S-B: the hidden knobs (`knobsRoutes` in src/knobs/api.ts) are the owner's alone. Reading
 * them is a look; every change is refused to a short-lived key, because the cards include which
 * environment variables commands are given, how key-like values are hidden, and the launch file.
 */
export const knobsRefusal =
  "A short-lived key cannot change Branch's limits, which environment variables commands get, or how keys are hidden. Do that in the app window.";

/**
 * R17-E: how models are chosen and what they may spend (`savingsRoutes` in src/model-savings/api.ts).
 * Reading the cards and one conversation's rounds is a look; every change is the owner's alone,
 * because the cards can add model calls (a classifier, cache pings, mixtures) that cost money.
 */
export const savingsRefusal =
  "A short-lived key cannot change how models are chosen or what they may spend. Do that in the app window.";

/**
 * R17-S-C: the comfort settings (`/api/comfort`, `/api/comfort/update-plan`, `/api/comfort/status`, src/comfort/api.ts) are
 * the owner's alone. Reading them is a look (a proxy address and public certificates are not
 * secrets); every change is refused to a short-lived key, because the cards include the proxy, the
 * trusted certificates, how carefully the browser acts and whether Branch installs updates.
 */
export const comfortRefusal =
  "A short-lived key cannot change shortcuts, notifications, updates, the browser's care, the proxy or certificates. Do that in the app window.";

export const generalShortLivedKeyRefusal =
  "A short-lived key can start, steer and stop tasks, but cannot change settings, permissions or security. Do that in the app window.";
export const ownerOnlyReadRefusal =
  "A short-lived key cannot read secrets or the full backup. Do that in the app window.";

/** True when a "run" key may send this request (reads aside, which ownerOnlyRead decides). */
export function taskRouteFor(method: string | undefined, path: string): TaskRoute | null {
  const verb = method ?? "GET";
  return shortLivedKeyTaskRoutes.find((route) => (route.method === "*" || route.method === verb) && route.pattern.test(path)) ?? null;
}

/** The refusal for a GET a short-lived key may not make, or null. */
export function ownerOnlyRead(path: string): string | null {
  return ownerOnlyReads.some((pattern) => pattern.test(path)) ? ownerOnlyReadRefusal : null;
}
