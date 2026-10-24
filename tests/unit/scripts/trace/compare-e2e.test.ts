/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, renameMap } from '@/../scripts/trace/compare-e2e';
import type { TestRef } from '@/../scripts/trace/parse-tests';

const ref = (title: string, line: number, file = 'e2e/a.spec.ts'): TestRef => ({ id: null, level: 'e2e', file, line, title });

describe('renameMap', () => {
  it('renameMap は頭に ID を足しただけの名前を同じテストとみなす', () => {
    const before = [{ id: null, level: 'e2e', file: 'e2e/a.spec.ts', line: 6, title: '公開日の新しい順' }] as TestRef[];
    const after = [{ id: 'FR-NEWS-ALL-001-AC-01', level: 'e2e', file: 'e2e/a.spec.ts', line: 6, title: 'FR-NEWS-ALL-001-AC-01 公開日の新しい順' }] as TestRef[];
    expect(renameMap(before, after).get('e2e/a.spec.ts::公開日の新しい順')).toBe('FR-NEWS-ALL-001-AC-01 公開日の新しい順');
  });

  it('頭の ID を差し替えた名前と、describe の名前の頭の ID も同じとみなす', () => {
    const map = renameMap(
      [ref('FR-NEWS-ALL-001 一覧 > 並ぶ', 6)],
      [ref('FR-NEWS-ALL-001-AC-02 一覧 > FR-NEWS-ALL-001-AC-02 並ぶ', 6)],
    );
    expect(map.get('e2e/a.spec.ts::FR-NEWS-ALL-001 一覧 > 並ぶ')).toBe('FR-NEWS-ALL-001-AC-02 一覧 > FR-NEWS-ALL-001-AC-02 並ぶ');
  });

  it('名前が変わらない物・ファイルが違う物・ID 以外が変わった物は載せない', () => {
    const map = renameMap(
      [ref('同じ', 3), ref('別のファイル', 4), ref('中身が変わる', 5)],
      [ref('同じ', 3), ref('FR-NEWS-ALL-001-AC-01 別のファイル', 4, 'e2e/b.spec.ts'), ref('FR-NEWS-ALL-001-AC-01 中身が変わった', 5)],
    );
    expect(map.size).toBe(0);
  });

  it('当てはまる後の名前が2つあれば行の近い方に当てる', () => {
    const map = renameMap([ref('並ぶ', 40)], [ref('FR-NEWS-ALL-001-AC-01 並ぶ', 12), ref('FR-NEWS-ALL-001-AC-02 並ぶ', 41)]);
    expect(map.get('e2e/a.spec.ts::並ぶ')).toBe('FR-NEWS-ALL-001-AC-02 並ぶ');
  });

  it('1つの後の名前は1回だけ使う', () => {
    const map = renameMap([ref('並ぶ', 10), ref('並ぶ', 10, 'e2e/b.spec.ts'), ref('FR-NEWS-ALL-001 並ぶ', 11)], [ref('FR-NEWS-ALL-001-AC-01 並ぶ', 10)]);
    expect([...map.values()]).toEqual(['FR-NEWS-ALL-001-AC-01 並ぶ']);
    expect(map.has('e2e/a.spec.ts::並ぶ')).toBe(true);
  });
});

describe('main', () => {
  let dir: string;
  const spec = (title: string, status: string, line = 5) => ({
    id: `${title}-id`, title, file: 'FR-NEWS-ALL-001-a.spec.ts', line,
    tests: ['mobile', 'desktop'].map((projectName) => ({ projectName, status })),
  });
  const write = (name: string, specs: unknown[]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ suites: [{ title: 'FR-NEWS-ALL-001-a.spec.ts', file: 'FR-NEWS-ALL-001-a.spec.ts', specs }] }));
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-compare-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('前にあり後に無いテストがあれば標準エラーに警告する', () => {
    const before = write('before.json', [spec('公開日の新しい順', 'expected'), spec('消えた', 'expected', 9)]);
    const after = write('after.json', [spec('FR-NEWS-ALL-001-AC-01 公開日の新しい順', 'expected')]);
    expect(main([before, after])).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('前にあり後に無いテストが 2 件'));
  });

  it('前にあり後に無いテストが無ければ警告しない', () => {
    const before = write('before.json', [spec('公開日の新しい順', 'expected')]);
    const after = write('after.json', [spec('FR-NEWS-ALL-001-AC-01 公開日の新しい順', 'expected')]);
    main([before, after]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('名前に ID を足しただけで通り続けていれば 0', () => {
    const before = write('before.json', [spec('公開日の新しい順', 'expected')]);
    const after = write('after.json', [spec('FR-NEWS-ALL-001-AC-01 公開日の新しい順', 'expected')]);
    expect(main([before, after])).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('名前を変えた: 1件'));
  });

  it('前に通って後で落ちれば 1', () => {
    const before = write('before.json', [spec('公開日の新しい順', 'expected')]);
    const after = write('after.json', [spec('FR-NEWS-ALL-001-AC-01 公開日の新しい順', 'unexpected')]);
    expect(main([before, after])).toBe(1);
  });

  it('後にだけある失敗があれば 1', () => {
    const before = write('before.json', [spec('公開日の新しい順', 'expected')]);
    const after = write('after.json', [spec('FR-NEWS-ALL-001-AC-01 公開日の新しい順', 'expected'), spec('FR-NEWS-ALL-001-AC-02 足した', 'unexpected', 9)]);
    expect(main([before, after])).toBe(1);
  });

  it('前に落ちていて後も落ちるだけなら 0', () => {
    const before = write('before.json', [spec('公開日の新しい順', 'unexpected')]);
    const after = write('after.json', [spec('FR-NEWS-ALL-001-AC-01 公開日の新しい順', 'unexpected')]);
    expect(main([before, after])).toBe(0);
  });

  it('引数が2つでなければ 2', () => {
    expect(main([])).toBe(2);
  });
});
