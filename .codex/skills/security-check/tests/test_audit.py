from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "audit.py"
POWERSHELL_SCRIPT = SCRIPT.with_name("audit.ps1")


class AuditCliTest(unittest.TestCase):
    def run_audit(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

    def test_vulnerable_source_returns_json_and_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "danger.ts"
            source.write_text(
                "export function run(url: string) { eval(url); return fetch(url); }\n",
                encoding="utf-8",
            )

            result = self.run_audit("--files-only", "--json", str(source))

        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        ids = {finding["id"] for finding in payload["findings"]}
        self.assertIn("A03-001", ids)
        self.assertIn("A10-001", ids)

    def test_safe_source_returns_success(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "safe.ts"
            source.write_text("export const value = 42;\n", encoding="utf-8")

            result = self.run_audit("--files-only", "--json", str(source))

        self.assertEqual(result.returncode, 0)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["summary"]["total_findings"], 0)

    def test_markdown_report_is_written(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "safe.ts"
            report = Path(directory) / "report.md"
            source.write_text("export const value = 42;\n", encoding="utf-8")

            result = self.run_audit("--files-only", "--report", str(report), str(source))

            self.assertEqual(result.returncode, 0)
            self.assertTrue(report.exists())
            contents = report.read_text(encoding="utf-8")
            self.assertIn("# Security Audit Report", contents)
            self.assertIn("Release Decision", contents)

    @unittest.skipUnless(sys.platform == "win32", "PowerShell wrapper is Windows-specific")
    def test_powershell_wrapper_forwards_arguments_and_exit_code(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "safe.ts"
            source.write_text("export const value = 42;\n", encoding="utf-8")
            result = subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(POWERSHELL_SCRIPT),
                    "--files-only",
                    "--json",
                    str(source),
                ],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["summary"]["total_findings"], 0)


if __name__ == "__main__":
    unittest.main()
