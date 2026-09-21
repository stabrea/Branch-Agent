# Learning and neural simulation experiments

Python is an optional research component. The TypeScript assistant does not require it.

## Complete cost accounting

`python experiments/accounting.py runs.jsonl --output comparison.json` compares paired baseline and Branch Agent runs. Every JSONL row represents one complete task attempt group (including retries), or a separate learning task. Required fields:

```json
{"run_id":"baseline-heldout-1","task_id":"heldout-1","dataset_id":"my-dataset-v1","variant":"baseline","split":"heldout","success":true,"verifier":"output file matched expected bytes","accounting_complete":true,"elapsed_ms":200,"calls":[{"stage":"execution","measurement":"reported","input_tokens":100,"output_tokens":20}]}
```

This row illustrates the format; its numbers are not a Branch Agent measurement. Supply the matching Branch Agent row and any learning rows. Task IDs for learning must not overlap the held-out set. All planner, delegate, retry, execution, verification and learning calls count, including calls associated with failures. Empty `calls` means no model inference was performed for that task. It does not mean execution was free.

Usage measurements must be marked `reported`, `estimated`, or `synthetic`. Missing prices remain unknown. The comparison never converts a cache discount into a token reduction. Lower success cannot qualify as a token-efficiency improvement. Zero successful tasks has no defined cost per success. Synthetic fixtures validate arithmetic only; they cannot establish real model savings. Ledger completeness and outcome verification need independent checking; the JSON flag is an assertion, not proof.

Run tests:

```sh
python -m unittest discover -s experiments -p "test_*.py" -v
```

## Released connectome model adapter

`experiments/fly_smoke.py` invokes an external installed model. It reads the sensory-neuron IDs from that installation's example notebook without executing the notebook, runs the full stored graph with 0 Hz and 100 Hz stimulation, and records:

- Source revision, input SHA-256 hashes, data sizes and simulator version.
- Neuron and connection counts, random seed and simulated duration.
- Spike counts, responses outside the directly stimulated neurons, and wall time.
- An explicit declaration that the run does not test learning or embodiment.

No model source, connectivity dataset, game assets or trained weights are bundled with Branch. External code and data retain their own terms. Review the exact dataset version's terms separately from the model's code license before redistribution or commercial use.

Create a separate environment (Python 3.12) and install the optional pinned dependencies:

```sh
python -m venv experiments/.venv
# Windows Git Bash:
experiments/.venv/Scripts/python.exe -m pip install -r experiments/requirements-fly.txt
# macOS/Linux use experiments/.venv/bin/python instead.
```

Required external installation layout: `model.py`, `example.ipynb`, `LICENSE`, `2023_03_23_completeness_630_final.csv`, and `2023_03_23_connectivity_630_final.parquet`. The adapter expects `default_params` and `run_exp` from the installed model. Keep model/data outside the Branch Agent distribution.

```sh
experiments/.venv/Scripts/python.exe experiments/fly_smoke.py \
  --model-dir /absolute/path/to/model-installation \
  --output /absolute/path/to/fresh-research-results \
  --duration-ms 100 --seed 42 --trust-model-code
```

The trust flag acknowledges that Python imports and executes the supplied `model.py`; this is not a sandbox. The runner uses NumPy code generation to avoid requiring a native compiler. It can consume substantial memory and CPU despite using zero language-model tokens.

Some versions contain an undefined `w = 0` assignment in the neuron reset expression. `--correct-reset` removes that specific assignment from the parameter passed to the model and records the correction. It does not silently alter external source files. Use a fresh output directory for each experiment to avoid mixing runs.

## What must precede a learning claim

Connecting a network to a task does not automatically train it. A proposed learning controller needs explicit observations, actions, outcome feedback, a learning rule, persistent state, and tests on new tasks. Compare it with the same controller frozen, shuffled feedback, and a simple conventional learning baseline. Check that useful changes persist and disappear when the learned state is removed.

For assistant use, a candidate task is choosing between a verified local procedure and model inference. Measure success, all model calls, local runtime, and learning cost. A fly-derived controller should be promoted only if those measurements justify its additional complexity. A stimulus-response smoke run does not meet that condition.

## JEV decision-gate evidence

The JEV integration's contract tests prove only that Branch validates bounded questions and answers,
keeps state out of process arguments, refuses non-owner configuration, fails closed on invalid output,
and returns low-confidence answers for review. They do not prove decision quality or that JEV is better
than another model.

Before JEV may influence routing, learning promotion, approvals, or policy, run a versioned evaluation
containing labelled `yes`, `pick`, and `score` examples that were not used to tune prompts or settings.
Record the exact JEV revision, provider, model, prompt/schema version, dataset hash and split, retries,
timeouts, latency, provider-reported usage and cost. Report accuracy for categorical decisions,
calibration (including Brier score or log loss) for probabilities, abstention/review rate at the chosen
confidence threshold, and failures separately. Compare against the current Branch path on the exact
same examples and count every retry. A promotion requires no permission widening, no worse verified
task success, and an explicit owner-approved threshold; removing JEV must restore the prior behavior.
