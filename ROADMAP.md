# Branch roadmap

This is a proposed sequence, not a release schedule. All implementation milestones below are pending.

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
