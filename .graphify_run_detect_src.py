import json
from pathlib import Path
from graphify.detect import detect

result = detect(Path('src'))
Path('.graphify_detect.json').write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
