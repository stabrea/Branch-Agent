# Running the proof report on the Tower

`proof-report.mjs` answers two questions from real measurements: **did it get better**, and **did
anything that used to work stop working**. It prints one page with an overall verdict (BETTER,
WORSE, NO REAL DIFFERENCE, NOT COMPARABLE), a verdict for each figure, the tasks that stopped and
started passing, and the safety check. It exits with 1 when a task that passed in every baseline
repeat failed in the candidate, or when a safety outcome moved, so it can hold a release back.

It makes real model calls. Run it on the Tower, never from a builder's Mac (`--dry-run` is the only
form that belongs there).

## Facts this runbook is built on

- There is no Dockerfile in the repository. The container below is the official `node:24-bookworm`
  image with the checkouts mounted into it.
- `branch start` listens on `127.0.0.1` only, and refuses requests that claim another host. The
  Branch copies and the harness therefore run **inside the same container** and talk over its
  loopback. No port is published.
- Each copy gets its own data folder (`BRANCH_DATA_DIR`), workspace (`BRANCH_WORKSPACE`) and port
  (`BRANCH_PORT`). Its key is the file `session-token` in its data folder, which it writes on the
  first start.
- The model comes from `BRANCH_PROVIDER` (`openai` or `anthropic`), `BRANCH_ENDPOINT`,
  `BRANCH_MODEL` and `BRANCH_API_KEY`. Give both copies the same model, or the comparison is about
  the model rather than Branch.
- The harness sends every figure through `compare()` in `real-eval.mjs`. A difference counts only
  when the spreads over repeats do not overlap, so use `--repeats 3` or more. One repeat is always
  reported as NOT COMPARABLE.

## 1. Two builds, side by side (this release against the last one)

On the Tower, in a scratch folder (as the `hermes` user, so git does not complain about ownership):

```bash
mkdir -p ~/branch-proof && cd ~/branch-proof
git clone https://github.com/stabrea/Branch-Agent.git before && git -C before checkout <last release tag or sha>
git clone https://github.com/stabrea/Branch-Agent.git after  && git -C after  checkout <candidate sha>

docker run --rm -it --name branch-proof \
  -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  -v "$PWD":/work -w /work node:24-bookworm bash
```

Inside the container:

```bash
for side in before after; do (cd $side && npm ci --no-audit --no-fund && npm run build); done

# The model both copies use. Read the key from wherever it is kept; do not type it into history.
export BRANCH_PROVIDER=openai BRANCH_ENDPOINT=https://api.openai.com/v1 BRANCH_MODEL=<model>
read -rs BRANCH_API_KEY && export BRANCH_API_KEY

start() {  # side port
  mkdir -p /work/$1-data /work/$1-workspace
  BRANCH_DATA_DIR=/work/$1-data BRANCH_WORKSPACE=/work/$1-workspace BRANCH_PORT=$2 \
    node /work/$1/dist/cli.js start > /work/$1.log 2>&1 &
}
start before 3301
start after 3302
sleep 10   # until both logs say "Branch Agent listening"
grep -h "listening" /work/before.log /work/after.log

export BRANCH_EVAL_URL_BEFORE=http://127.0.0.1:3301 BRANCH_EVAL_KEY_BEFORE="$(cat /work/before-data/session-token)"
export BRANCH_EVAL_URL_AFTER=http://127.0.0.1:3302  BRANCH_EVAL_KEY_AFTER="$(cat /work/after-data/session-token)"
# For the tasks that check a file, tell the harness where each copy writes:
export BRANCH_EVAL_WORKSPACE_BEFORE=/work/before-workspace BRANCH_EVAL_WORKSPACE_AFTER=/work/after-workspace

cd /work/after
node experiments/fly-core/proof-report.mjs --dry-run --target builds --repeats 1 --passes 1 --suites cost   # the harness itself, free
node experiments/fly-core/proof-report.mjs --target builds --repeats 3 --passes 1 \
  --out /work/builds.json --md /work/builds.md
echo "exit $?"
```

