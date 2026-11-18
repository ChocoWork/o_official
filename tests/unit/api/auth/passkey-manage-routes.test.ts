/** @jest-environment node */
/**
 * DD-AUTH-057 パスキーの一覧・名前の変更・削除の窓口（src/app/api/auth/passkey/route.ts・[id]/route.ts）の単体テスト。
 * 認証・CSRF・回数の制限・認めの RPC・GoTrue は差し替え、断りの順番・許可リスト方式・店員の削除の止め・404 のそろえを確かめる。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: (reason: string) =>
    reason === 'unavailable'
      ? new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), { status: 503 })
      : new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}));
jest.mock('@/lib/auth/passkey-approval-rpc', () => ({ isStaff: jest.fn(), approvedIds: jest.fn(), approvedCount: jest.fn() }));
jest.mock('@/lib/auth/staff-passkey-idle-rpc', () => ({ staffIdleCheck: jest.fn(), staffIdlePeek: jest.fn() }));
jest.mock('@/lib/auth/passkey-auth-session-end', () => ({ endAuthSessionById: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/auth/passkey-gotrue', () => ({ listPasskeys: jest.fn(), updatePasskey: jest.fn(), deletePasskey: jest.fn() }));

import { GET } from '@/app/api/auth/passkey/route';
import { DELETE, PATCH } from '@/app/api/auth/passkey/[id]/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { authenticateRequest } from '@/lib/auth/authenticate';
import { approvedCount, approvedIds, isStaff } from '@/lib/auth/passkey-approval-rpc';
import { deletePasskey, listPasskeys, updatePasskey } from '@/lib/auth/passkey-gotrue';
import { logAudit } from '@/lib/audit';
import { staffIdleCheck } from '@/lib/auth/staff-passkey-idle-rpc';

const rateLimit = enforceRateLimit as jest.Mock;
const csrf = requireCsrfOrDeny as jest.Mock;
const authenticate = authenticateRequest as jest.Mock;
const staffMock = isStaff as jest.Mock;
const idsMock = approvedIds as jest.Mock;
const countMock = approvedCount as jest.Mock;
const listMock = listPasskeys as jest.Mock;
const updateMock = updatePasskey as jest.Mock;
const deleteMock = deletePasskey as jest.Mock;
const audit = logAudit as jest.Mock;

const USER_ID = '22222222-2222-4222-8222-222222222222';
const KEY_A = '33333333-3333-4333-8333-333333333333';
const KEY_B = '44444444-4444-4444-8444-444444444444';
const KEY_C = '55555555-5555-4555-8555-555555555555';
// 16進の英字を含む（大文字にすると別の文字列になる）。認めた鍵の一覧は小文字で返る。
const HEX_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function req(method: string, body?: unknown, headers: Record<string, string> = { authorization: 'Bearer tok-abc' }) {
  return new Request('http://localhost/api/auth/passkey', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  jest.clearAllMocks();
  rateLimit.mockResolvedValue(null);
  csrf.mockResolvedValue(undefined);
  authenticate.mockResolvedValue({ ok: true, claims: { sub: USER_ID, session_id: 'session-1' } });
  (staffIdleCheck as jest.Mock).mockResolvedValue({ ok: true, value: true });
  staffMock.mockResolvedValue({ ok: true, value: false });
  idsMock.mockResolvedValue({ ok: true, value: [KEY_A, KEY_B] });
  countMock.mockResolvedValue({ ok: true, value: 2 });
  listMock.mockResolvedValue({
    ok: true,
    data: [
      {
        id: KEY_A,
        friendly_name: 'Mac',
        created_at: '2026-11-01T00:00:00Z',
        last_used_at: '2026-11-02T00:00:00Z',
        public_key: 'SECRET-PUBLIC-KEY',
        credential_id: 'SECRET-CREDENTIAL-ID',
      },
      { id: KEY_C, created_at: '2026-11-03T00:00:00Z' },
    ],
  });
  updateMock.mockResolvedValue({ ok: true, data: { id: KEY_A, friendly_name: 'New name', created_at: 'x' } });
  deleteMock.mockResolvedValue({ ok: true, data: null });
});

describe('DD-AUTH-057 GET /api/auth/passkey（一覧）', () => {
  test('DD-AUTH-057 お客さんは許可リストの項目だけを返し、公開鍵・credential_id・approved・approvedCount を出さない', async () => {
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      passkeys: [
        { id: KEY_A, friendly_name: 'Mac', created_at: '2026-11-01T00:00:00Z', last_used_at: '2026-11-02T00:00:00Z' },
        { id: KEY_C, friendly_name: null, created_at: '2026-11-03T00:00:00Z', last_used_at: null },
      ],
      isStaff: false,
    });
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(idsMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
    expect(listMock).toHaveBeenCalledWith('tok-abc');
  });

  test('DD-AUTH-057 店員は approved と approvedCount が付く（認めた鍵だけ true）', async () => {
    staffMock.mockResolvedValue({ ok: true, value: true });
    countMock.mockResolvedValue({ ok: true, value: 1 });
    idsMock.mockResolvedValue({ ok: true, value: [KEY_A] });
    const body = await (await GET(req('GET'))).json();
    expect(body.isStaff).toBe(true);
    expect(body.approvedCount).toBe(1);
    expect(body.passkeys.map((p: { id: string; approved: boolean }) => [p.id, p.approved])).toEqual([
      [KEY_A, true],
      [KEY_C, false],
    ]);
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  test('DD-AUTH-057 回数の制限で断られたら認証・GoTrue を呼ばない（IP ごと 60回／600秒）', async () => {
    rateLimit.mockResolvedValue(new Response('{}', { status: 429 }));
    const res = await GET(req('GET'));
    expect(res.status).toBe(429);
    expect(authenticate).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledWith(expect.objectContaining({ limit: 60, windowSeconds: 600 }));
  });

  test('DD-AUTH-057 認証が 401・503 なら GoTrue を呼ばない', async () => {
    authenticate.mockResolvedValue({ ok: false, reason: 'missing' });
    expect((await GET(req('GET'))).status).toBe(401);
    authenticate.mockResolvedValue({ ok: false, reason: 'unavailable' });
    expect((await GET(req('GET'))).status).toBe(503);
    expect(listMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-057 一覧は CSRF を求めない', async () => {
    await GET(req('GET'));
    expect(csrf).not.toHaveBeenCalled();
  });

  test('DD-AUTH-057 店員の判定・認めの確かめが読めなければ 503（閉じる側）', async () => {
    staffMock.mockResolvedValue({ ok: false });
    expect((await GET(req('GET'))).status).toBe(503);
    // 入口の確かめは通り、窓口の2回目の判定だけが読めない時も 503
    staffMock.mockResolvedValueOnce({ ok: true, value: false }).mockResolvedValueOnce({ ok: false });
    expect((await GET(req('GET'))).status).toBe(503);
    staffMock.mockResolvedValue({ ok: true, value: true });
    idsMock.mockResolvedValue({ ok: false });
    expect((await GET(req('GET'))).status).toBe(503);
  });

  test('DD-AUTH-057 GoTrue の失敗・形の違う応答は 502（応答を写さない）', async () => {
    listMock.mockResolvedValue({ ok: false, status: 500 });
    expect((await GET(req('GET'))).status).toBe(502);
    listMock.mockResolvedValue({ ok: true, data: { not: 'array' } });
    expect((await GET(req('GET'))).status).toBe(502);
    listMock.mockResolvedValue({ ok: true, data: [{ id: KEY_A }] });
    expect((await GET(req('GET'))).status).toBe(502);
  });

  test('DD-AUTH-057 GoTrue が 401 なら 401、項目が object でない応答は 502、通行証の文字が取れなければ 401', async () => {
    listMock.mockResolvedValue({ ok: false, status: 401 });
    expect((await GET(req('GET'))).status).toBe(401);
    listMock.mockResolvedValue({ ok: true, data: ['x'] });
    expect((await GET(req('GET'))).status).toBe(502);
    listMock.mockClear();
    expect((await GET(req('GET', undefined, {}))).status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-057 監査にトークンと鍵を残さない', async () => {
    await GET(req('GET'));
    const logged = JSON.stringify(audit.mock.calls);
    expect(logged).not.toContain('tok-abc');
    expect(logged).not.toContain('SECRET');
  });
});

describe('DD-AUTH-057 PATCH /api/auth/passkey/{id}（名前の変更）', () => {
  test('DD-AUTH-057 名前を変えて 200 { passkey: { id, friendly_name } }', async () => {
    const res = await PATCH(req('PATCH', { friendly_name: '  New name  ' }), ctx(KEY_A));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ passkey: { id: KEY_A, friendly_name: 'New name' } });
    expect(updateMock).toHaveBeenCalledWith('tok-abc', { passkeyId: KEY_A, friendlyName: 'New name' });
    expect(csrf).toHaveBeenCalledTimes(1);
  });

  test('DD-AUTH-057 大文字の id は小文字にして GoTrue へ渡す（PATCH・DELETE）', async () => {
    expect(HEX_KEY.toUpperCase()).not.toBe(HEX_KEY);
    await PATCH(req('PATCH', { friendly_name: 'x' }), ctx(HEX_KEY.toUpperCase()));
    expect(updateMock).toHaveBeenCalledWith('tok-abc', { passkeyId: HEX_KEY, friendlyName: 'x' });
    await DELETE(req('DELETE'), ctx(HEX_KEY.toUpperCase()));
    expect(deleteMock).toHaveBeenCalledWith('tok-abc', HEX_KEY);
  });

  test('DD-AUTH-057 断りの順番: 回数の制限 → 認証 → CSRF。どれも GoTrue を呼ばない', async () => {
    rateLimit.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    expect((await PATCH(req('PATCH', { friendly_name: 'x' }), ctx(KEY_A))).status).toBe(429);
    expect(authenticate).not.toHaveBeenCalled();

    authenticate.mockResolvedValueOnce({ ok: false, reason: 'missing' });
    expect((await PATCH(req('PATCH', { friendly_name: 'x' }), ctx(KEY_A))).status).toBe(401);
    expect(csrf).not.toHaveBeenCalled();

    csrf.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    expect((await PATCH(req('PATCH', { friendly_name: 'x' }), ctx(KEY_A))).status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-057 id が uuid でなければ 400 で GoTrue を呼ばない', async () => {
    const res = await PATCH(req('PATCH', { friendly_name: 'x' }), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-057 名前の境界: 空・空白だけ・65字・制御文字・本文なしは 400、64字は 200', async () => {
    const bidi = String.fromCharCode(0x202e);
    const c1 = String.fromCharCode(0x85);
    for (const name of ['', '   ', 'a'.repeat(65), 'a\u0000b', 'a\nb', `a${c1}b`, `a${bidi}b`]) {
      const res = await PATCH(req('PATCH', { friendly_name: name }), ctx(KEY_A));
      expect(res.status).toBe(400);
    }
    expect((await PATCH(req('PATCH', {}), ctx(KEY_A))).status).toBe(400);
    expect((await PATCH(req('PATCH', 'not json'), ctx(KEY_A))).status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
    expect((await PATCH(req('PATCH', { friendly_name: 'a'.repeat(64) }), ctx(KEY_A))).status).toBe(200);
  });

  test('DD-AUTH-057 他人の鍵・存在しない鍵（GoTrue の 404）は 404 not_found', async () => {
    updateMock.mockResolvedValue({ ok: false, status: 404, message: 'passkey not found' });
    const res = await PATCH(req('PATCH', { friendly_name: 'x' }), ctx(KEY_B));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  test('DD-AUTH-057 GoTrue の失敗は 502、形の違う成功（本文なしを含む）も 502', async () => {
    updateMock.mockResolvedValue({ ok: false, status: 500 });
    expect((await PATCH(req('PATCH', { friendly_name: 'x' }), ctx(KEY_A))).status).toBe(502);
    updateMock.mockResolvedValue({ ok: true, data: { id: KEY_A } });
    expect((await PATCH(req('PATCH', { friendly_name: 'x' }), ctx(KEY_A))).status).toBe(502);
    updateMock.mockResolvedValue({ ok: true, data: null });
    expect((await PATCH(req('PATCH', { friendly_name: 'x' }), ctx(KEY_A))).status).toBe(502);
  });

  test('DD-AUTH-057 GoTrue の 401 は 401、400・422 は 400 invalid_request', async () => {
    updateMock.mockResolvedValue({ ok: false, status: 401 });
    expect((await PATCH(req('PATCH', { friendly_name: 'x' }), ctx(KEY_A))).status).toBe(401);
    updateMock.mockResolvedValue({ ok: false, status: 422 });
    const res = await PATCH(req('PATCH', { friendly_name: 'x' }), ctx(KEY_A));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    updateMock.mockResolvedValue({ ok: false, status: 400 });
    expect((await PATCH(req('PATCH', { friendly_name: 'x' }), ctx(KEY_A))).status).toBe(400);
  });
});

describe('DD-AUTH-057 DELETE /api/auth/passkey/{id}（削除）', () => {
  test('DD-AUTH-057 お客さんは認めの表を引かず、最後の1本も消せる', async () => {
    const res = await DELETE(req('DELETE'), ctx(KEY_A));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith('tok-abc', KEY_A);
    expect(idsMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-057 断りの順番: 回数の制限 → 認証 → CSRF。どれも GoTrue を呼ばない', async () => {
    rateLimit.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    expect((await DELETE(req('DELETE'), ctx(KEY_A))).status).toBe(429);
    authenticate.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    expect((await DELETE(req('DELETE'), ctx(KEY_A))).status).toBe(503);
    csrf.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    expect((await DELETE(req('DELETE'), ctx(KEY_A))).status).toBe(403);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-057 id が uuid でなければ 400 で GoTrue も DB も呼ばない', async () => {
    const res = await DELETE(req('DELETE'), ctx('1234'));
    expect(res.status).toBe(400);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(idsMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-057 店員: 認めた鍵が2本で認めた鍵を消すと 409 staff_min_passkeys で GoTrue を呼ばない', async () => {
    staffMock.mockResolvedValue({ ok: true, value: true });
    const res = await DELETE(req('DELETE'), ctx(KEY_A));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'staff_min_passkeys' });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-057 店員: 大文字の id でも小文字にそろえて認めた鍵と突き合わせ、2本なら 409 で GoTrue を呼ばない', async () => {
    staffMock.mockResolvedValue({ ok: true, value: true });
    idsMock.mockResolvedValue({ ok: true, value: [HEX_KEY, KEY_B] });
    countMock.mockResolvedValue({ ok: true, value: 2 });
    const res = await DELETE(req('DELETE'), ctx(HEX_KEY.toUpperCase()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'staff_min_passkeys' });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-057 店員: 認めた鍵が3本なら消せる（200）', async () => {
    staffMock.mockResolvedValue({ ok: true, value: true });
    idsMock.mockResolvedValue({ ok: true, value: [KEY_A, KEY_B, KEY_C] });
    countMock.mockResolvedValue({ ok: true, value: 3 });
    expect((await DELETE(req('DELETE'), ctx(KEY_A))).status).toBe(200);
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  test('DD-AUTH-057 店員: 認めていない鍵は、認めた鍵が2本のままでも消せる', async () => {
    staffMock.mockResolvedValue({ ok: true, value: true });
    expect((await DELETE(req('DELETE'), ctx(KEY_C))).status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith('tok-abc', KEY_C);
  });

  test('DD-AUTH-057 店員の判定・認めの確かめが読めなければ 503 で GoTrue を呼ばない', async () => {
    staffMock.mockResolvedValue({ ok: false });
    expect((await DELETE(req('DELETE'), ctx(KEY_A))).status).toBe(503);
    staffMock.mockResolvedValueOnce({ ok: true, value: false }).mockResolvedValueOnce({ ok: false });
    expect((await DELETE(req('DELETE'), ctx(KEY_A))).status).toBe(503);
    staffMock.mockResolvedValue({ ok: true, value: true });
    countMock.mockResolvedValue({ ok: false });
    expect((await DELETE(req('DELETE'), ctx(KEY_A))).status).toBe(503);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-057 他人の鍵（GoTrue の 404）は存在しない鍵と同じ 404 と本文', async () => {
    deleteMock.mockResolvedValue({ ok: false, status: 404, message: 'passkey not found' });
    const other = await DELETE(req('DELETE'), ctx(KEY_B));
    deleteMock.mockResolvedValue({ ok: false, status: 404 });
    const missing = await DELETE(req('DELETE'), ctx(KEY_C));
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
  });

  test('DD-AUTH-057 GoTrue の失敗は 502', async () => {
    deleteMock.mockResolvedValue({ ok: false, status: 500 });
    expect((await DELETE(req('DELETE'), ctx(KEY_A))).status).toBe(502);
  });

  test('DD-AUTH-057 監査にトークンを残さない', async () => {
    await DELETE(req('DELETE'), ctx(KEY_A));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('tok-abc');
  });
});
