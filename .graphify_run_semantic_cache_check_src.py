import json
from pathlib import Path
from graphify.cache import check_semantic_cache

with Path('.graphify_detect.json').open(encoding='utf-8') as f:
    detect = json.load(f)
all_files = [f for files in detect.get('files', {}).values() for f in files]
cached_nodes, cached_edges, cached_hyperedges, uncached = check_semantic_cache(all_files)
Path('.graphify_cached.json').write_text(json.dumps({'nodes': cached_nodes, 'edges': cached_edges, 'hyperedges': cached_hyperedges}, ensure_ascii=False, indent=2), encoding='utf-8')
Path('.graphify_uncached.txt').write_text('\n'.join(uncached), encoding='utf-8')
print(f'Cache: {len(all_files)-len(uncached)} files hit, {len(uncached)} files need extraction')
print('uncached count:', len(uncached))
print('sample uncached:', uncached[:10])
