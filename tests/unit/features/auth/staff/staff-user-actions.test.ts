/**
 * DD-AUTH-084 店員の操作の送り（src/features/auth/staff/staff-user-actions.ts）。窓口の符号と状態から、店長向けの文を決める。
 */
jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
import { clientFetch } from '@/lib/client-fetch';
import { postStaffAction } from '@/features/auth/staff/staff-user-actions';

const mockFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

function answer(status: number, body: unknown) {
  mockFetch.mockResolvedValue({ ok: status < 400, status, json: async () => body } as Response);
}

beforeEach(() => mockFetch.mockReset());

describe('DD-AUTH-084 postStaffAction', () => {
  test('DD-AUTH-084 成功は ok で、本文を JSON で POST する', async () => {
    answer(200, { success: true });
    await expect(postStaffAction('/api/admin/staff/x/redo', { confirm: 'やり直し' })).resolves.toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledWith('/api/admin/staff/x/redo', expect.objectContaining({ method: 'POST', body: '{"confirm":"やり直し"}' }));
  });

  test('DD-AUTH-084 本文が無い呼びは空の JSON を送る', async () => {
    answer(200, {});
    await postStaffAction('/api/admin/staff/x/demote');
    expect(mockFetch.mock.calls[0][1]?.body).toBe('{}');
  });

  test.each<[number, unknown, string]>([
    [502, { code: 'mail_failed' }, 'メールを送れませんでした。もう一度、招待を出してください。'],
    [409, { code: 'already_staff' }, 'すでに店員です。やり直しは、一覧の「パスキーを全部消してやり直す」から行ってください。'],
    [503, { code: 'config' }, 'ただいま処理できません。しばらくしてからお試しください。'],
    [503, null, 'ただいま処理できません。しばらくしてからお試しください。'],
    [429, null, 'ただいま処理できません。しばらくしてからお試しください。'],
    [409, { code: 'last_admin' }, '店長を1人以上残してください。'],
    [409, { code: 'LAST_ADMIN_REQUIRED' }, '店長を1人以上残してください。'],
    [403, { code: 'self' }, '自分自身は変更できません。'],
    [409, { code: 'not_staff' }, '店員ではありません。'],
    [404, { code: 'not_found' }, 'ユーザーが見つかりません。一覧を読み込み直してください。'],
    [400, { error: 'Invalid request' }, '入力を確かめてください。'],
    [401, { error: 'unauthorized' }, '認証が必要です。再ログインしてください。'],
    [403, { error: 'Forbidden' }, 'この操作は店長だけが行えます。'],
    [500, { error: 'Internal server error' }, '処理を完了できませんでした。もう一度お試しください。'],
  ])('DD-AUTH-084 %i %j は決めた文にする', async (status, body, message) => {
    answer(status, body);
    await expect(postStaffAction('/api/admin/staff/x/demote')).resolves.toEqual({ ok: false, message });
  });

  test('DD-AUTH-084 本文が JSON でなくても、状態から文を決める', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('not json'); } } as unknown as Response);
    await expect(postStaffAction('/api/admin/staff/x/demote')).resolves.toEqual({ ok: false, message: '処理を完了できませんでした。もう一度お試しください。' });
  });

  test('DD-AUTH-084 通信が失敗しても投げず、文にして返す', async () => {
    mockFetch.mockRejectedValue(new Error('network'));
    await expect(postStaffAction('/api/admin/staff/x/demote')).resolves.toEqual({ ok: false, message: '処理を完了できませんでした。もう一度お試しください。' });
  });
});
