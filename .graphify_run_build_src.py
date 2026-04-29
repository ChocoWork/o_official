import json
from pathlib import Path
import graphify.build as build
import graphify.cluster as cluster
import graphify.export as export
import graphify.report as report
import graphify.wiki as wiki
import graphify.analyze as analyze
import graphify.benchmark as benchmark

root = Path('.')
extract_path = root / '.graphify_extract.json'
if not extract_path.exists():
    raise FileNotFoundError(f'Missing {extract_path}')
extract = json.loads(extract_path.read_text(encoding='utf-8'))

G = build.build(extractions=[extract], directed=False)
output_dir = root / 'graphify-out'
output_dir.mkdir(exist_ok=True)

# Save graph JSON
graph_json_path = output_dir / 'graph.json'
communities = cluster.cluster(G)
export.to_json(G, communities, str(graph_json_path))
print(f'Wrote graph: {graph_json_path}')

community_labels = {cid: f'Community {cid}' for cid in communities}
cohesion_scores = {cid: len(nodes) / max(1, G.number_of_nodes()) for cid, nodes in communities.items()}

# Report metadata
detect_path = root / '.graphify_detect.json'
detection_result = json.loads(detect_path.read_text(encoding='utf-8')) if detect_path.exists() else {}
token_cost = {
    'input_tokens': extract.get('input_tokens', 0),
    'output_tokens': extract.get('output_tokens', 0),
}

god_nodes = analyze.god_nodes(G)
surprises = analyze.surprising_connections(G, communities)
questions = analyze.suggest_questions(G, communities, community_labels)
report_md = report.generate(
    G,
    communities,
    cohesion_scores,
    community_labels,
    god_nodes,
    surprises,
    detection_result,
    token_cost,
    str(output_dir),
    suggested_questions=questions,
)
report_path = output_dir / 'GRAPH_REPORT.md'
report_path.write_text(report_md, encoding='utf-8')
print(f'Wrote report: {report_path}')

# HTML export
html_path = output_dir / 'graph.html'
export.to_html(G, communities, str(html_path), community_labels=community_labels)
print(f'Wrote HTML: {html_path}')

# Wiki export
wiki_dir = output_dir / 'wiki'
wiki_dir.mkdir(exist_ok=True)
wiki_count = wiki.to_wiki(G, communities, wiki_dir, community_labels=community_labels, cohesion=cohesion_scores, god_nodes_data=god_nodes)
print(f'Wrote wiki files ({wiki_count} pages) to: {wiki_dir}')

# Benchmark
benchmark_path = output_dir / 'benchmark.json'
benchmark_result = benchmark.run_benchmark(str(graph_json_path), corpus_words=detection_result.get('total_words'))
benchmark_path.write_text(json.dumps(benchmark_result, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Wrote benchmark: {benchmark_path}')

# Also save cost manifest
cost_path = output_dir / 'cost.json'
cost_data = {
    'detection': detection_result.get('cost', {}),
    'semantic': token_cost,
    'graph': {'nodes': G.number_of_nodes(), 'edges': G.number_of_edges()},
}
cost_path.write_text(json.dumps(cost_data, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Wrote cost manifest: {cost_path}')
