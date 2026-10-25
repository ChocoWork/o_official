// コードの単位（設計 5-3）と、その TSDoc の @impl・@design・@remarks を読む。

import ts from 'typescript';
import { kindOf } from './model';

export interface CodeUnit {
  file: string;
  line: number;
  /** ファイル単位は '<file>'。 */
  symbol: string;
  unitKind: 'file' | 'function';
  implId?: string;
  /** 2つ目以降の @impl（1つの単位に @impl は1つ。検査の multiple-impl で落とす）。 */
  extraImplIds?: string[];
  designIds: string[];
  remarks: string;
}

const APP_FILE = /(?:^|\/)src\/app\/(?:.*\/)?(?:page|layout|route|loading|error|not-found)\.tsx?$/;
const ID_TOKEN = /[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/g;

interface DocTags {
  implId?: string;
  extraImplIds?: string[];
  designIds: string[];
  remarks: string;
}

/** `/** … *\/` の中身を行ごとにし、タグごとの本文を読む。 */
function readDoc(comment: string): DocTags {
  const lines = comment
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*?\s?/, '').trim());
  // 同じタグが2回あれば本文をつなぐ。タグの次の行からは、次のタグまでを同じ本文とみなす。
  const bodies = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    const m = /^@(\w+)\s*(.*)$/.exec(line);
    if (m) {
      current = bodies.get(m[1]) ?? [];
      bodies.set(m[1], current);
      current.push(m[2]);
    } else if (current) {
      current.push(line);
    }
  }
  const body = (tag: string) => (bodies.get(tag) ?? []).filter((s) => s !== '').join(' ');
  const ids = (tag: string) => [...body(tag).matchAll(ID_TOKEN)].map((m) => m[0]).filter((id) => kindOf(id) !== null);
  const impls = ids('impl');
  return {
    implId: impls[0],
    ...(impls.length > 1 ? { extraImplIds: impls.slice(1) } : {}),
    designIds: ids('design'),
    remarks: body('remarks'),
  };
}

function isDoc(text: string, range: ts.CommentRange): boolean {
  return range.kind === ts.SyntaxKind.MultiLineCommentTrivia && text.startsWith('/**', range.pos);
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function hasExport(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

function isFunctionValue(e: ts.Expression | undefined): boolean {
  if (!e) return false;
  const v = unwrap(e);
  return ts.isArrowFunction(v) || ts.isFunctionExpression(v);
}

function startsWithUseServer(sf: ts.SourceFile): boolean {
  for (const s of sf.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) return false;
    if (s.expression.text === 'use server') return true;
  }
  return false;
}

function fileUnit(file: string, text: string): CodeUnit {
  const ranges = ts.getLeadingCommentRanges(text, 0) ?? [];
  const head = ranges.find((r) => isDoc(text, r) && text.slice(r.pos, r.end).includes('@packageDocumentation'));
  const tags = head ? readDoc(text.slice(head.pos, head.end)) : { designIds: [], remarks: '' };
  const line = head ? text.slice(0, head.pos).split('\n').length : 1;
  return { file, line, symbol: '<file>', unitKind: 'file', ...tags };
}

/** 文の直前の TSDoc（@packageDocumentation のものは除く）の最後の1つを読む。 */
function docBefore(text: string, node: ts.Node): DocTags {
  const ranges = (ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []).filter(
    (r) => isDoc(text, r) && !text.slice(r.pos, r.end).includes('@packageDocumentation'),
  );
  const last = ranges[ranges.length - 1];
  return last ? readDoc(text.slice(last.pos, last.end)) : { designIds: [], remarks: '' };
}

/**
 * 1つのファイルの単位を返す。`.ts`・`.tsx` 以外と `.d.ts` は空。
 * `file` はリポジトリからの相対パス（区切りは `/` でも `\` でもよい）。
 */
export function parseCodeUnits(file: string, text: string): CodeUnit[] {
  const path = file.replace(/\\/g, '/');
  if (!/\.tsx?$/.test(path) || path.endsWith('.d.ts')) return [];
  if (path.endsWith('.tsx') || APP_FILE.test(path)) return [fileUnit(file, text)];

  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const withClasses = !startsWithUseServer(sf);
  const units: CodeUnit[] = [];
  const add = (node: ts.Node, symbol: string, doc: DocTags) =>
    units.push({ file, line: lineOf(sf, node.getStart(sf)), symbol, unitKind: 'function', ...doc });

  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && hasExport(s) && s.body) {
      add(s, s.name?.text ?? 'default', docBefore(text, s));
    } else if (withClasses && ts.isClassDeclaration(s) && hasExport(s)) {
      add(s, s.name?.text ?? 'default', docBefore(text, s));
    } else if (ts.isVariableStatement(s) && hasExport(s)) {
      const doc = docBefore(text, s);
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && isFunctionValue(d.initializer)) add(s, d.name.text, doc);
      }
    } else if (ts.isExportAssignment(s) && !s.isExportEquals && isFunctionValue(s.expression)) {
      add(s, 'default', docBefore(text, s));
    }
  }
  return units;
}