Always run the harness from the **newer** checkout (`after`): it has to understand both builds'
routes, and it only uses routes that have existed since the evaluation suites did
(`/api/evaluation/run`, `/api/runs/:id/inspect`, `/api/openapi.json`). The copies are measured with
their settings as they are. Nothing is switched for a build comparison.

## 2. The learning core, off against on (PLAN.md section 2)

Same container. Start two copies of the **same** build, each with its own data folder, and:

```bash
export BRANCH_EVAL_URL_OFF=http://127.0.0.1:3301 BRANCH_EVAL_KEY_OFF="$(cat /work/before-data/session-token)"
export BRANCH_EVAL_URL_ON=http://127.0.0.1:3302  BRANCH_EVAL_KEY_ON="$(cat /work/after-data/session-token)"
node experiments/fly-core/proof-report.mjs --target branch --repeats 3 --passes 3 --out /work/core.json --md /work/core.md
```

Here the harness does switch things: before each repeat it has the "on" copy forget what it learned,
and it sets each copy's learning-core switch for its arm.

## 3. Branch against Hermes Agent (PLAN.md section 3)

Hermes runs in the `taofik-ai` VM (see the owner's notes). Point the harness at its
OpenAI-compatible API from a place that can reach it, and measure Branch in the same run window with
the same model:

```bash
export HERMES_EVAL_URL=<hermes api base> HERMES_EVAL_KEY=<key> HERMES_EVAL_MODEL=hermes-agent
export HERMES_EVAL_WORKSPACE=<the folder Hermes writes files into, if the harness can read it>
node experiments/fly-core/real-eval.mjs --target hermes --repeats 3 --passes 1 --out /work/hermes.json
node experiments/fly-core/real-eval.mjs --target builds --repeats 3 --passes 1 --out /work/branch.json
node experiments/fly-core/proof-report.mjs --from /work/hermes.json --from /work/branch.json \
  --baseline "Hermes Agent" --candidate "Branch after" --md /work/versus-hermes.md
```

`--from` reads saved reports together. They must share suites and passes. A self-test cannot be
mixed with a real run, and two targets with the same name are refused. Safety is worked out again
across the combined reports. For Hermes only the plain checks count (`checksSuccessRate`): tasks
that need Branch's own judge or interrupt are left ungraded on its side, and the report says so.

## Reading the page

- **Verdict**: WORSE whenever something stopped passing or a safety outcome moved, whatever else
  improved. BETTER when more tasks passed beyond the spread, or as many passed for fewer
  tokens/dollars/tool calls/time and nothing got dearer. NOT COMPARABLE for a self-test or a single
  repeat.
- **Stopped working**: passed in every baseline repeat, failed in at least one candidate repeat.
  A flaky task (it failed somewhere in the baseline too) is not listed. **Started working**: failed
  in every baseline repeat and passed in every candidate repeat.
- **Safety**: the `safety` suite is run alongside and never counted in the figures. Any change there
  is a bug.
- The versions each copy reported, and the harness commit, are at the top. Addresses and keys are
  never recorded.

Exit codes: `0` nothing stopped working; `1` something stopped working or safety moved (use
`--no-gate` to always get 0); `2` wrong arguments or an unreadable report.

## Cost

Each task is a full model conversation. The five default suites hold 13 tasks (everyday 4, tool-use 3,
reliability 2, cost 2, safety 2). `--repeats 3 --passes 1` over two builds runs every task six times; the learning-core
run with `--passes 3` runs it eighteen times. Read the `Dollars per task` row of a small run
(`--suites cost --repeats 1`) first and multiply before starting the full one.

## Afterwards

```bash
kill %1 %2      # inside the container, or just exit it: --rm removes it
```

The data folders stay in `~/branch-proof` for inspection. Delete them when you are done.
