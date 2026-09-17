import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import { InputsSchema } from "../recipes.js";
import type { ToolRegistry } from "../registry.js";
import { ownersOwnTask } from "../autonomy/origin.js";
import type { FlowsBoards } from "./index.js";
import { CardInputSchema, HandoffSchema, MoveSchema } from "./kanban.js";
import { boardWriter, fromChat } from "./origin.js";
import type { BoardPart } from "./settings.js";
import { WidgetSchema } from "./widgets.js";
import { InstallRequestSchema } from "./install-requests.js";

/**
 * R17-H: the assistant's side. Each part's tools are in the catalog only while its switch is not off
 * (src/flows-boards/index.ts). None of them approves anything: a widget and an install are questions
 * for the owner, and a card only becomes work when the owner presses Work on it.
 */
type Registrar = (registry: ToolRegistry, boards: FlowsBoards) => void;
const id = z.string().uuid();

function writer(boards: FlowsBoards, context: ToolContext): void {
  if (!boardWriter(boards.store, context.runId))
    throw new Error("Only the owner's own work can change the board; a chat message, a key or another program cannot.");
}

const timeTravel: Registrar = (registry, boards) => {
  registry.register({ name: "flow.steps", permission: "workflows.read",
    description: "Every step of one run of a saved flow, with the values it held after each step. Reading only; going back to a step is the owner's, in Automations.",
    parameters: z.object({ runId: id }).strict(),
    execute: async (args) => boards.timeTravel.steps(args.runId) });
};

const recipeChecks: Registrar = (registry, boards) => {
  registry.register({ name: "procedures.replay_checked", permission: "procedures.use",
    description: "Replay a verified saved procedure with the checks, clean-up, time limit and number of tries the owner set for it. Stops at once if the approval rules want to ask.",
    parameters: z.object({ id, inputs: InputsSchema.optional() }).strict(),
    execute: async (args, context) => boards.recipes.run(args.id, args.inputs ?? {},
      { mode: "policy", source: context.source ?? "owner", runId: context.runId, permissions: context.permissions }) });
};

const kanban: Registrar = (registry, boards) => {
  registry.register({ name: "board.cards", permission: "boards.read",
    description: "The shared board of a project (the active one when none is named): its cards in lanes to do, doing, to check, done and stuck, with who has each.",
    parameters: z.object({ project: z.string().trim().min(1).max(64).optional() }).strict(),
    execute: async (args) => boards.kanban.view(args.project) });
  registry.register({ name: "board.card_add", permission: "boards.write",
    description: "Add a card to \"to do\" on the shared board. It is not worked on until the owner starts it.",
    parameters: CardInputSchema,
    execute: async (args, context) => { writer(boards, context); return boards.kanban.add(args, "assistant"); } });
  registry.register({ name: "board.card_move", permission: "boards.write",
    description: "Move a card between to do, doing and to check. Done and stuck are the owner's.",
    parameters: MoveSchema.extend({ id }).strict(),
    execute: async ({ id: card, ...move }, context) => { writer(boards, context); return boards.kanban.move(card, move, "assistant"); } });
  registry.register({ name: "board.card_handoff", permission: "boards.write",
    description: "Hand a card to somebody else (the owner, the assistant or a specialist by name) with a note saying why.",
    parameters: HandoffSchema.extend({ id }).strict(),
    execute: async ({ id: card, ...handoff }, context) => { writer(boards, context); return boards.kanban.handoff(card, handoff, "assistant"); } });
};

const widgets: Registrar = (registry, boards) => {
  registry.register({ name: "widgets.list", permission: "widgets.read",
    description: "The live widgets on the owner's dashboard, and the widget ideas waiting for an answer.",
    parameters: z.object({}).strict(),
    execute: async () => ({ widgets: boards.widgets.list(), waiting: boards.widgets.waiting() }) });
  registry.register({ name: "widgets.propose", permission: "widgets.propose",
    description: "Suggest a live widget: a title, a tool that only looks something up, its arguments, how often to ask again, and why. The owner says yes or no; nothing shows until then.",
    parameters: WidgetSchema,
    execute: async (args, context) => {
      if (!ownersOwnTask(boards.store, context.runId)) throw new Error("Only the owner's own conversation can suggest a widget.");
      return boards.widgets.propose(args);
    } });
};

const installs: Registrar = (registry, boards) => {
  registry.register({ name: "install.request", permission: "installs.request",
    description: "Ask the owner for a new package (npm or PyPI) or a new tool server. The public list of harmful packages is checked first; only the owner can say yes, and nothing is installed by asking.",
    parameters: InstallRequestSchema,
    execute: async (args, context) => {
      const chat = Boolean(context.runId) && fromChat(boards.store, context.runId);
      return boards.installs.request(args, chat ? "chat" : "assistant", chat ? "a chat app" : "the assistant");
    } });
  registry.register({ name: "install.requests", permission: "installs.read",
    description: "The requests for packages and tool servers, and the owner's answers. An approved one says exactly what to run or add; it is not installed.",
    parameters: z.object({}).strict(),
    execute: async () => ({ requests: boards.installs.list().slice(-30) }) });
};

export const registrars: Record<BoardPart, Registrar | null> = {
  "time-travel": timeTravel, "recipe-checks": recipeChecks, kanban, widgets,
  "waiting-line": null, focus: null, "install-requests": installs,
};
