/** @jest-environment node */
import { parseBadHeadings, parseDocItems } from '@/../scripts/trace/parse-docs';

describe('parseDocItems', () => {
  it('見出しと属性の表から項目を読む（BOM・CRLF でも）', () => {
    const md = '﻿# 文書\r\n\r\n### DD-NEWS-003 一覧の取得\r\n\r\n| 属性 | 値 |\r\n| --- | --- |\r\n| 上位 | API-NEWS-002、SEC-001（範囲外） |\r\n| 根拠 | 下書きを外へ出さない |\r\n| 状態 | 推定 |\r\n| 旧番号 | IMPL-NEWS-LIST-001 |\r\n';
    const [item] = parseDocItems('x.md', md);
    expect(item).toMatchObject({
      id: 'DD-NEWS-003', kind: 'DD', title: '一覧の取得', line: 3,
      parents: ['API-NEWS-002'], outOfScopeParents: ['SEC-001'],
      rationale: '下書きを外へ出さない', status: '推定', oldIds: ['IMPL-NEWS-LIST-001'],
    });
  });

  it('本文や表の中の ID は定義にしない', () => {
    const md = '## 概要\n\nDD-NEWS-003 を参照する。\n\n| ID | 説明 |\n| --- | --- |\n| DD-NEWS-004 | x |\n';
    expect(parseDocItems('x.md', md)).toEqual([]);
  });

  it('見出しの次の属性の表が無い項目は状態を空にして返す（検査で落とす）', () => {
    const [item] = parseDocItems('x.md', '### DD-NEWS-009 表なし\n\n本文だけ\n');
    expect(item.rationale).toBe('');
    expect(item.parents).toEqual([]);
    expect(item.status).toBe('');
  });

  it('#### の見出しと残りの属性を読み、読めない状態は空にする', () => {
    const md = [
      '#### FR-NEWS-ALL-001 一覧を出す',
      '',
      '| 属性 | 値 |',
      '| --- | --- |',
      '| 上位 | SR-NEWS-001 |',
      '| 根拠 | 新しい順に読みたい |',
      '| 状態 | 確認中 |',
      '| 確かめ方 | E2E |',
      '| 出どころ | `docs/x.md` |',
      '| 優先度 | MUST |',
      '| 旧所在 | requirements.md |',
      '',
    ].join('\n');
    const [item] = parseDocItems('docs/a.md', md);
    expect(item).toEqual({
      id: 'FR-NEWS-ALL-001', kind: 'REQ', title: '一覧を出す', file: 'docs/a.md', line: 1,
      parents: ['SR-NEWS-001'], outOfScopeParents: [],
      rationale: '新しい順に読みたい', status: '',
      verification: 'E2E', source: '`docs/x.md`', priority: 'MUST',
      oldIds: [], oldLocation: 'requirements.md',
    });
  });

  it('本文の後ろの表や次の項目の表は属性にしない', () => {
    const md = [
      '### DD-NEWS-010 本文が先',
      '',
      '本文',
      '',
      '| 属性 | 値 |',
      '| --- | --- |',
      '| 根拠 | 読まれない |',
      '',
      '### DD-NEWS-011 次',
      '',
      '| 属性 | 値 |',
      '| --- | --- |',
      '| 根拠 | 次の根拠 |',
      '| 状態 | 現行 |',
    ].join('\n');
    const items = parseDocItems('x.md', md);
    expect(items.map((i) => [i.id, i.line, i.rationale, i.status])).toEqual([
      ['DD-NEWS-010', 1, '', ''],
      ['DD-NEWS-011', 9, '次の根拠', '現行'],
    ]);
  });

  it('コードの囲みの中の見出しは定義にしない', () => {
    const md = '```markdown\n### DD-NEWS-003 例\n\n| 属性 | 値 |\n| --- | --- |\n| 状態 | 現行 |\n```\n';
    expect(parseDocItems('x.md', md)).toEqual([]);
  });

  it('ID でない語で始まる見出しは項目にしない', () => {
    expect(parseDocItems('x.md', '### 5-2 項目の書き方\n\n| 属性 | 値 |\n| --- | --- |\n| 状態 | 現行 |\n')).toEqual([]);
  });
});

describe('parseBadHeadings', () => {
  const TABLE = '\n\n| 属性 | 値 |\n| --- | --- |\n| 状態 | 現行 |\n';
  it('ID に似ているが形の合わない見出しで、表が続くものを返す', () => {
    const md = [
      `### FR-NEWS-ALL-001-AC-1a 題${TABLE}`,
      `#### DD-NEWS-003: 題${TABLE}`,
      `### \`DD-NEWS-004\` 題${TABLE}`,
      `### DD-NEWS-005 正しい${TABLE}`,
      '### DD-NEWS-00x 表なし\n\n本文\n',
      `### 5-2 項目の書き方${TABLE}`,
      `## DD-NEWS-00y 段が違う${TABLE}`,
      `\`\`\`markdown\n### DD-NEWS-00z 囲み${TABLE}\`\`\`\n`,
    ].join('\n');
    expect(parseBadHeadings('x.md', md)).toEqual([
      { heading: 'FR-NEWS-ALL-001-AC-1a', file: 'x.md', line: 1 },
      { heading: 'DD-NEWS-003:', file: 'x.md', line: 7 },
      { heading: '`DD-NEWS-004`', file: 'x.md', line: 13 },
    ]);
  });
});
