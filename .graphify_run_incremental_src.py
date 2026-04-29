import json
from pathlib import Path
from graphify.detect import detect_incremental

result = detect_incremental(Path('src'))
Path('.graphify_incremental.json').write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
