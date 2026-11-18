/** @jest-environment node */
export {};

// パスキーの一覧・名前の変更・削除の窓口（API-AUTH-026・027・028）。窓口・共通の確かめ（passkey-manage-guard）・回数の制限の本体（enforceRateLimit）・
// zod の形・認めの RPC の部品（passkey-approval-rpc）は本物を通し、外へ出る物（回数の表 incrementCounter・監査・認証の確かめ・CSRF・GoTrue・DB の RPC）だけを差し替える。
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/ratelimit', () => ({ incrementCounter: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/passkey-gotrue', () => ({ listPasskeys: jest.fn(), updatePasskey: jest.fn(), deletePasskey: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => {
  const actual = jest.requireActual('@/lib/auth/authenticate');
  return { ...actual, authenticateRequest: jest.fn() };
});

import { GET } from '@/app/api/auth/passkey/route';
import { DELETE, PATCH } from '@/app/api/auth/passkey/[id]/route';
import { incrementCounter } from '@/features/auth/ratelimit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { deletePasskey, listPasskeys, updatePasskey } from '@/lib/auth/passkey-gotrue';
import { authenticateRequest } from '@/lib/auth/authenticate';

const counter = incrementCounter as jest.Mock;
const ORIGINAL_ENV = { ...process.env };
const IP = '203.0.113.50';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const KEY_A = '33333333-3333-4333-8333-333333333333';
const KEY_B = '44444444-4444-4444-8444-444444444444';
// 16進の英字を含む（大文字にすると別の文字列になる）。認めた鍵の一覧は小文字で返る。
const HEX_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let rpc: jest.Mock;
let isStaff: boolean;
let approvedIds: string[];
let approvedCount: number;
let floorError: { code: string; message: string } | null;

function req(method: string, body?: unknown) {
  return new Request('http://localhost/api/auth/passkey', {
    method,
    headers: { authorization: 'Bearer tok', 'x-real-ip': IP, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, CLIENT_IP_HEADER: 'x-real-ip' };
  counter.mockReset().mockResolvedValue(1);
  (requireCsrfOrDeny as jest.Mock).mockReset().mockResolvedValue(undefined);
  (authenticateRequest as jest.Mock).mockReset().mockResolvedValue({ ok: true, claims: { sub: USER_ID, session_id: SESSION_ID } });
  (listPasskeys as jest.Mock).mockReset().mockResolvedValue({
    ok: true,
    data: [{ id: KEY_A, friendly_name: 'Mac', created_at: '2026-11-01T00:00:00Z', public_key: 'SECRET' }],
  });
  (updatePasskey as jest.Mock).mockReset().mockResolvedValue({ ok: true, data: { id: KEY_A, friendly_name: 'Phone' } });
  (deletePasskey as jest.Mock).mockReset().mockResolvedValue({ ok: true, data: null });
  isStaff = true;
  approvedIds = [KEY_A, KEY_B];
  approvedCount = 2;
  floorError = null;
  rpc = jest.fn(async (name: string) => {
    if (name === 'passkey_is_staff') return { data: isStaff, error: null };
    if (name === 'passkey_approved_ids') return { data: approvedIds, error: null };
    if (name === 'passkey_approved_count') return { data: approvedCount, error: null };
    if (name === 'staff_idle_check') return { data: true, error: null };
    if (name === 'passkey_delete_with_floor') return { data: null, error: floorError };
    return { data: null, error: null };
  });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('API-AUTH-026 GET /api/auth/passkey', () => {
  test('API-AUTH-026 本物の回数の制限と認めの RPC の部品を通り、店員は approved と approvedCount が付き、公開鍵は出ない', async () => {
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      isStaff: true,
      approvedCount: 2,
      passkeys: [{ id: KEY_A, friendly_name: 'Mac', created_at: '2026-11-01T00:00:00Z', last_used_at: null, approved: true }],
    });
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(counter).toHaveBeenCalledWith(expect.objectContaining({ ip: IP, endpoint: 'auth:passkey:list' }));
    expect(rpc).toHaveBeenCalledWith('passkey_approved_ids', { p_user_id: USER_ID });
  });

  test('API-AUTH-026 お客さんは認めの表を引かず、approved も approvedCount も無い', async () => {
    isStaff = false;
    const body = await (await GET(req('GET'))).json();
    expect(body).toEqual({
      isStaff: false,
      passkeys: [{ id: KEY_A, friendly_name: 'Mac', created_at: '2026-11-01T00:00:00Z', last_used_at: null }],
    });
    expect(rpc).not.toHaveBeenCalledWith('passkey_approved_ids', expect.anything());
  });

  test('API-AUTH-026 回数の表が上限（61回目）を超えたら 429 で、認証を呼ばない', async () => {
    counter.mockResolvedValue(61);
    const res = await GET(req('GET'));
    expect(res.status).toBe(429);
    expect(authenticateRequest).not.toHaveBeenCalled();
  });
});

describe('API-AUTH-027 PATCH /api/auth/passkey/{id}', () => {
  test('API-AUTH-027 本物の zod の形を通り、名前を変えて 200', async () => {
    const res = await PATCH(req('PATCH', { friendly_name: ' Phone ' }), ctx(KEY_A));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ passkey: { id: KEY_A, friendly_name: 'Phone' } });
    expect(updatePasskey).toHaveBeenCalledWith('tok', { passkeyId: KEY_A, friendlyName: 'Phone' });
    expect(counter).toHaveBeenCalledWith(expect.objectContaining({ ip: IP, endpoint: 'auth:passkey:rename' }));
  });

  test('API-AUTH-027 uuid でない id・65字の名前は 400 で、GoTrue を呼ばない', async () => {
    expect((await PATCH(req('PATCH', { friendly_name: 'x' }), ctx('zzz'))).status).toBe(400);
    expect((await PATCH(req('PATCH', { friendly_name: 'a'.repeat(65) }), ctx(KEY_A))).status).toBe(400);
    expect(updatePasskey).not.toHaveBeenCalled();
  });

  test('API-AUTH-027 日本語41字（123バイト）は 400 で GoTrue を呼ばず、40字（120バイト）は 200', async () => {
    expect((await PATCH(req('PATCH', { friendly_name: 'あ'.repeat(41) }), ctx(KEY_A))).status).toBe(400);
    expect(updatePasskey).not.toHaveBeenCalled();
    expect((await PATCH(req('PATCH', { friendly_name: 'あ'.repeat(40) }), ctx(KEY_A))).status).toBe(200);
    expect(updatePasskey).toHaveBeenCalledTimes(1);
  });

  test('API-AUTH-027 CSRF で断られたら 403 で、GoTrue を呼ばない', async () => {
    (requireCsrfOrDeny as jest.Mock).mockResolvedValue(new Response('{}', { status: 403 }));
    expect((await PATCH(req('PATCH', { friendly_name: 'x' }), ctx(KEY_A))).status).toBe(403);
    expect(updatePasskey).not.toHaveBeenCalled();
  });
});

