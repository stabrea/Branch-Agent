# Architecture

Branch Agent is a standalone application. It owns its tool execution loop, sessions, state, memory, procedures, specialists and schedules. A configured model supplies completions; another assistant is not required to run Branch.

## Runtime contracts

`Provider.complete` accepts messages, tool descriptions, an output limit and an abort signal. It returns content, tool calls and optional provider-reported usage. Provider responses and tool arguments are validated at runtime. TypeScript types alone cannot validate external data.

The runtime retries eligible rejected model requests inside the completion step. Each attempt consumes the same shared budget and records its own usage evidence. Completed tool results stay in the conversation; only a successful, validated completion is appended. The policy preserves the selected provider and model, excludes partial streams, and bounds both retry counts and waits.

`ToolRegistry` registers named tools, schemas, permissions and handlers. Its executor checks the caller's granted permissions, step budget and cancellation before dispatch. Tool results are bounded and recorded as data. Integrations use this interface instead of modifying the model loop.

The data directory holds private SQLite state. The tool workspace is a separate directory. Workspace tools reject path escapes, symbolic-link traversal and common secret filenames. These checks constrain built-in file tools; they are not an operating-system sandbox for arbitrary code.

## State and recovery

Sessions contain messages. Runs contain execution status and events. Owner-scoped records hold memory, procedures, specialists and schedules. This separation lets a user inspect results without loading all historical content into a model request.

Conversation retrieval uses a local FTS5 index over user and assistant text. Stable source identifiers survive transcript reconciliation even when physical rows are rewritten to insert interrupted tool results. Search/read check the owner and exclude the model's current session; bounded excerpts and pages carry their originating session. The separate `history.read` permission controls access to this history.

Conversation branching atomically copies a valid prefix into a new session with new source identifiers. A separate lineage record preserves the parent session and selected source message. Completed tool evidence is copied as data, while workspace files and owner-scoped memory remain shared. Creating a branch does not execute tools or alter its parent transcript.

The conversation library lists owned histories and transfers versioned JSON archives. Import validates message roles, tool request/result pairing and size before an atomic copy. Archives contain conversation messages, not owner identities, permissions, tasks, workspace files or memory. Imports receive new local identifiers and durable import provenance; duplication and subsequent branches preserve that provenance. Export and duplication wait until the source has no active task.

Memory facts carry edit revisions. Updates compare the expected revision before replacing a fact, and every store-level write observes the owner's configured capacity. Imports preserve fact identifiers and metadata in one transaction; matching records are unchanged and conflicting identifiers reject the entire merge. Legacy facts receive revision 1 and retain their original text/source. Model retrieval selects bounded matches rather than inserting the whole fact store into every request.

Assistant identity is an owner-scoped setting with a revision. A task snapshots its configured name and working instructions before its first model call, retaining that snapshot through tool rounds and retries. The next task reads the latest setting, including when resuming an existing conversation. The applied name/revision is recorded in the run trace. These instructions consume ordinary context budget and do not change the runtime's tool grants.

Interrupted work is marked as interrupted. A crash after a side effect has an uncertain outcome; resuming the reasoning is not permission to repeat the effect. Automatic recovery must reconcile external state or use a destination's idempotency support before replaying it.

## Learning and specialists

A procedure is a versioned sequence of tool calls with preconditions and expected results. Proposal and verification are distinct states. Verification executes real steps, so it can have side effects. Passing one explicit check establishes that check's result, not broad task competence.

A specialist is a versioned instruction set and restricted permission set with an evaluation. Evaluation, promotion and rollback are separate operations. Child runs share the parent's budget and cannot expand its permission set. Specialized prompts alone are not new foundation models.

## Cost decisions

Keeping completed work in structured state, reusing verified procedures and loading relevant context can reduce repeated inference. These are design choices, not measured savings claims. Report provider tokens separately from estimates; retain failures and unknown usage. A language change does not alter token counts for identical model requests.

Use parallel workers when the task benefits enough to pay for their additional context and calls. A short deterministic operation should generally execute as a tool. Model routing should be evaluated against a fixed, competent baseline rather than compared only with an intentionally expensive setup.

## Integration updates

External protocol compatibility is narrower than feature parity. A tool connector does not transfer another engine's internal memory, learning algorithm, channels or interface. Updates need version identity, representative tests, explicit capability grants and rollback. New external features are not automatically granted access to user data.

## Python boundary

Research scripts exchange structured records and use a separate dependency environment. Neural simulation is experimental. Large biological identifiers must remain strings in JSON passed to TypeScript; they exceed JavaScript's exact integer range. See [experiments.md](experiments.md) for the executed model adapter and learning-evaluation requirements.
