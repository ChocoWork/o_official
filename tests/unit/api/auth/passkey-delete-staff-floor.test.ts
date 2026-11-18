/** @jest-environment node */
/**
 * DD-AUTH-082 DELETE /api/auth/passkey/{id} の店員の下限。窓口と下限の部品は本物を通し、外へ出る物（DB の RPC・GoTrue・認証・CSRF・回数の制限・監査）だけを差し替える。
 * 下限の数え方そのもの（認めた鍵のときだけ止める）は DB の結合テスト（auth_passkey_staff_roles）が確かめる。ここは窓口が DB の答えを正しく写すことを確かめる。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/passkey-gotrue', () => ({ listPasskeys: jest.fn(), updatePasskey: jest.fn(), deletePasskey: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: () => new Response('{}', { status: 401 }),
}));
jest.mock('@/lib/auth/passkey-auth-session-end', () => ({ endAuthSessionById: jest.fn().mockResolvedValue(true) }));

import { DELETE } from '@/app/api/auth/passkey/[id]/route';
import { authenticateRequest } from '@/lib/auth/authenticate';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { deletePasskey } from '@/lib/auth/passkey-gotrue';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '99999999-9999-4999-8999-999999999999';
const KEY = '33333333-3333-4333-8333-333333333333';

let isStaff: boolean;
let floorError: { code: string; message: string } | null;
const rpc = jest.fn();

const req = () => new Request('http://localhost/api/auth/passkey', { method: 'DELETE', headers: { authorization: 'Bearer tok' } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  jest.clearAllMocks();
  isStaff = true;
  floorError = null;
  (authenticateRequest as jest.Mock).mockResolvedValue({ ok: true, claims: { sub: USER_ID, session_id: 'sess' } });
  (deletePasskey as jest.Mock).mockResolvedValue({ ok: true, data: null });
  rpc.mockImplementation(async (name: string) => {
    if (name === 'passkey_is_staff') return { data: isStaff, error: null };
    if (name === 'staff_idle_check') return { data: true, error: null };
    if (name === 'passkey_delete_with_floor') return { data: null, error: floorError };
    return { data: null, error: null };
  });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
});

describe('DD-AUTH-082 店員の削除の下限', () => {
  test('DD-AUTH-082 認めた鍵が2本の店員が1本消そうとすると、DB の STAFF_MIN_KEYS が 409 staff_min_keys になり、鍵は消えない', async () => {
    floorError = { code: 'P0001', message: 'STAFF_MIN_KEYS' };
    const res = await DELETE(req(), ctx(KEY));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'staff_min_keys' });
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  test('DD-AUTH-082 認めた鍵が3本の店員は消せる。DB の関数へ渡すのは検証済みのセッションの人で、GoTrue の削除は呼ばない', async () => {
    const res = await DELETE(req(), ctx(KEY));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('passkey_delete_with_floor', { p_user_id: USER_ID, p_passkey_id: KEY });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(OTHER_ID);
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  test('DD-AUTH-082 お客さんは最後の1本も消せる。DB の下限の関数は呼ばず、従来どおり GoTrue で消す', async () => {
    isStaff = false;
    const res = await DELETE(req(), ctx(KEY));
    expect(res.status).toBe(200);
    expect(deletePasskey).toHaveBeenCalledWith('tok', KEY);
    expect(rpc).not.toHaveBeenCalledWith('passkey_delete_with_floor', expect.anything());
  });

  test('DD-AUTH-082 下限を割らない削除（認めていない鍵）は、認めた鍵が下限未満の店員でも DB が通し、200 になる', async () => {
    const res = await DELETE(req(), ctx(KEY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
