// 追跡の項目の型と、ID の形から種類を決める決まり。
// 設計: docs/superpowers/specs/2026-10-24-traceability-design.md の 5-1・5-2。

export type TraceKind =
  | 'REQUEST' | 'REQ' | 'AC' | 'SEC' | 'DRV' | 'THR' | 'ADR'
  | 'ARC' | 'SCR' | 'FLOW' | 'STATE' | 'API' | 'DATA' | 'DD' | 'IMPL';

export type ItemStatus = '現行' | '推定' | '廃止';

export interface TraceItem {
  id: string;
  kind: TraceKind;
  title: string;
  file: string;
  line: number;
  parents: string[];
  outOfScopeParents: string[];
  rationale: string;
  /** 空は表が無い・読めない（検査の missing-status で落とす）。 */
  status: ItemStatus | '';
  verification?: string;
  source?: string;
  priority?: string;
  oldIds: string[];
  oldLocation?: string;
}

// 領域は英大文字の語を `-` でつなぐ（NEWS-ALL）。既にある NFR-A11Y・NFR-I18N を
// 読めるよう、2文字目以降の数字は許す（語の頭は英字なので末尾の番号とは混ざらない）。
const AREA = '[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*';
const NUM = '\\d+';

const RULES: ReadonlyArray<readonly [RegExp, TraceKind]> = [
  [new RegExp(`^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-AC-${NUM}$`), 'AC'],
  [new RegExp(`^(?:FREQ-${NUM}|SR-${AREA}-${NUM})$`), 'REQUEST'],
  [new RegExp(`^(?:FREQ-${NUM}-REQ-${NUM}|(?:FR|NFR)-${AREA}-${NUM})$`), 'REQ'],
  [new RegExp(`^SEC-(?:${AREA}-)?${NUM}$`), 'SEC'],
  ...(['DRV', 'THR', 'ARC', 'SCR', 'FLOW', 'STATE', 'API', 'DATA', 'DD', 'IMPL'] as const).map(
    (k) => [new RegExp(`^${k}-${AREA}-${NUM}$`), k] as const,
  ),
  [/^ADR-\d{4}$/, 'ADR'],
];

/** ID の形から種類を返す。上の決まりから順に当て、どれにも合わなければ null。 */
export function kindOf(id: string): TraceKind | null {
  for (const [re, kind] of RULES) {
    if (re.test(id)) return kind;
  }
  return null;
}
