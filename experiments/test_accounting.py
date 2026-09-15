"""Behavior checks for accounting, including failures and learning overhead."""
import copy
import unittest

from accounting import compare


def row(variant, task="unseen-1", success=True, tokens=100, split="heldout"):
    return {"run_id": f"{variant}-{task}", "task_id": task, "dataset_id": "fixture",
            "verifier": "fixture exact output", "variant": variant, "split": split,
            "success": success, "accounting_complete": True, "elapsed_ms": 2,
            "calls": [{"stage": "execution", "measurement": "synthetic",
                       "input_tokens": tokens, "output_tokens": 0}]}


class AccountingTests(unittest.TestCase):
    def test_learning_can_eliminate_apparent_saving(self):
        result = compare([row("baseline"), row("branch", tokens=10),
                          row("branch", "learn-1", tokens=100, split="learning")])
        self.assertFalse(result["lower_tokens_per_success_in_this_ledger"])
        self.assertEqual(result["branch"]["tokens_per_verified_success"], 110)

    def test_failed_tasks_still_cost_tokens(self):
        result = compare([row("baseline"), row("branch"),
                          row("baseline", "unseen-2"), row("branch", "unseen-2", False)])
        self.assertEqual(result["branch"]["tokens_per_verified_success"], 200)
        self.assertFalse(result["quality_gate_passed"])

    def test_all_stages_count(self):
        entry = row("branch")
        for stage in ("planner", "delegate", "retry", "learning", "verification"):
            call = copy.deepcopy(entry["calls"][0])
            call["stage"] = stage
            entry["calls"].append(call)
        self.assertEqual(compare([row("baseline"), entry])["branch"]["model_calls"], 6)

    def test_synthetic_savings_are_not_live_claims(self):
        result = compare([row("baseline"), row("branch", tokens=10)])
        self.assertTrue(result["lower_tokens_per_success_in_this_ledger"])
        self.assertFalse(result["supports_live_token_savings_claim"])

    def test_reported_ledger_comparison(self):
        rows = [row("baseline"), row("branch", tokens=10)]
        for entry in rows:
            entry["calls"][0]["measurement"] = "reported"
        self.assertTrue(compare(rows)["supports_live_token_savings_claim"])

    def test_zero_success_is_undefined(self):
        result = compare([row("baseline", success=False), row("branch", success=False)])
        self.assertIsNone(result["branch"]["tokens_per_verified_success"])
        self.assertFalse(result["quality_gate_passed"])

    def test_reject_incomplete_accounting(self):
        entry = row("branch")
        entry["accounting_complete"] = False
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            compare([row("baseline"), entry])

    def test_reject_unpaired_tasks_and_training_leakage(self):
        with self.assertRaisesRegex(ValueError, "same nonempty"):
            compare([row("baseline"), row("branch", "different")])
        with self.assertRaisesRegex(ValueError, "overlap"):
            compare([row("baseline"), row("branch"), row("branch", split="learning") | {"run_id": "learn"}])

    def test_reject_invalid_counts(self):
        for bad in (-1, float("nan"), float("inf"), True, 1.5):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                compare([row("baseline"), row("branch", tokens=bad)])

    def test_missing_prices_are_not_zero_dollars(self):
        self.assertIsNone(compare([row("baseline"), row("branch")])["branch"]["model_cost_usd"])

    def test_reject_mismatched_verifiers(self):
        with self.assertRaisesRegex(ValueError, "same verifier"):
            compare([row("baseline"), row("branch") | {"verifier": "different success rule"}])


if __name__ == "__main__":
    unittest.main()
