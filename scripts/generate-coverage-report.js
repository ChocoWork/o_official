#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const requirementPath = 'docs/02_Requirements/requirements.md';
const outputPath = 'docs/05_Quality/reports/traceability-report.md';
const designRoots = ['docs/03_BasicDesign', 'docs/04_DetailDesign'];
const testRoots = ['e2e', 'tests'];
const idPattern = /\b(?:FREQ-\d+-AC-\d+|(?:FR|NFR)-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3})\b/g;

function filesUnder(directory, extensions) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full, extensions);
    return entry.isFile() && extensions.some((extension) => full.endsWith(extension)) ? [full] : [];
  });
}

function idsIn(content) {
  return new Set(content.match(idPattern) || []);
}

function references(roots, extensions, requirements) {
  const found = new Map();
  for (const file of roots.flatMap((root) => filesUnder(root, extensions))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const id of idsIn(text)) {
      if (!requirements.has(id)) continue;
      if (!found.has(id)) found.set(id, []);
      found.get(id).push(file);
    }
  }
  return found;
}

function linkTo(file) {
  const relative = path.relative(path.dirname(outputPath), file).replaceAll('\\', '/');
  return `[${path.basename(file)}](${relative})`;
}

function example(files) {
  if (!files || files.length === 0) return 'なし';
  return `${files.length}件（${linkTo(files[0])}）`;
}

function main() {
  if (!fs.existsSync(requirementPath)) throw new Error(`Missing requirement source: ${requirementPath}`);
  const requirements = idsIn(fs.readFileSync(requirementPath, 'utf8'));
  if (requirements.size === 0) throw new Error('No requirement IDs were found; refusing an empty report');
  const design = references(designRoots, ['.md'], requirements);
  const tests = references(testRoots, ['.spec.ts', '.test.ts', '.test.tsx', '.test.js'], requirements);
  const sortedIds = [...requirements].sort();
  const withoutDesign = sortedIds.filter((id) => !design.has(id));
  const withoutTests = sortedIds.filter((id) => !tests.has(id));
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const lines = [
    '# 要件IDの参照状況',
    '',
    `> 状態: 自動生成 | 生成日: ${date} | 対象: リポジトリ内の文字列参照`,
    '',
    '## 概要',
    '',
    '要件定義書に現れる受け入れ条件ID（`FREQ-*-AC-*`）と画面・非機能要件ID（`FR-*` / `NFR-*`）が、基本・詳細設計とテストコードに文字列として現れるかを集計する。IDの出現は要件の充足、テストの実行・成功、または本番反映を証明しない。`WONT` や未実装の要件も除外せず、参照のないものを可視化する。',
    '',
    '| 指標 | 件数 |',
    '| --- | ---: |',
    `| 要件定義書の対象ID | ${sortedIds.length} |`,
    `| 設計にID参照あり | ${sortedIds.length - withoutDesign.length} |`,
    `| テストにID参照あり | ${sortedIds.length - withoutTests.length} |`,
    `| 設計にID参照なし | ${withoutDesign.length} |`,
    `| テストにID参照なし | ${withoutTests.length} |`,
    '',
    '## 参照一覧',
    '',
    '| ID | 設計内の参照 | テスト内の参照 |',
    '| --- | --- | --- |',
    ...sortedIds.map((id) => `| \`${id}\` | ${example(design.get(id))} | ${example(tests.get(id))} |`),
    '',
    '## 読み方と次の確認',
    '',
    '- 要件の本文・優先度・受け入れ条件は [要件定義書](../../02_Requirements/requirements.md) を読む。',
    '- 「参照なし」は自動判定による候補である。別名のテストや別ファイルでの設計を調べてから欠落と判断する。',
    '- 実際のカバレッジ判定には、テストのアサーション、実行ログ、環境、対象リビジョンを照合する。方法は [テスト仕様](../tests/test-spec.md) を参照する。',
    '',
  ];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
  console.log(`Traceability report written: ${outputPath} (${sortedIds.length} IDs; ${withoutDesign.length} without design reference; ${withoutTests.length} without test reference).`);
  if (process.argv.includes('--strict') && (withoutDesign.length || withoutTests.length)) process.exitCode = 2;
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}