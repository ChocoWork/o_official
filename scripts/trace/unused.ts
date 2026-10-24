// 使われていないコードの候補を探し、unused-code.md の表にする（設計 8）。消さない。判断はユーザーが書く。

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ancestorsOf } from './impact';
import { kindOf, type TraceKind } from './model';
import type { TraceModel } from './rules';

export interface UnusedCandidate { file: string; symbol: string; finding: '参照なし' | '要件につながらない'; how: string; impact: string; inScope: boolean }

// fs.globSync は Node 22 から在るが、手元の @types/node（20）には型が無い。
const globSync = (fs as unknown as { globSync(pattern: string, options: { cwd: string }): string[] }).globSync;

const CODE = '{ts,tsx,js,jsx,mjs,cjs}';
const IMPORTERS = [`src/**/*.${CODE}`, `tests/**/*.${CODE}`, `e2e/**/*.${CODE}`, `scripts/**/*.${CODE}`, `*.${CODE}`];
const CANDIDATE = /^src\/.*\.tsx?$/;
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];
// Next.js が名前で読むファイル。import されなくても使われ、export も Next.js が読む。
const NEXT_FILE = /^src\/app\/(?:.*\/)?(?:page|layout|route|loading|error|not-found)\.tsx?$|^src\/proxy\.ts$/;
// 要件として数える種類（範囲外の上位もこの種類なら要件につながるとみなす）。
const REQUIREMENT: readonly TraceKind[] = ['REQUEST', 'REQ', 'SEC', 'DRV'];
const isRequirement = (k: TraceKind | null) => k !== null && REQUIREMENT.includes(k);
const NOT_REFERENCES = ['docs/superpowers/', 'docs/05_Quality/reports/'];

/** そのファイルの中の何を使うか。'*' は全部（名前空間・動的 import・require）。 */
type Use = Set<string> | '*';
interface Ref { spec: string; use: Use }

function collect(root: string, patterns: string[]): string[] {
  const files = new Set<string>();
  for (const p of patterns) {
    for (const f of globSync(p, { cwd: root })) {
      const rel = f.replace(/\\/g, '/');
      if (!rel.split('/').some((s) => s === 'graphify-out' || s === 'node_modules') && !rel.endsWith('.d.ts')) files.add(rel);
    }
  }
  return [...files].sort();
}

const literal = (e: ts.Node | undefined) => (e && ts.isStringLiteralLike(e) ? e.text : null);

/** import・export from・import()・require・jest.mock などで指す先と、使う名前を読む。 */
function refsOf(file: string, text: string): Ref[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const refs: Ref[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = literal(node.moduleSpecifier);
      const c = node.importClause;
      const names = new Set<string>();
      let all = false;
      if (c?.name) names.add('default');
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) all = true;
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) {
        for (const el of c.namedBindings.elements) names.add((el.propertyName ?? el.name).text);
      }
      if (spec) refs.push({ spec, use: all ? '*' : names });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = literal(node.moduleSpecifier);
      const ec = node.exportClause;
      const use: Use = ec && ts.isNamedExports(ec) ? new Set(ec.elements.map((el) => (el.propertyName ?? el.name).text)) : '*';
      if (spec) refs.push({ spec, use });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literal(node.moduleReference.expression);
      if (spec) refs.push({ spec, use: '*' });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const spec = literal(node.argument.literal);
      if (spec) refs.push({ spec, use: '*' });
    } else if (ts.isCallExpression(node)) {
      const spec = literal(node.arguments[0]);
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const jestFn = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'jest' ? callee.name.text : null;
      if (spec && (isImport || isRequire || jestFn === 'requireActual')) refs.push({ spec, use: '*' });
      // 差し替えるだけの jest.mock はファイルを指すが、export は使わない。
      else if (spec && (jestFn === 'mock' || jestFn === 'doMock')) refs.push({ spec, use: new Set() });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

/** 一番上の export の名前（default を含む）。 */
function exportsOf(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  for (const s of sf.statements) {
    const mods = ts.canHaveModifiers(s) ? ts.getModifiers(s) ?? [] : [];
    const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isVariableStatement(s) && exported) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    } else if (
      exported &&
      (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s))
    ) {
      names.push(isDefault ? 'default' : s.name?.text ?? 'default');
    } else if (ts.isExportAssignment(s) && !s.isExportEquals) {
      names.push('default');
    } else if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) {
      for (const el of s.exportClause.elements) names.push(el.name.text);
    }
  }
  return names;
}

