import json
from pathlib import Path

cached_path = Path('.graphify_cached.json')
cached = json.loads(cached_path.read_text(encoding='utf-8')) if cached_path.exists() else {'nodes': [], 'edges': [], 'hyperedges': []}
new_path = Path('graphify-out/.graphify_semantic_new.json')
new = json.loads(new_path.read_text(encoding='utf-8')) if new_path.exists() else {'nodes': [], 'edges': [], 'hyperedges': []}

all_nodes = cached['nodes'] + new.get('nodes', [])
all_edges = cached['edges'] + new.get('edges', [])
all_hyperedges = cached.get('hyperedges', []) + new.get('hyperedges', [])
seen = set()
deduped = []
for node in all_nodes:
    if node['id'] not in seen:
        seen.add(node['id'])
        deduped.append(node)
merged = {
    'nodes': deduped,
    'edges': all_edges,
    'hyperedges': all_hyperedges,
    'input_tokens': new.get('input_tokens', 0),
    'output_tokens': new.get('output_tokens', 0),
}
Path('.graphify_semantic.json').write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Semantic merged: {len(deduped)} nodes, {len(all_edges)} edges')
