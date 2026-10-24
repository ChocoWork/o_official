// 項目・コードの単位・テストのつながりを検査する決まり。
// 設計: docs/superpowers/specs/2026-10-24-traceability-design.md の 5・7。

import { kindOf, type TraceItem, type TraceKind } from './model';
import type { CodeUnit } from './parse-code';
import type { BadHeading } from './parse-docs';
import type { TestLevel, TestRef } from './parse-tests';

export interface Violation { rule: string; message: string; file: string; line: number }
export interface TraceModel {
  items: TraceItem[]; units: CodeUnit[]; tests: TestRef[];
  /** 範囲外の文書（docs/ 全体）に文字として現れる ID。 */
  knownIdsOutsideScope: Set<string>;
  /** ID に似ているのに形の合わない見出し（項目にならないので、ここから bad-id で落とす）。 */
  badHeadings?: BadHeading[];
}

const STRUCT: readonly TraceKind[] = ['ARC', 'SCR', 'FLOW', 'STATE', 'API', 'DATA'];
const isStruct = (k: TraceKind | null) => k !== null && STRUCT.includes(k);

/** 種類ごとの上位に書ける種類。空は上位を書かない種類。 */
const PARENT_KINDS: Record<TraceKind, readonly TraceKind[]> = {
  REQUEST: [], THR: [], DRV: [],
  REQ: ['REQUEST'],
  AC: ['REQ', 'SEC'],
  SEC: ['THR'],
  ADR: ['REQ', 'SEC', 'DRV'],
  ARC: ['REQ', 'SEC', 'DRV', 'ADR'], SCR: ['REQ', 'SEC', 'DRV', 'ADR'], FLOW: ['REQ', 'SEC', 'DRV', 'ADR'],
  STATE: ['REQ', 'SEC', 'DRV', 'ADR'], API: ['REQ', 'SEC', 'DRV', 'ADR'], DATA: ['REQ', 'SEC', 'DRV', 'ADR'],
  DD: [...STRUCT, 'SEC'],
  IMPL: ['DD'],
};
const NO_PARENT: readonly TraceKind[] = ['REQUEST', 'DRV', 'THR'];
/** 構造設計の上位に1つは要る種類（ADR だけでは足りない）。 */
const STRUCT_ANCHOR: readonly TraceKind[] = ['REQ', 'SEC', 'DRV'];

/** テストの段ごとに指してよい種類。 */
const TEST_KINDS: Record<TestLevel, (k: TraceKind | null) => boolean> = {
  e2e: (k) => k === 'AC',
  integration: isStruct,
  unit: (k) => k === 'DD',
};

const BOILERPLATE = ['仕様のため', '要件のため', '仕様どおり', '必要なため'];

/** 句読点と空白で切り、どの切れも決まり文句なら（切れが無ければ）根拠が無いとみなす。 */
function isEmptyRationale(rationale: string): boolean {
  return rationale.split(/[\s。．.、，,]+/).filter((s) => s !== '').every((s) => BOILERPLATE.includes(s));
}

const at = (rule: string, message: string, where: { file: string; line: number }): Violation => ({
  rule, message, file: where.file, line: where.line,
});

