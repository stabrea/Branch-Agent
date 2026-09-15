"""Run an installed, trusted connectome model; no model source or data is bundled."""
from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.util
import json
import math
import subprocess
import time
from pathlib import Path


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stimulus_ids(notebook: Path) -> list[int]:
    cells = json.loads(notebook.read_text(encoding="utf-8"))["cells"]
    for cell in cells:
        if cell.get("cell_type") != "code":
            continue
        source = "".join(cell["source"])
        if "neu_sugar =" not in source:
            continue
        for node in ast.parse(source).body:
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "neu_sugar" for target in node.targets
            ):
                values = ast.literal_eval(node.value)
                if not values or not all(type(value) is int for value in values):
                    raise ValueError("Invalid stimulus IDs")
                return values
    raise ValueError("No documented sugar stimulus list found")


def load_model(folder: Path):
    spec = importlib.util.spec_from_file_location("branch_external_fly_model", folder / "model.py")
    if spec is None or spec.loader is None:
        raise ValueError("No model.py module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def reset_expression(original: str, correct: bool) -> str:
    if not correct:
        return original
    if "w = 0;" not in original:
        raise ValueError("Requested reset correction does not match this model version")
    return original.replace("w = 0;", "")


def provenance(folder: Path, files: list[Path]) -> dict:
    commit = subprocess.run(["git", "-C", str(folder), "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    return {"git_commit": commit, "files": [
        {"name": path.name, "bytes": path.stat().st_size, "sha256": checksum(path)} for path in files
    ]}


def prepare_output(output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    names = ("report.json", "stimulus-0hz.parquet", "stimulus-100hz.parquet")
    if any((output / name).exists() for name in names):
        raise ValueError("Use a fresh output directory; prior experiment files are preserved")


def run_condition(module, folder: Path, output: Path, ids: list[int], args, rate: int) -> dict:
    import brian2 as brian
    import pandas as pd

    brian.start_scope()
    brian.seed(args.seed)
    params = dict(module.default_params)
    params.update(n_run=1, t_run=args.duration_ms * brian.ms, r_poi=rate * brian.Hz)
    params["eq_rst"] = reset_expression(params["eq_rst"], args.correct_reset)
    name = f"stimulus-{rate}hz"
    if (output / f"{name}.parquet").exists():
        raise ValueError("Use a fresh output directory; existing measurements are not overwritten")
    start = time.perf_counter()
    module.run_exp(name, ids, output, folder / "2023_03_23_completeness_630_final.csv",
                   folder / "2023_03_23_connectivity_630_final.parquet", params=params, n_proc=1)
    elapsed = time.perf_counter() - start
    spikes = pd.read_parquet(output / f"{name}.parquet")
    downstream = spikes[~spikes["flywire_id"].isin(ids)]
    return {"rate_hz": rate, "wall_seconds": elapsed, "spikes": len(spikes),
            "active_neurons": int(spikes["flywire_id"].nunique()),
            "non_stimulated_neuron_spikes": len(downstream),
            "mn9_spikes": int((spikes["flywire_id"] == 720575940660219265).sum()),
            "parquet_sha256": checksum(output / f"{name}.parquet")}


def execute(args) -> dict:
    import brian2 as brian
    import pandas as pd
    import pyarrow.parquet as parquet

    folder, output = args.model_dir.resolve(), args.output.resolve()
    files = [folder / name for name in ("model.py", "example.ipynb", "LICENSE",
             "2023_03_23_completeness_630_final.csv", "2023_03_23_connectivity_630_final.parquet")]
    for path in files:
        if not path.is_file():
            raise ValueError(f"Missing required model input: {path.name}")
    prepare_output(output)
    module = load_model(folder)
    ids = stimulus_ids(folder / "example.ipynb")
    brian.prefs.codegen.target = "numpy"
    metadata = provenance(folder, files)
    metadata.update(schema_version=1, brian2_version=brian.__version__, seed=args.seed,
                    simulated_ms_per_condition=args.duration_ms,
                    neurons=len(pd.read_csv(files[3])), connections=parquet.read_metadata(files[4]).num_rows,
                    stimulus_ids=[str(value) for value in ids],
                    reset_correction_applied=args.correct_reset, model_tokens=0,
                    learning_test=False, embodied_simulation=False)
    metadata["original_reset"] = module.default_params["eq_rst"]
    metadata["effective_reset"] = reset_expression(metadata["original_reset"], args.correct_reset)
    metadata["conditions"] = [run_condition(module, folder, output, ids, args, rate) for rate in (0, 100)]
    metadata["limitations"] = ["Single seed; one short trial per condition.",
        "No plasticity or learning rule is added; this measures stimulus response only.",
        "No simulated body is connected and no assistant capability is established.",
        "Zero model tokens excludes the CPU, memory, energy and setup costs of simulation.",
        "External model code and data have their own license terms; neither is bundled."]
    with (output / "report.json").open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(metadata, indent=2) + "\n")
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--duration-ms", type=float, default=100)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--trust-model-code", action="store_true", required=True,
                        help="Explicitly authorize importing model.py from the supplied directory")
    parser.add_argument("--correct-reset", action="store_true",
                        help="Remove the undefined neuron reset assignment w=0; record the change")
    args = parser.parse_args()
    if not math.isfinite(args.duration_ms) or not 0 < args.duration_ms <= 10000:
        parser.error("duration-ms must be finite and between 0 and 10000")
    if not 0 <= args.seed < 2**32:
        parser.error("seed must be an unsigned 32-bit integer")
    print(json.dumps(execute(args), indent=2))


if __name__ == "__main__":
    main()