describe('API-AUTH-028 DELETE /api/auth/passkey/{id}', () => {
  test('API-AUTH-028 店員が認めた鍵2本のうち1本を消すと、DB の下限が 409 staff_min_keys になり、GoTrue を呼ばない', async () => {
    floorError = { code: 'P0001', message: 'STAFF_MIN_KEYS' };
    const res = await DELETE(req('DELETE'), ctx(KEY_A));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'staff_min_keys' });
    expect(deletePasskey).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('passkey_delete_with_floor', { p_user_id: USER_ID, p_passkey_id: KEY_A });
  });

  test('API-AUTH-028 大文字の id は小文字にそろえて DB の関数へ渡す', async () => {
    await DELETE(req('DELETE'), ctx(HEX_KEY.toUpperCase()));
    expect(rpc).toHaveBeenCalledWith('passkey_delete_with_floor', { p_user_id: USER_ID, p_passkey_id: HEX_KEY });
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  test('API-AUTH-028 店員が認めた鍵3本のうち1本を消すと 200。GoTrue の削除は呼ばず DB の関数だけ', async () => {
    const res = await DELETE(req('DELETE'), ctx(KEY_A));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  test('API-AUTH-028 お客さんは最後の1本も消せる。GoTrue の 404 は 404 not_found', async () => {
    isStaff = false;
    expect((await DELETE(req('DELETE'), ctx(KEY_A))).status).toBe(200);
    (deletePasskey as jest.Mock).mockResolvedValue({ ok: false, status: 404 });
    const res = await DELETE(req('DELETE'), ctx(KEY_B));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
