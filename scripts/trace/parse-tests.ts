// テスト名の先頭の ID を読む（設計 5-4）。describe の名前は読まない。

import ts from 'typescript';
import { kindOf } from './model';

export type TestLevel = 'unit' | 'integration' | 'e2e';

export interface TestRef {
  /** 名前の先頭が ID の形でなければ null。 */
  id: string | null;
  level: TestLevel;
  file: string;
  line: number;
  title: string;
}

const LEAD_TOKEN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/;
const TEST_FNS = new Set(['test', 'it']);
const MODIFIERS = new Set(['only', 'skip']);

/** 置き場で段を決める。e2e/ で始まれば e2e、tests/integration/ は integration、ほかは unit。 */
export function levelOf(file: string): TestLevel {
  const path = file.replace(/\\/g, '/');
  if (/^e2e\//.test(path)) return 'e2e';
  if (/(?:^|\/)tests\/integration\//.test(path)) return 'integration';
  return 'unit';
}

function isTestFn(e: ts.Expression): boolean {
  return ts.isIdentifier(e) && TEST_FNS.has(e.text);
}

/** `test`・`it`・`test.only`・`test.skip`・`it.each(…)`・`it.each`…`` のどれかの呼び先か。 */
function isTestCallee(callee: ts.Expression): boolean {
  if (isTestFn(callee)) return true;
  if (ts.isPropertyAccessExpression(callee)) {
    return isTestFn(callee.expression) && MODIFIERS.has(callee.name.text);
  }
  const each = ts.isCallExpression(callee) ? callee.expression : ts.isTaggedTemplateExpression(callee) ? callee.tag : null;
  return !!each && ts.isPropertyAccessExpression(each) && isTestFn(each.expression) && each.name.text === 'each';
}

/** 文字列はその値、テンプレートは `${…}` を含む元の字のまま返す。 */
function titleOf(arg: ts.Expression | undefined, sf: ts.SourceFile): string | null {
  if (!arg) return null;
  if (ts.isStringLiteral(arg)) return arg.text;
  if (ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg)) return arg.getText(sf).slice(1, -1);
  return null;
}

export function parseTestRefs(file: string, text: string): TestRef[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const level = levelOf(file);
  const refs: TestRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestCallee(node.expression)) {
      const title = titleOf(node.arguments[0], sf);
      if (title !== null) {
        const token = LEAD_TOKEN.exec(title)?.[0];
        refs.push({
          id: token && kindOf(token) !== null ? token : null,
          level,
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          title,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}
