#!/usr/bin/env python3
"""Compatibility entry point for the canonical Codex security audit."""

from pathlib import Path
import runpy


CANONICAL_SCRIPT = Path(__file__).resolve().parents[4] / ".codex" / "skills" / "security-check" / "scripts" / "audit.py"
runpy.run_path(str(CANONICAL_SCRIPT), run_name="__main__")
