// 文書（Markdown）から追跡の項目を読む。
// 項目は「### / #### <ID> <題>」の見出しと、その直後の属性の表だけで書く（設計 5-2）。

import { kindOf, type ItemStatus, type TraceItem } from './model';

const HEADING = /^#{3,4}[ \t]+(\S+)[ \t]*(.*)$/;
const ANY_HEADING = /^#{1,6}[ \t]/;
const FENCE = /^[ \t]*(```|~~~)/;
const ID_TOKEN = /[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/g;
const OUT_OF_SCOPE = '（範囲外）';
const STATUSES: readonly ItemStatus[] = ['現行', '推定', '廃止'];

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function extractIds(value: string): { ids: string[]; outOfScope: string[] } {
  const ids: string[] = [];
  const outOfScope: string[] = [];
  for (const m of value.matchAll(ID_TOKEN)) {
    if (kindOf(m[0]) === null) continue;
    const rest = value.slice(m.index + m[0].length).trimStart();
    (rest.startsWith(OUT_OF_SCOPE) ? outOfScope : ids).push(m[0]);
  }
  return { ids, outOfScope };
}

/** 見出しの直後（空行だけを挟む）の最初の表を「属性名 → 値」で返す。表が無ければ空。 */
function readAttributes(lines: string[], start: number): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = start;
  while (i < lines.length && lines[i].trim() === '') i++;
  for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const [name, ...rest] = splitRow(lines[i]);
    if (!attrs.has(name)) attrs.set(name, rest.join('|').trim());
  }
  return attrs;
}

export function parseDocItems(file: string, text: string): TraceItem[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const items: TraceItem[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING.exec(lines[i]);
    const kind = m ? kindOf(m[1]) : null;
    if (!m || kind === null) continue;

    const attrs = readAttributes(lines, i + 1);
    const parents = extractIds(attrs.get('上位') ?? '');
    const status = attrs.get('状態') ?? '';
    const item: TraceItem = {
      id: m[1],
      kind,
      title: m[2].trim(),
      file,
      line: i + 1,
      parents: parents.ids,
      outOfScopeParents: parents.outOfScope,
      rationale: attrs.get('根拠') ?? '',
      status: (STATUSES as readonly string[]).includes(status) ? (status as ItemStatus) : '',
      oldIds: extractIds(attrs.get('旧番号') ?? '').ids,
    };
    const optional = [
      ['確かめ方', 'verification'],
      ['出どころ', 'source'],
      ['優先度', 'priority'],
      ['旧所在', 'oldLocation'],
    ] as const;
    for (const [name, key] of optional) {
      const v = attrs.get(name);
      if (v !== undefined) item[key] = v;
    }
    items.push(item);
  }
  return items;
}
