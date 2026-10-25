// 既知の違反を「基準」として持ち、基準より増えた物だけで落とす（設計 9-2 の「通る」を、増えないことで確かめる）。
// 基準は scripts/trace/baseline.json の `{ violations: string[] }`。届かない分岐の基準は test-gaps.md の「届かない分岐」の節（check-coverage.ts）。

import type { Violation } from './rules';

export interface Baseline { violations: string[] }

/** 違反の同一性。行の番号は文書の書き足しでずれるので入れない（同じ物が複数あれば同じ鍵を重ねる）。 */
export const violationKey = (v: Violation): string => `${v.rule}|${v.file}|${v.message}`;

/**
 * keys のうち基準に無い物（増えた）と、基準にあって keys に無い物（減った）を返す。
 * 同じ鍵は個数で比べる（基準に2件ある鍵が3件になれば、1件が増えた）。
 */
export function diffKeys(keys: string[], baseline: string[]): { added: string[]; removed: string[] } {
  const left = new Map<string, number>();
  for (const k of baseline) left.set(k, (left.get(k) ?? 0) + 1);
  const added: string[] = [];
  for (const k of keys) {
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else added.push(k);
  }
  const removed = [...left].flatMap(([k, n]) => Array<string>(n).fill(k));
  return { added, removed };
}

/** 違反を基準と比べる。added は基準より増えた違反そのもの。 */
export function diffViolations(violations: Violation[], baseline: string[]): { added: Violation[]; removed: string[] } {
  const keyed = violations.map((v) => [violationKey(v), v] as const);
  const { added, removed } = diffKeys(keyed.map(([k]) => k), baseline);
  const pending = [...added];
  const addedViolations: Violation[] = [];
  for (const [k, v] of keyed) {
    const at = pending.indexOf(k);
    if (at >= 0) {
      pending.splice(at, 1);
      addedViolations.push(v);
    }
  }
  return { added: addedViolations, removed };
}
