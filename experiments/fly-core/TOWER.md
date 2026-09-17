# Proof Report: Running on the Tower

The proof report proves that Branch Agent's learning core (src/fly-core) makes real tasks go better,
and did not break what used to work. This runbook covers building the containers and comparing two
versions.

## Prerequisites

- Two copies of Branch Agent built as Docker containers, each with a separate data folder
- Or: two sets of saved report JSON files from earlier runs (to combine with --from)
- The offline demo provider (for --dry-run testing, safe to run on this Mac)

## Strategy: full release proof (before/after)

To prove a release works, you run two Branch containers:
1. **before**: the previous stable version (or the baseline build)
2. **after**: the new build with the learning core enabled

Each runs with its own data folder, so they don't learn from each other. The proof report compares
the last pass of each at the end.

## Build the containers

From the repository root (after `npm run build`):

```bash
# Build the Docker image from the Dockerfile
docker build -t branch-agent:test -f docs/Dockerfile .

# Create two containers with separate data folders
docker run -d --name branch-before -p 8001:3000 -v /path/to/data-before:/app/data branch-agent:test
docker run -d --name branch-after  -p 8002:3000 -v /path/to/data-after:/app/data  branch-agent:test

# Wait for them to be ready (check logs or hit /api/status)
docker logs branch-before | grep "listening"
docker logs branch-after | grep "listening"
```

If you need to restart:
```bash
docker stop branch-before branch-after
docker rm branch-before branch-after
```

## Get the container token

Each container prints its API token on startup. Grab it from the logs:

```bash
BEFORE_TOKEN=$(docker logs branch-before | grep "token=" | grep -o "token=[^ ]*" | head -1 | cut -d= -f2)
AFTER_TOKEN=$(docker logs branch-after | grep "token=" | grep -o "token=[^ ]*" | head -1 | cut -d= -f2)

echo "Before: $BEFORE_TOKEN"
echo "After:  $AFTER_TOKEN"
```

## Run the proof

From this directory (experiments/fly-core):

```bash
# Dry-run first: this tests the harness against the demo provider, it's safe.
node proof-report.mjs --dry-run --repeats 1 --passes 1 --out dry-run.json

# Real proof: compares before/after (can take hours and will cost money)
BRANCH_EVAL_URL_BEFORE=http://localhost:8001 \
BRANCH_EVAL_KEY_BEFORE="$BEFORE_TOKEN" \
BRANCH_EVAL_URL_AFTER=http://localhost:8002 \
BRANCH_EVAL_KEY_AFTER="$AFTER_TOKEN" \
node proof-report.mjs --target branch --repeats 3 --passes 3 --out report.json

# Output is written to stdout and saved to report.json (JSON format)
```

## Pass options

- `--repeats N` : How many times to repeat the whole measurement (default 3). More repeats = tighter confidence intervals.
- `--passes N` : How many times each suite runs in a row (default 3). The learning core needs passes to learn from.
- `--suites s1,s2,...` : Which suites to run (default: everyday, tool-use, reliability, cost, safety). Use a subset to go faster.
- `--target` : `branch` (default) or `hermes` (for Hermes Agent).
- `--dry-run` : Use the offline demo provider, no real models, safe to run on this Mac.
- `--out file.json` : Save the raw report JSON (you can combine later with `--from`).
- `--no-gate` : Exit 0 even if regressions exist (default: exit 1 on regression or safety change).

## Combine separate runs

If you ran the before and after builds separately, you can combine the saved reports:

```bash
node proof-report.mjs --from before-report.json --from after-report.json
```

This merges the arms and recomputes the comparison. Validates that both reports use the same
suites and passes; errors if they don't.

## Read the report

Output is in Markdown: one line per metric (better / worse / no difference / not comparable), plus
tables showing means and ranges, and lists of regressions and fixes.

**Pass**: branch passes more tasks → better.
**Token/dollar/ms**: lower is better.
**Advice used**: not a quality metric, reported for context only.
**No real difference**: the change is inside the range of the repeats, so it's noise.
**Not comparable**: missing data, only one repeat, or different agent kinds.

## Exit codes

- `0` : all is well, no regressions, no safety change
- `1` : regressions found OR safety outcomes differ (a bug to investigate)

Use `--no-gate` to exit 0 anyway (for logging or archival).

## Cost warning

Real runs call a language model many times:
- `--repeats 3 --passes 3` on one suite (say, "everyday" with ~40 tasks): ~360 model calls
- Five suites (default): ~1,800 calls
- At $0.001 per call (rough cost), that's $1.80 per run

Three full runs × five suites = ~$5.40 total. The Tower coordinator can budget for this.
On your Mac with the demo provider, use `--dry-run`: it costs nothing and tests the harness.

## Known limits

- The learning core's advice is applied when the switch is "on" (see docs/configuration.md).
- The report measures the last pass of each repeat: the core has had time to learn.
- Safety checks are run in parallel with the main suites; a regression in safety is a bug.
- BrowserGym and Hermes are not available in this branch yet (Wave 7 + 8 future work).
