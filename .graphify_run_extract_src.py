import json
from pathlib import Path

ast = json.loads(Path('.graphify_ast.json').read_text(encoding='utf-8'))
sem = json.loads(Path('.graphify_semantic.json').read_text(encoding='utf-8'))
seen = {node['id'] for node in ast['nodes']}
merged_nodes = list(ast['nodes'])
for node in sem['nodes']:
    if node['id'] not in seen:
        merged_nodes.append(node)
        seen.add(node['id'])
merged_edges = ast['edges'] + sem['edges']
merged = {
    'nodes': merged_nodes,
    'edges': merged_edges,
    'hyperedges': sem.get('hyperedges', []),
    'input_tokens': sem.get('input_tokens', 0),
    'output_tokens': sem.get('output_tokens', 0),
}
Path('.graphify_extract.json').write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Merged extraction: {len(merged_nodes)} nodes, {len(merged_edges)} edges ({len(ast['nodes'])} AST + {len(sem['nodes'])} semantic)')
