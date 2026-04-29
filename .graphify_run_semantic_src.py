import json
from pathlib import Path
from graphify.cache import save_semantic_cache

chunk = {
    'nodes': [
        {
            'id': 'auth_design_doc',
            'label': 'Auth Detailed Design Stub',
            'file_type': 'document',
            'source_file': 'src/features/auth/design.md',
            'source_location': None,
            'source_url': None,
            'captured_at': None,
            'author': None,
            'contributor': None,
        },
        {'id': 'arch_auth_01', 'label': 'ARCH-AUTH-01: Register / Confirm', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'arch_auth_02', 'label': 'ARCH-AUTH-02: Login', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'arch_auth_03', 'label': 'ARCH-AUTH-03: Refresh / JTI', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'arch_auth_04', 'label': 'ARCH-AUTH-04: Password Reset', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'arch_auth_05', 'label': 'ARCH-AUTH-05: Logout / Revoke Sessions', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'arch_auth_06', 'label': 'ARCH-AUTH-06: OAuth', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'arch_auth_07', 'label': 'ARCH-AUTH-07: CSRF / Cookie', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'arch_auth_08', 'label': 'ARCH-AUTH-08: Audit Log', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'arch_auth_09', 'label': 'ARCH-AUTH-09: Rate Limit', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'arch_auth_10', 'label': 'ARCH-AUTH-10: Secrets Management', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'auth_openapi_snippet', 'label': 'OpenAPI snippets for auth routes', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'auth_db_migration', 'label': 'Auth DB migration draft', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'auth_zod_schema', 'label': 'TypeScript & Zod schema design', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'auth_api_route_stubs', 'label': 'Next.js API route stubs', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'auth_security_design', 'label': 'Security design (CSRF/Cookie/JTI/Rate limits)', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
        {'id': 'auth_test_plan', 'label': 'Auth test plan', 'file_type': 'document', 'source_file': 'src/features/auth/design.md', 'source_location': None, 'source_url': None, 'captured_at': None, 'author': None, 'contributor': None},
    ],
    'edges': [
        {'source': 'auth_design_doc', 'target': 'arch_auth_01', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'arch_auth_02', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'arch_auth_03', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'arch_auth_04', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'arch_auth_05', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'arch_auth_06', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'arch_auth_07', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'arch_auth_08', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'arch_auth_09', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'arch_auth_10', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'auth_openapi_snippet', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'auth_db_migration', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'auth_zod_schema', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'auth_api_route_stubs', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'auth_security_design', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
        {'source': 'auth_design_doc', 'target': 'auth_test_plan', 'relation': 'references', 'confidence': 'EXTRACTED', 'confidence_score': 1.0, 'source_file': 'src/features/auth/design.md', 'source_location': None, 'weight': 1.0},
    ],
    'hyperedges': [],
    'input_tokens': 0,
    'output_tokens': 0,
}

Path('graphify-out/.graphify_semantic_new.json').write_text(json.dumps(chunk, ensure_ascii=False, indent=2), encoding='utf-8')
count = save_semantic_cache(chunk['nodes'], chunk['edges'], chunk['hyperedges'])
print(f'Cached semantic chunk: {count}')
