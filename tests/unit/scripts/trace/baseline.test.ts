/** @jest-environment node */
import { diffKeys, diffViolations, violationKey } from '@/../scripts/trace/baseline';
import type { Violation } from '@/../scripts/trace/rules';

const v = (rule: string, message: string, file = 'docs/a.md', line = 1): Violation => ({ rule, message, file, line });

describe('violationKey', () => {
  it('行の番号を入れない（文書の書き足しでずれても同じ違反とみなす）', () => {
    expect(violationKey(v('missing-child', 'X に Y が無い', 'docs/a.md', 3))).toBe(violationKey(v('missing-child', 'X に Y が無い', 'docs/a.md', 90)));
    expect(violationKey(v('missing-child', 'X に Y が無い'))).toBe('missing-child|docs/a.md|X に Y が無い');
  });
});

describe('diffKeys', () => {
  it('基準にある鍵は既知、無い鍵は増えた、基準にだけある鍵は減ったとする', () => {
    expect(diffKeys(['a', 'b'], ['a', 'c'])).toEqual({ added: ['b'], removed: ['c'] });
  });

  it('同じ鍵は個数で比べる', () => {
    expect(diffKeys(['a', 'a', 'a'], ['a', 'a'])).toEqual({ added: ['a'], removed: [] });
    expect(diffKeys(['a'], ['a', 'a'])).toEqual({ added: [], removed: ['a'] });
  });
});

describe('diffViolations', () => {
  it('基準より増えた違反そのものを返し、基準の物は返さない', () => {
    const known = v('untagged-test', 'テスト「x」の名前に ID が無い', 'e2e/a.spec.ts', 5);
    const fresh = v('missing-child', 'DD-NEWS-001 に 単体テスト が無い');
    const r = diffViolations([known, fresh], [violationKey(known)]);
    expect(r.added).toEqual([fresh]);
    expect(r.removed).toEqual([]);
  });

  it('基準にだけある違反は removed に出す', () => {
    expect(diffViolations([], ['missing-child|docs/a.md|直った']).removed).toEqual(['missing-child|docs/a.md|直った']);
  });

  it('基準が空なら全部が増えた', () => {
    const all = [v('bad-id', 'a'), v('bad-id', 'b')];
    expect(diffViolations(all, []).added).toEqual(all);
  });
});
