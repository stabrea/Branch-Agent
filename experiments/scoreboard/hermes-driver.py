#!/usr/bin/env python3
"""Drive one Hermes Agent turn headlessly, and print one JSON line the runner can read.

Hermes ships no non-interactive CLI flag for "run this one task and stop": ``cli.py`` is a terminal
UI and ``batch_runner.py`` wants a JSONL dataset and a pool of workers. What it does ship is the
class its own docstring points at — ``AIAgent(base_url=..., model=...).run_conversation(text)`` —
so that is what every Hermes row on the scoreboard is: the same object its own README hands a
caller, given one prompt, in the task's folder, against the same endpoint as everybody else.

Everything it writes goes under HERMES_HOME, which the runner points inside /workspace/bench.
"""
import json, os, sys, time

def main() -> int:
    prompt = sys.stdin.read()
    started = time.time()
    out = {"ok": False, "final": "", "error": None, "usage": {}, "turns": None}
    try:
        sys.path.insert(0, os.environ["HERMES_SRC"])
        from run_agent import AIAgent
        agent = AIAgent(
            base_url=os.environ["BENCH_ENDPOINT"],
            api_key=os.environ.get("BENCH_API_KEY", "ollama-local-no-key"),
            model=os.environ["BENCH_MODEL"],
            max_iterations=int(os.environ.get("BENCH_MAX_ROUNDS", "12")),
            quiet_mode=True, save_trajectories=False,
        )
        reply = agent.run_conversation(prompt)
        # Only the answer. Hermes hands back a dict carrying the whole transcript and the model's
        # reasoning as well; handing all of that to a check that looks for a file name would grade
        # Hermes on its thinking while the other two are graded on their answer alone, and would
        # pass it for having merely considered the right file. `final_response` is the same thing
        # Branch's `run.output` and OpenClaw's `final` are.
        if isinstance(reply, dict):
            out["final"] = str(reply.get("final_response") or "")
            for key, source in (("input", "input_tokens"), ("output", "output_tokens")):
                value = reply.get(source)
                if isinstance(value, (int, float)):
                    out["usage"][key] = value
            calls = reply.get("api_calls")
            out["turns"] = calls if isinstance(calls, int) else None
            out["ok"] = bool(reply.get("completed")) and not reply.get("failed")
            if not out["ok"]:
                out["error"] = f"hermes reported completed={reply.get('completed')} failed={reply.get('failed')} exit={reply.get('turn_exit_reason')}"
        else:
            out["final"] = str(reply)
            out["ok"] = True
    except Exception as error:  # noqa: BLE001 — the runner records the blocker verbatim
        out["error"] = f"{type(error).__name__}: {error}"
    out["elapsedMs"] = round((time.time() - started) * 1000)
    print("\n__HERMES_RESULT__" + json.dumps(out))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