function resolve(spec: string, from: string, files: Set<string>): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('./') || spec.startsWith('../')) base = path.posix.join(path.posix.dirname(from), spec);
  else return null;
  base = path.posix.normalize(base);
  for (const ext of EXTENSIONS) if (files.has(base + ext)) return base + ext;
  return null;
}

const countBy = (files: string[]) => {
  const top = new Map<string, number>();
  for (const f of files) top.set(f.split('/')[0], (top.get(f.split('/')[0]) ?? 0) + 1);
  return [...top].map(([k, n]) => `${k} ${n}`).join('・');
};
const listSome = (files: string[]) => (files.length <= 3 ? files.join('、') : `${files.slice(0, 3).join('、')} ほか ${files.length - 3} 件`);

/**
 * 参照なし: src/ のファイルで、src/・tests/・e2e/・scripts/・直下の設定のどこからも指されない物（Next.js の決まった名前を除く）と、
 * 範囲内のファイルの export で、どこからも import されない物。要件につながらない: 範囲内の単位で、@design の先から上へたどっても要件に届かない物。
 * 範囲内かどうかは model の単位のファイルで決める（単位の無いファイルは範囲外とみなす）。
 */
export function findUnused(root: string, model: TraceModel): UnusedCandidate[] {
  const importers = collect(root, IMPORTERS);
  const fileSet = new Set(importers);
  const texts = new Map(importers.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
  // 作業の記録と生成物は候補を書き写すだけなので、消した時の影響に数えない。
  const docs = collect(root, ['docs/**/*.md']).filter((f) => !NOT_REFERENCES.some((d) => f.startsWith(d)));
  const docTexts = new Map(docs.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
  const inScope = new Set(model.units.map((u) => u.file.replace(/\\/g, '/')));

  /** 指される先 → 指す元のファイルと使う名前。 */
  const usedBy = new Map<string, { from: string; use: Use }[]>();
  for (const [from, text] of texts) {
    for (const r of refsOf(from, text)) {
      const to = resolve(r.spec, from, fileSet);
      if (!to || to === from) continue;
      usedBy.set(to, [...(usedBy.get(to) ?? []), { from, use: r.use }]);
    }
  }
  const textHits = (word: string | RegExp, self: string) =>
    importers.filter((f) => f !== self && (typeof word === 'string' ? texts.get(f)!.includes(word) : word.test(texts.get(f)!)));
  const docHits = (word: string) => docs.filter((f) => docTexts.get(f)!.includes(word));
  const docNote = (word: string) => {
    const hits = docHits(word);
    return hits.length === 0 ? '文書の参照: なし' : `文書の参照: ${hits.length} 件（${listSome(hits)}）`;
  };
  const scanned = `src/・tests/・e2e/・scripts/・直下の設定 ${importers.length} ファイルの import・export from・import()・require・jest.mock を解決`;

  const out: UnusedCandidate[] = [];
  for (const file of importers.filter((f) => CANDIDATE.test(f) && !NEXT_FILE.test(f))) {
    const refs = usedBy.get(file) ?? [];
    const scope = inScope.has(file);
    if (refs.length === 0) {
      const stem = path.posix.basename(file).replace(/\.[^.]+$/, '');
      const word = stem === 'index' ? path.posix.basename(path.posix.dirname(file)) : stem;
      const modulePath = file.replace(/^src\//, '').replace(/(?:\/index)?\.tsx?$/, '');
      // 解決できない書き方の import（別名・拡張子つきなど）を拾うため、場所か「./名前」で終わる文字列も探す。
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hits = textHits(new RegExp(`(?:${esc(modulePath)}|\\./${esc(word)})(?:/index)?(?:\\.[cm]?[jt]sx?)?['"\`]`), file);
      out.push({
        file, symbol: '<file>', finding: '参照なし',
        how: `${scanned}（指す所 0 件）。文字の検索（「${modulePath}」か「./${word}」で終わる文字列）: ほかのファイルに ${hits.length} 件${hits.length > 0 ? `（${listSome(hits)}）` : ''}`,
        impact: `import する試験: なし。${docNote(modulePath)}`,
        inScope: scope,
      });
      continue;
    }
    if (!scope) continue;
    for (const name of exportsOf(file, texts.get(file)!)) {
      if (refs.some((r) => r.use === '*' || r.use.has(name))) continue;
      const hits = textHits(name, file);
      out.push({
        file, symbol: name, finding: '参照なし',
        how: `${scanned}（このファイルを指す ${refs.length} 件のどれも ${name} を import しない）。文字の検索「${name}」: ほかのファイルに ${hits.length} 件`,
        impact: `ファイルの外から使われない（ファイルの中では残る）。${docNote(name)}`,
        inScope: true,
      });
    }
  }

  const byId = new Set(model.items.map((i) => i.id));
  for (const u of model.units) {
    const chain = ancestorsOf(model, u.designIds);
    const reaches = chain.some((i) => isRequirement(i.kind) || i.outOfScopeParents.some((p) => isRequirement(kindOf(p))));
    if (reaches) continue;
    const file = u.file.replace(/\\/g, '/');
    const refs = [...new Set((usedBy.get(file) ?? []).map((r) => r.from))];
    const missing = u.designIds.filter((d) => !byId.has(d));
    out.push({
      file, symbol: u.symbol, finding: '要件につながらない',
      how: `@design（${u.designIds.join('、') || 'なし'}）から上位をたどって REQ・SEC・DRV・要求に届かない${missing.length > 0 ? `（${missing.join('、')} は範囲内に無い）` : ''}`,
      impact: refs.length === 0 ? 'このファイルを指す所: なし' : `このファイルを指す所: ${refs.length} 件（${countBy(refs)}）`,
      inScope: true,
    });
  }
  return out.sort((a, b) => Number(b.inScope) - Number(a.inScope) || a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol));
}

const HEADER = ['場所', '記号', '見つけ方', '確かめた方法', '消した時の影響', '範囲', '判断'];

const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const code = (s: string) => `\`${s}\``;

/** 表の1行を、`\|` を割らずに切り、囲みの ` を外して返す。 */
function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|').replace(/^`(.*)`$/, '$1'));
}

/** 前の版の表から「場所|記号|見つけ方」→ 判断 を読む。 */
function judgments(previous: string): Map<string, string> {
  const map = new Map<string, string>();
  let col: Record<string, number> | null = null;
  for (const line of previous.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) {
      col = null;
      continue;
    }
    const cells = cellsOf(line);
    if (cells.includes('判断') && cells.includes('場所')) {
      col = Object.fromEntries(cells.map((c, i) => [c, i]));
      continue;
    }
    if (!col || cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const j = cells[col['判断']] ?? '';
    if (j !== '') map.set([cells[col['場所']], cells[col['記号']], cells[col['見つけ方']]].join('|'), j);
  }
  return map;
}

/** 候補の表。前の版（previous）の判断の列を、場所・記号・見つけ方の同じ行に引き継ぐ。 */
export function renderUnused(list: UnusedCandidate[], previous?: string): string {
  const kept = previous ? judgments(previous) : new Map<string, string>();
  const rows = list.map((c) => {
    const judgment = kept.get([c.file, c.symbol, c.finding].join('|')) ?? '';
    return `| ${[code(c.file), code(c.symbol), c.finding, cell(c.how), cell(c.impact), c.inScope ? '範囲内' : '範囲外', cell(judgment)].join(' | ')} |`;
  });
  return [`| ${HEADER.join(' | ')} |`, `| ${HEADER.map(() => '---').join(' | ')} |`, ...rows].join('\n') + '\n';
}
