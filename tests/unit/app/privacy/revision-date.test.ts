// 最終改定日の決め方（DD-PRIVACY-003）の単体テスト。固定の基準日と、追跡の設定が変わった時刻（日本時間の日付）の遅いほうを返す。

import { PRIVACY_POLICY_BASE_REVISION, resolveRevisionDate } from '@/app/privacy/revision-date';

describe('resolveRevisionDate', () => {
  test('DD-PRIVACY-003 基準日は 2026-10-26', () => {
    expect(PRIVACY_POLICY_BASE_REVISION).toBe('2026-10-26');
  });

  test.each([
    { label: 'null（切り替えていない）', value: null, expected: '2026年10月26日' },
    { label: '空の文字', value: '', expected: '2026年10月26日' },
    { label: '読めない値', value: 'not-a-date', expected: '2026年10月26日' },
    { label: '基準日より前', value: '2026-06-01T00:00:00Z', expected: '2026年10月26日' },
    { label: '旧基準日（2026-07-11）の翌日 0 時。新しい基準日より前なので基準日のまま', value: '2026-07-11T15:00:00Z', expected: '2026年10月26日' },
    { label: '日本時間で基準日の 1 分前（前日の 23:59）', value: '2026-10-25T14:59:00Z', expected: '2026年10月26日' },
    { label: '日本時間でちょうど基準日の 0 時', value: '2026-10-25T15:00:00Z', expected: '2026年10月26日' },
    { label: '日本時間で基準日の翌日の 0 時（UTC の日付のままだと基準日になる境目）', value: '2026-10-26T15:00:00Z', expected: '2026年10月27日' },
    { label: '日本時間で日付が繰り上がる（UTC 16:30）', value: '2026-10-26T16:30:00Z', expected: '2026年10月27日' },
    { label: '月・日はゼロ詰めしない', value: '2027-01-05T00:00:00Z', expected: '2027年1月5日' },
  ])('DD-PRIVACY-003 $label は $expected', ({ value, expected }) => {
    expect(resolveRevisionDate(value)).toBe(expected);
  });
});
