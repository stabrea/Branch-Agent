"""Fixture checks validate the adapter only, not neuroscience."""
import json
import tempfile
import unittest
from pathlib import Path

from fly_smoke import checksum, stimulus_ids, reset_expression, prepare_output


class FlyAdapterTests(unittest.TestCase):
    def test_preserves_reports_even_without_parquet_files(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            report = output / "report.json"
            report.write_text("original")
            with self.assertRaisesRegex(ValueError, "fresh output"):
                prepare_output(output)
            self.assertEqual(report.read_text(), "original")

    def test_reset_correction_is_explicit_and_version_checked(self):
        self.assertEqual(reset_expression("v = 0; w = 0; g = 0", False), "v = 0; w = 0; g = 0")
        self.assertEqual(reset_expression("v = 0; w = 0; g = 0", True), "v = 0;  g = 0")
        with self.assertRaises(ValueError):
            reset_expression("different model", True)

    def test_reads_documented_ids_without_executing_notebook(self):
        with tempfile.TemporaryDirectory() as directory:
            notebook = Path(directory) / "example.ipynb"
            notebook.write_text(json.dumps({"cells": [{"cell_type": "code", "source": [
                "neu_sugar = [720575940624963786]\nraise Exception('not executed')"]}]}))
            self.assertEqual(stimulus_ids(notebook), [720575940624963786])

    def test_rejects_executable_stimulus_expression(self):
        with tempfile.TemporaryDirectory() as directory:
            notebook = Path(directory) / "example.ipynb"
            notebook.write_text(json.dumps({"cells": [{"cell_type": "code", "source": [
                "neu_sugar = list(range(5))"]}]}))
            with self.assertRaises(ValueError):
                stimulus_ids(notebook)

    def test_digest_detects_changed_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data"
            path.write_bytes(b"first")
            before = checksum(path)
            path.write_bytes(b"second")
            self.assertNotEqual(before, checksum(path))


if __name__ == "__main__":
    unittest.main()
