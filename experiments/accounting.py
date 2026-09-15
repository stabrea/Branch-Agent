"""Compare complete, paired run ledgers; never infer savings from prompt length."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

STAGES = {"planner", "delegate", "retry", "learning", "execution", "verification"}


def nonnegative(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be finite and nonnegative")
    return value


def validate_call(call: dict[str, Any]) -> None:
    if call.get("stage") not in STAGES:
        raise ValueError("Every call must identify its accounting stage")
    if call.get("measurement") not in {"reported", "estimated", "synthetic"}:
        raise ValueError("Unreported usage cannot support a cost comparison")
    for key in ("input_tokens", "output_tokens"):
        number = nonnegative(call.get(key), key)
        if int(number) != number:
            raise ValueError("Token counts must be integers")
    if "cost_usd" in call:
        nonnegative(call["cost_usd"], "cost_usd")


def validate_record(record: dict[str, Any]) -> None:
    for key in ("run_id", "task_id", "dataset_id", "verifier"):
        if not isinstance(record.get(key), str) or not record[key].strip():
            raise ValueError(f"Missing {key}")
    if record.get("variant") not in {"baseline", "branch"}:
        raise ValueError("variant must be baseline or branch")
    if record.get("split") not in {"learning", "heldout"}:
        raise ValueError("split must be learning or heldout")
    if type(record.get("success")) is not bool:
        raise ValueError("success must be an independently checked boolean")
    if record.get("accounting_complete") is not True:
        raise ValueError("Incomplete call accounting cannot establish savings")
    calls = record.get("calls")
    if not isinstance(calls, list):
        raise ValueError("calls must include every attempted model call")
    for call in calls:
        if not isinstance(call, dict):
            raise ValueError("Each call must be an object")
        validate_call(call)
    nonnegative(record.get("elapsed_ms"), "elapsed_ms")


def load_ledger(path: Path) -> list[dict[str, Any]]:
    records = []
    seen: set[str] = set()
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            if not isinstance(record, dict):
                raise ValueError("Record must be an object")
            validate_record(record)
            if record["run_id"] in seen:
                raise ValueError("Duplicate run_id")
            seen.add(record["run_id"])
            records.append(record)
        except (ValueError, TypeError) as error:
            raise ValueError(f"Line {number}: {error}") from error
    if not records:
        raise ValueError("The ledger is empty")
    return records


def paired_tasks(records: list[dict[str, Any]]) -> None:
    keys: dict[str, set[tuple[str, str]]] = {"baseline": set(), "branch": set()}
    verifiers: dict[tuple[str, str], str] = {}
    for record in records:
        if record["split"] != "heldout":
            continue
        key = (record["dataset_id"], record["task_id"])
        if key in verifiers and verifiers[key] != record["verifier"]:
            raise ValueError("Paired tasks must use the same verifier")
        verifiers[key] = record["verifier"]
        if key in keys[record["variant"]]:
            raise ValueError("Retries must be accounted within one task record")
        keys[record["variant"]].add(key)
    if not keys["baseline"] or keys["baseline"] != keys["branch"]:
        raise ValueError("Both variants must evaluate the same nonempty held-out tasks")
    learned = {(r["dataset_id"], r["task_id"]) for r in records if r["split"] == "learning"}
    if learned & keys["baseline"]:
        raise ValueError("Learning and held-out task IDs overlap")


def summarize(records: list[dict[str, Any]], variant: str) -> dict[str, Any]:
    selected = [r for r in records if r["variant"] == variant]
    heldout = [r for r in selected if r["split"] == "heldout"]
    calls = [call for row in selected for call in row["calls"]]
    tokens = sum(c["input_tokens"] + c["output_tokens"] for c in calls)
    successes = sum(r["success"] for r in heldout)
    learning = [c for r in selected if r["split"] == "learning" for c in r["calls"]]
    costs_complete = all("cost_usd" in c for c in calls)
    cost = sum(c.get("cost_usd", 0) for c in calls) if costs_complete else None
    return {
        "heldout_tasks": len(heldout), "verified_successes": successes,
        "success_rate": successes / len(heldout), "model_calls": len(calls),
        "total_tokens_including_learning_and_failures": tokens,
        "learning_tokens": sum(c["input_tokens"] + c["output_tokens"] for c in learning),
        "tokens_per_verified_success": tokens / successes if successes else None,
        "model_cost_usd": cost,
        "model_cost_usd_per_success": cost / successes if cost is not None and successes else None,
        "total_elapsed_ms": sum(r["elapsed_ms"] for r in selected),
        "measurement_types": sorted({c["measurement"] for c in calls}),
    }


def compare(records: list[dict[str, Any]]) -> dict[str, Any]:
    for record in records:
        validate_record(record)
    if len({r["run_id"] for r in records}) != len(records):
        raise ValueError("Duplicate run_id")
    paired_tasks(records)
    baseline, branch = (summarize(records, name) for name in ("baseline", "branch"))
    complete_success = branch["verified_successes"] > 0
    quality_gate = complete_success and branch["success_rate"] >= baseline["success_rate"]
    observed = all(c["measurement"] == "reported" for r in records for c in r["calls"])
    left, right = baseline["tokens_per_verified_success"], branch["tokens_per_verified_success"]
    improvement = quality_gate and left is not None and right is not None and right < left
    return {
        "schema_version": 1, "baseline": baseline, "branch": branch,
        "quality_gate_passed": quality_gate,
        "all_model_usage_provider_reported": observed,
        "lower_tokens_per_success_in_this_ledger": bool(improvement),
        "supports_live_token_savings_claim": bool(improvement and observed),
        "limits": ["Ledger completeness and verifier correctness require external audit.",
                   "One dataset does not establish general superiority or statistical significance.",
                   "Model token accounting excludes local compute, storage and service costs.",
                   "No calls means no model-token cost; it does not mean no computing cost."],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ledger", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        result = json.dumps(compare(load_ledger(args.ledger)), indent=2)
    except ValueError as error:
        parser.exit(2, f"Invalid ledger: {error}\n")
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result + "\n", encoding="utf-8")
    else:
        print(result)


if __name__ == "__main__":
    main()
