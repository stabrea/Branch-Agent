## What changed in 0.19.1

This is a progress release so you can use the work that has already passed review while the remaining queue continues. It contains only merged work; unfinished or blocked pull requests are not hidden inside the download.

### The Grown-Up design is now the real app foundation

- Settings use the shared Grown-Up switches, exact `Off · When needed · On` choices, glass dropdowns, keyboard behavior and screen-reader semantics.
- The conversation shell, composer, model picker, mode controls, Settings navigation and responsive phone/tablet layouts use the adopted design direction.
- Draft edits survive background refreshes and saves already in flight.
- Library tabs stay below the title bar and remain readable while the page scrolls.
- The new Branch mascot now appears in the project documentation; installed-app icon work is still tracked separately.

### Rooms, teamwork and JEV

- Private rooms keep membership, shared history and bounded text artifacts.
- Household sender identity is preserved when a room continues later, and owners can revoke room membership.
- JEV decisions are optional, owner-only and off by default. Low-confidence or malformed answers never become actions.

### Scheduling, mobile and background work

- Schedules can use weekdays, monthly recurrence and ordinary five-field cron expressions in named timezones, including daylight-saving transitions and restart catch-up.
- Android and iOS safety checks, release packaging and update-integrity checks were expanded.
- The background engine is now proved to keep completing tasks after its launcher exits, and the test proves the engine stops cleanly afterward.

### Browser and approval proof

- A signed-in browser session is now exercised across multiple linked pages while preserving the same authorized session.
- Screenshots from both pages are decoded and verified as real, different pictures.
- A multi-page form fixture proves Branch stops to ask before the step that would place an order.
- Sensitive browser actions remain subject to the owner's approval rules.

### Problem reports and reliability

- Owners can opt in to redacted crash and failed-update reports through an already linked owner chat or GitHub connection. Nothing is sent until this is enabled, and the exact selected material can be previewed.
- Every test server must use its own operating-system-selected port, so tests do not collide with the Branch app the owner is using.
- Browser-heavy CI files run separately from ordinary tests, and the five-minute gate correctly recognizes dynamic Playwright and Electron tests.
- Local-model timeout tests no longer grade an overloaded runner's wall-clock speed.
- A narrow sign-in screen keeps the Connect button clickable even if the shared shell stylesheet fails to load.

### Honest status

The recertified product ledger in this release records **116 implemented, 37 partial, 1 external-proof, and 15 missing** capabilities. Work continues after this release. In particular, the linked-wiki approval fix is still in its exhaustive gate, the updater's failed-hand-over recovery has a newly reproduced blocker, and the cache-usage display correction is still under review.

Windows downloads remain unsigned, so Windows may warn about a new executable. Each archive is still checked against its separately published SHA-256 before the updater changes anything. macOS signing depends on the repository's configured signing switch and certificate; the release workflow refuses a half-configured signing setup.

## Update from 0.19.0

Open **Settings → Updates & about** and press **Check for updates**. When 0.19.1 appears, install it there. Branch keeps your conversations, settings, memory and schedules and retains the previous version for rollback.

If the in-app update cannot complete, download the one-step installer from this release page with Branch closed:

- **Windows:** `Install Branch Agent.cmd`
- **macOS and Linux:** `install-branch-agent.sh`

Every desktop archive and installer is published with its checksum. The release is not made visible until every required download and checksum is present.
