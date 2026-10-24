import { adminLoadFailureMessage } from '@/lib/admin/admin-load-failure';

const FORBIDDEN = 'この画面を見る権限がありません。';
const FAILED = '読み込めませんでした。';

describe('adminLoadFailureMessage', () => {
  test('FREQ-525-AC-01: 本文の reason が MFA required なら、権限の文ではなく「2要素認証が必要です」を出す', () => {
    expect(adminLoadFailureMessage(403, { error: 'Forbidden', reason: 'MFA required' }, FORBIDDEN, FAILED)).toBe('2要素認証が必要です');
  });

  test('FREQ-525-AC-01: MFA の知らせは状態の番号より先に見る（401・500 でも同じ）', () => {
    expect(adminLoadFailureMessage(401, { reason: 'MFA required' }, FORBIDDEN, FAILED)).toBe('2要素認証が必要です');
    expect(adminLoadFailureMessage(500, { reason: 'MFA required' }, FORBIDDEN, FAILED)).toBe('2要素認証が必要です');
  });

  test('FREQ-525-AC-01: 401 は「ログインし直してください。」', () => {
    expect(adminLoadFailureMessage(401, { error: 'Unauthorized' }, FORBIDDEN, FAILED)).toBe('ログインし直してください。');
    expect(adminLoadFailureMessage(401, null, FORBIDDEN, FAILED)).toBe('ログインし直してください。');
  });

  test('FREQ-525-AC-01: MFA の知らせが無い 403 は、呼び出し側が渡した権限の文を出す', () => {
    expect(adminLoadFailureMessage(403, { error: 'Forbidden', permission: 'admin.stock.read' }, FORBIDDEN, FAILED)).toBe(FORBIDDEN);
    expect(adminLoadFailureMessage(403, null, FORBIDDEN, FAILED)).toBe(FORBIDDEN);
    expect(adminLoadFailureMessage(403, { reason: 'something else' }, FORBIDDEN, FAILED)).toBe(FORBIDDEN);
  });

  test('FREQ-525-AC-01: それ以外の状態は、呼び出し側が渡した失敗の文を出す', () => {
    for (const status of [400, 404, 429, 500, 503]) {
      expect(adminLoadFailureMessage(status, { error: 'x' }, FORBIDDEN, FAILED)).toBe(FAILED);
    }
  });

  test.each([undefined, null, 'MFA required', 42, ['MFA required'], { reason: 1 }, { reason: ['MFA required'] }])(
    'FREQ-525-AC-01: 本文が読めない形（%j）でも MFA とは見なさず、状態の番号で決める', (body) => {
      expect(adminLoadFailureMessage(403, body, FORBIDDEN, FAILED)).toBe(FORBIDDEN);
      expect(adminLoadFailureMessage(500, body, FORBIDDEN, FAILED)).toBe(FAILED);
    },
  );
});
