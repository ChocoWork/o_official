import json
from pathlib import Path
from graphify.extract import extract

with Path('.graphify_detect.json').open(encoding='utf-8') as f:
    detect = json.load(f)
code_files = detect.get('files', {}).get('code', [])
if code_files:
    result = extract([Path(p) for p in code_files])
else:
    result = {'nodes': [], 'edges': [], 'input_tokens': 0, 'output_tokens': 0}
Path('.graphify_ast.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(f"AST: {len(result['nodes'])} nodes, {len(result['edges'])} edges")