export function checkModel(model: TraceModel): Violation[] {
  const out: Violation[] = [];
  const byId = new Map<string, TraceItem>();
  for (const it of model.items) {
    const first = byId.get(it.id);
    if (first) out.push(at('duplicate-id', `${it.id} は ${first.file}:${first.line} でも定義されている`, it));
    else byId.set(it.id, it);
  }
  const live = (it: TraceItem) => it.status !== '廃止';
  const childrenOf = (id: string) => model.items.filter((c) => live(c) && c.parents.includes(id));
  const testsOf = (id: string, level: TestLevel) => model.tests.filter((t) => t.id === id && t.level === level);

  for (const h of model.badHeadings ?? []) out.push(at('bad-id', `見出しの ${h.heading} は ID の形に合わない`, h));
  for (const it of model.items) {
    if (kindOf(it.id) === null) out.push(at('bad-id', `${it.id} は ID の形に合わない`, it));
    if (it.status === '') out.push(at('missing-status', `${it.id} の状態が空`, it));
    if (isEmptyRationale(it.rationale)) out.push(at('missing-rationale', `${it.id} の根拠が空か決まり文句だけ`, it));

    const allParents = [...it.parents, ...it.outOfScopeParents];
    if (allParents.length === 0 && !NO_PARENT.includes(it.kind)) {
      out.push(at('missing-parent', `${it.id} の上位が空`, it));
    }
    const allowed = PARENT_KINDS[it.kind];
    for (const p of allParents) {
      const k = kindOf(p);
      if (k === null || !allowed.includes(k)) out.push(at('wrong-parent-kind', `${it.id}（${it.kind}）の上位に ${p} は書けない`, it));
    }
    if (isStruct(it.kind) && allParents.length > 0 && !allParents.some((p) => {
      const k = kindOf(p);
      return k !== null && STRUCT_ANCHOR.includes(k);
    })) {
      out.push(at('wrong-parent-kind', `${it.id} の上位に REQ・SEC・DRV のどれかが要る`, it));
    }
    for (const p of it.parents) {
      if (!byId.has(p)) out.push(at('unknown-parent', `${it.id} の上位 ${p} が範囲内に無い`, it));
    }
    for (const p of it.outOfScopeParents) {
      // 読み込む領域が増えると範囲外の文書が範囲内に入るので、範囲内の定義も見る。
      if (!byId.has(p) && !model.knownIdsOutsideScope.has(p)) {
        out.push(at('unknown-parent', `${it.id} の上位 ${p}（範囲外）が範囲内にもほかの文書にも無い`, it));
      }
    }

    if (live(it)) {
      for (const need of missingChildren(it)) out.push(at('missing-child', `${it.id} に ${need} が無い`, it));
      for (const p of it.parents) {
        const parent = byId.get(p);
        if (parent && !live(parent)) out.push(at('retired-reference', `${it.id} が廃止の ${p} を指す`, it));
      }
    }
  }

  function missingChildren(it: TraceItem): string[] {
    const kids = childrenOf(it.id).map((c) => c.kind);
    const has = (pred: (k: TraceKind) => boolean) => kids.some(pred);
    const missing: string[] = [];
    const need = (ok: boolean, what: string) => { if (!ok) missing.push(what); };
    switch (it.kind) {
      case 'REQUEST': need(has((k) => k === 'REQ'), 'REQ'); break;
      case 'REQ': need(has((k) => k === 'AC'), 'AC'); break;
      case 'AC': need(testsOf(it.id, 'e2e').length > 0, 'e2e テスト'); break;
      case 'THR': need(has((k) => k === 'SEC'), 'SEC'); break;
      case 'SEC': need(has((k) => k === 'AC' || k === 'DD' || isStruct(k)), 'AC・構造設計・DD のどれか'); break;
      case 'DRV': need(has(isStruct), '構造設計'); break;
      case 'ADR': need(has(isStruct), '構造設計'); break;
      case 'DD':
        need(testsOf(it.id, 'unit').length > 0, '単体テスト');
        need(model.units.some((u) => u.designIds.includes(it.id)), 'コードの単位');
        break;
      default:
        if (isStruct(it.kind)) {
          need(testsOf(it.id, 'integration').length > 0, '結合テスト');
          need(has((k) => k === 'DD'), 'DD');
        }
    }
    return missing;
  }

  const retired = (id: string) => byId.get(id)?.status === '廃止';
  const implSeen = new Map<string, CodeUnit>();
  for (const u of model.units) {
    const name = `${u.file} の ${u.symbol}`;
    if (!u.implId || kindOf(u.implId) !== 'IMPL') {
      out.push(at('missing-impl', `${name} に @impl（IMPL-）が無い`, u));
    } else {
      const first = implSeen.get(u.implId);
      if (first) out.push(at('duplicate-impl', `${u.implId} は ${first.file}:${first.line} にもある`, u));
      else implSeen.set(u.implId, u);
    }
    const [design, ...rest] = u.designIds;
    if (design === undefined || rest.length > 0) {
      out.push(at('bad-design-link', `${name} の @design が1つでない（${u.designIds.length} 個）`, u));
    } else if (kindOf(design) !== 'DD') {
      out.push(at('bad-design-link', `${name} の @design ${design} が DD でない`, u));
    } else if (!byId.has(design)) {
      out.push(at('bad-design-link', `${name} の @design ${design} が範囲内に無い`, u));
    }
    for (const id of [u.implId, ...u.designIds]) {
      if (id && retired(id)) out.push(at('retired-reference', `${name} が廃止の ${id} を指す`, u));
    }
  }

  for (const t of model.tests) {
    if (t.id === null) {
      out.push(at('untagged-test', `テスト「${t.title}」の名前に ID が無い`, t));
      continue;
    }
    if (!TEST_KINDS[t.level](kindOf(t.id))) out.push(at('wrong-test-level', `${t.level} のテストが ${t.id} を指す`, t));
    if (!byId.has(t.id)) out.push(at('unknown-test-id', `テストの ${t.id} が範囲内に無い`, t));
    else if (retired(t.id)) out.push(at('retired-reference', `テスト「${t.title}」が廃止の ${t.id} を指す`, t));
  }
  return out;
}
