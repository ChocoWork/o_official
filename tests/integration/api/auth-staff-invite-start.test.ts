/** @jest-environment node */
/**
 * API-AUTH-037 POST /api/auth/staff/invite/start（招待のリンクの受け口）の結合テスト。
 * 窓口・合言葉のハッシュ・招待の部品・セッションを作る部品は本物で、境界（GoTrue・DB・アプリのセッションの保存・回数の枠）だけを差し替える。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(), createPublicClient: jest.fn() }));
jest.mock('@/features/auth/services/register', () => ({ persistSessionAndCookies: jest.fn() }));

import { createHash } from 'node:crypto';
import { POST } from '@/app/api/auth/staff/invite/start/route';
import { createInviteToken } from '@/features/auth/staff/invite-token';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { persistSessionAndCookies } from '@/features/auth/services/register';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const INVITE_ID = '33333333-3333-4333-8333-333333333333';
const ACCESS = `h.${Buffer.from(JSON.stringify({ session_id: SESSION_ID })).toString('base64url')}.s`;

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
const revoked: string[] = [];

function wire(opts: { consume: unknown[]; bindError?: boolean }) {
  const rpc = jest.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'staff_invite_consume') return { data: opts.consume, error: null };
    if (name === 'staff_invite_bind_window') return { data: null, error: opts.bindError ? { message: 'x' } : null };
    if (name === 'revoke_auth_session') {
      revoked.push(String(args.p_session_id));
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({
    rpc,
    auth: {
      admin: {
        getUserById: jest.fn().mockResolvedValue({ data: { user: { email: 'a@example.com' } }, error: null }),
        generateLink: jest.fn().mockResolvedValue({ data: { properties: { hashed_token: 'h' } }, error: null }),
      },
    },
  });
  (createPublicClient as jest.Mock).mockResolvedValue({
    auth: {
      verifyOtp: jest.fn().mockResolvedValue({
        data: { session: { access_token: ACCESS, refresh_token: 'r' }, user: { id: USER_ID } },
        error: null,
      }),
    },
  });
}

const post = (token: string) =>
  POST(
    new Request('http://localhost/api/auth/staff/invite/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  );

describe('API-AUTH-037 招待のリンクの受け口', () => {
  beforeEach(() => {
    calls.length = 0;
    revoked.length = 0;
    (persistSessionAndCookies as jest.Mock).mockReset();
    (enforceRateLimit as jest.Mock).mockResolvedValue(undefined);
    (persistSessionAndCookies as jest.Mock).mockResolvedValue({ ok: true });
  });

  it('API-AUTH-037 DB には合言葉の UTF-8 の SHA-256（\\x の16進）だけを渡し、結んだ session_id は JWT の claim', async () => {
    const { token } = createInviteToken();
    wire({ consume: [{ invite_id: INVITE_ID, user_id: USER_ID, role_code: 'admin' }] });

    const res = await post(token);

    expect(res.status).toBe(200);
    const consume = calls.find((c) => c.name === 'staff_invite_consume');
    expect(consume?.args).toEqual({ p_token_hash: `\\x${createHash('sha256').update(token, 'utf8').digest('hex')}` });
    expect(JSON.stringify(calls)).not.toContain(token);
    expect(calls.find((c) => c.name === 'staff_invite_bind_window')?.args).toEqual({
      p_invite_id: INVITE_ID,
      p_session_id: SESSION_ID,
    });
  });

  it('API-AUTH-037 消費が0行なら 400 invite_invalid で、セッションを作らず結びもしない', async () => {
    const { token } = createInviteToken();
    wire({ consume: [] });

    const res = await post(token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invite_invalid' });
    expect(calls.map((c) => c.name)).toEqual(['staff_invite_consume']);
  });

  it('API-AUTH-037 結びが失敗したら、作ったセッションを revoke_auth_session で終わらせて 500', async () => {
    const { token } = createInviteToken();
    wire({ consume: [{ invite_id: INVITE_ID, user_id: USER_ID, role_code: 'admin' }], bindError: true });

    const res = await post(token);

    expect(res.status).toBe(500);
    expect(revoked).toEqual([SESSION_ID]);
    expect(persistSessionAndCookies).not.toHaveBeenCalled();
  });
});
