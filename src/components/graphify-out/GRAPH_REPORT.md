# Graph Report - src\components  (2026-04-29)

## Corpus Check
- 58 files · ~19,168 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 127 nodes · 79 edges · 5 communities detected
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 7|Community 7]]

## God Nodes (most connected - your core abstractions)
1. `focusOtpInput()` - 4 edges
2. `fetchLooks()` - 3 edges
3. `fetchNews()` - 3 edges
4. `fetchStockists()` - 3 edges
5. `handleOtpChange()` - 2 edges
6. `handleOtpKeyDown()` - 2 edges
7. `handleOtpPaste()` - 2 edges
8. `handleToggleStatus()` - 2 edges
9. `handleDelete()` - 2 edges
10. `handleToggleStatus()` - 2 edges

## Surprising Connections (you probably didn't know these)
- `Button()` --calls--> `cn()`  [INFERRED]
  ui\Button.tsx → ui\Toolbar.tsx

## Communities

### Community 0 - "Community 0"
Cohesion: 0.36
Nodes (4): focusOtpInput(), handleOtpChange(), handleOtpKeyDown(), handleOtpPaste()

### Community 2 - "Community 2"
Cohesion: 0.83
Nodes (3): fetchLooks(), handleDelete(), handleToggleStatus()

### Community 3 - "Community 3"
Cohesion: 0.83
Nodes (3): fetchNews(), handleDelete(), handleToggleStatus()

### Community 4 - "Community 4"
Cohesion: 0.83
Nodes (3): fetchStockists(), handleDelete(), handleToggleStatus()

### Community 7 - "Community 7"
Cohesion: 0.5
Nodes (2): Button(), cn()

## Knowledge Gaps
- **Thin community `Community 7`** (4 nodes): `Button()`, `Button.tsx`, `cn()`, `Toolbar.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Not enough signal to generate questions. This usually means the corpus has no AMBIGUOUS edges, no bridge nodes, no INFERRED relationships, and all communities are tightly cohesive. Add more files or run with --mode deep to extract richer edges._