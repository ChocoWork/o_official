import sys
from pathlib import Path

try:
    import graphify  # noqa: F401
except Exception as exc:
    raise SystemExit(f'graphify import failed: {exc}')

Path('.graphify_python').write_text(sys.executable, encoding='utf-8')
print(sys.executable)
