# Branch Agent roadmap

This is a capability roadmap, not a release schedule. The initial runtime and native Windows application now execute local tasks. The full 169-entry acceptance inventory remains open; [feature coverage](docs/features.md) records individual gaps.

## Current implementation

- Native Windows window and tray, shared web interface, and persisted appearance.
- Model adapters, durable task/tool state, scoped workspace tools and memory.
- Restricted specialists, versioned procedures, schedules, MCP and browser tools.
- Streaming terminal chat, full-text conversation retrieval and configured host commands.
- Separate neural-model experiment and total-task accounting utilities.

## Remaining breadth

The remaining inventory includes messaging channels, voice and multimedia, richer memory and context retrieval, tool discovery and plugin distribution, remote execution, broader scheduling, model routing, native installers and updates, mobile surfaces, and learning evaluations. Protocol support alone does not complete those capabilities. Experimental learning needs measured improvement before any efficiency or generality claim.

## 1. Establish the core

- Choose and document the runtime and development setup.
- Define a task, its execution state, its permissions, and its result.
- Complete one useful task through a minimal assistant interface.

**Completion evidence:** a reproducible example with an observable result and documented failure behavior.

## 2. Coordinate specialists

- Define an adapter interface for tools and specialist agents.
- Assign bounded work and track dependencies between tasks.
- Integrate results and verify the requested outcome.

**Completion evidence:** one task completed through two specialists, including a handled failure.

## 3. Retain useful experience

- Save reusable procedures with their supporting examples.
- Evaluate a candidate procedure on a different input before adopting it.
- Allow users to inspect and remove retained experience.

**Completion evidence:** repeatable evaluation showing whether the saved procedure helps on new examples.

## 4. Make upgrades dependable

- Track component versions and compatibility requirements.
- Evaluate upgrades before activation.
- Restore the previous working version when an upgrade fails.

**Completion evidence:** a real component update that passes compatibility checks and a failed update that leaves the working version available.

## 5. Measure efficiency

- Track model usage, latency, retries, and task completion.
- Compare direct execution with delegation.
- Load only the tools and context needed for a task.

**Completion evidence:** published measurements of cost per successful task using a documented evaluation set.
