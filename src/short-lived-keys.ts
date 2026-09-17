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
  post("/api/receipts/verify", "checks a task's receipt"),
  post("/api/security-check/run", "runs the security check, which only reads"),
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
  // R17-S-A: the settings file outlives the key, and the owner's own files say who they are.
  /^\/api\/settings-kit\/(export|files)(\/.*)?$/,
];

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
