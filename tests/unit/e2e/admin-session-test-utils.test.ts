/** @jest-environment node */
/**
 * DD-AUTH-039 E2E の道具 admin-session-test-utils が、アプリが作る sessions の行と同じ形の「結び付いた」行を作るかを、偽の DB と偽の Auth で確かめる。
 * bindAppSession の入力の検査・手元以外の拒否・失敗の文面に token を出さないこと、createAdminSessionActor / elevateAdminSessionToAal2 が
 * ログイン・2本目の登録の後の refresh token で結び付けること、bindApp: false では何も書かないこと。
 * 店員（admin・supporter）はパスキーの道（provisionStaff・loginWithPasskey・addApprovedPasskey。DD-AUTH-046）で作り、古い名前の aal2 は認めたパスキー2本、
 * aal1 は1本に読み替える（SR-AUTH-014）。一般の利用者（user）は今のパスワードの道。
 */
import { createHash, randomUUID } from 'node:crypto';

const mockCreateUser = jest.fn();
const mockProvisionStaff = jest.fn();
const mockLoginWithPasskey = jest.fn();
const mockAddApprovedPasskey = jest.fn();
jest.mock('../../../scripts/e2e/passkey-staff', () => ({
  provisionStaff: (...args: unknown[]) => mockProvisionStaff(...args),
  loginWithPasskey: (...args: unknown[]) => mockLoginWithPasskey(...args),
  addApprovedPasskey: (...args: unknown[]) => mockAddApprovedPasskey(...args),
}));
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: { admin: { createUser: mockCreateUser }, getUser: jest.fn() } })),
}));

import {
  bindAppSession,
  createAdminSessionActor,
  elevateAdminSessionToAal2,
  rebindRefreshToken,
} from '../../../e2e/admin-session-test-utils';
import { tokenHashSha256 } from '@/lib/hash';
import type { PgClient } from '../../integration/db/helpers/local-db';

const ORIGINAL_ENV = { ...process.env };

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature-not-checked`;
}

type Call = { sql: string; params: unknown[] };

class FakeDb {
  calls: Call[] = [];
  updateRowCount = 1;
  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim().toLowerCase(), params });
    if (/^update public\.sessions/.test(this.calls[this.calls.length - 1].sql)) return { rows: [], rowCount: this.updateRowCount };
    return { rows: [], rowCount: 1 };
  }
  async end(): Promise<void> {}
  asPg(): PgClient {
    return this as unknown as PgClient;
  }
  sessionInserts(): Call[] {
    return this.calls.filter((call) => call.sql.startsWith('insert into public.sessions'));
  }
  sessionUpdates(): Call[] {
    return this.calls.filter((call) => call.sql.startsWith('update public.sessions'));
  }
}

const USER_ID = randomUUID();
const SESSION_ID = randomUUID();

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'local-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-service-role-key';
  mockCreateUser.mockReset();
  mockProvisionStaff.mockReset();
  mockLoginWithPasskey.mockReset();
  mockAddApprovedPasskey.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

describe('DD-AUTH-039 bindAppSession', () => {
  const accessToken = fakeJwt({ sub: USER_ID, session_id: SESSION_ID, aal: 'aal1' });
  const refreshToken = 'refresh-token-secret-value';

  it('アプリが作る行と同じ形（refresh_token_hash は sha256・auth_session_id・7 日の期限・失効なし）で 1 行だけ足し、authSessionId を返す', async () => {
    const db = new FakeDb();
    const result = await bindAppSession(db.asPg(), { userId: USER_ID, accessToken, refreshToken });
    expect(result).toEqual({ authSessionId: SESSION_ID });
    const inserts = db.sessionInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toContain('auth_session_id');
    expect(inserts[0].sql).toContain('refresh_token_hash');
    expect(inserts[0].sql).toContain("interval '7 days'");
    expect(inserts[0].sql).not.toContain('revoked_at');
    expect(inserts[0].params).toContain(USER_ID);
    expect(inserts[0].params).toContain(SESSION_ID);
    expect(inserts[0].params).toContain(sha256Hex(refreshToken));
    // 生の token は DB にも渡さない
    expect(inserts[0].params).not.toContain(refreshToken);
    expect(inserts[0].params).not.toContain(accessToken);
  });

  it('refresh_token_hash はアプリの tokenHashSha256 と同じ値', async () => {
    const db = new FakeDb();
    await bindAppSession(db.asPg(), { userId: USER_ID, accessToken, refreshToken });
    expect(db.sessionInserts()[0].params).toContain(await tokenHashSha256(refreshToken));
  });

  it('token の sub が userId と合わなければ投げて、何も書かない', async () => {
    const db = new FakeDb();
    await expect(
      bindAppSession(db.asPg(), { userId: randomUUID(), accessToken, refreshToken }),
    ).rejects.toThrow();
    expect(db.calls).toHaveLength(0);
  });

  it('session_id の無い token・壊れた token は投げて、何も書かない', async () => {
    const db = new FakeDb();
    await expect(
      bindAppSession(db.asPg(), { userId: USER_ID, accessToken: fakeJwt({ sub: USER_ID }), refreshToken }),
    ).rejects.toThrow();
    await expect(
      bindAppSession(db.asPg(), { userId: USER_ID, accessToken: 'not-a-jwt', refreshToken }),
    ).rejects.toThrow();
    expect(db.calls).toHaveLength(0);
  });

  it('手元の Supabase でなければ投げて、何も書かない（既存の補助と同じ見張り）', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://prodproject.supabase.co';
    const db = new FakeDb();
    await expect(bindAppSession(db.asPg(), { userId: USER_ID, accessToken, refreshToken })).rejects.toThrow();
    expect(db.calls).toHaveLength(0);
  });

  it('失敗の文面に token・session_id を出さない', async () => {
    const db = new FakeDb();
    const failure = await bindAppSession(db.asPg(), { userId: randomUUID(), accessToken, refreshToken }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toContain(accessToken);
    expect(message).not.toContain(refreshToken);
    expect(message).not.toContain(SESSION_ID);
  });
});

describe('DD-AUTH-039 rebindRefreshToken', () => {
  it('結び付いた行の refresh_token_hash だけを新しい token の sha256 に替える', async () => {
    const db = new FakeDb();
    await rebindRefreshToken(db.asPg(), { authSessionId: SESSION_ID, refreshToken: 'next-refresh-token' });
    const updates = db.sessionUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('refresh_token_hash');
    expect(updates[0].sql).toContain('auth_session_id');
    expect(updates[0].sql).toContain('revoked_at is null');
    expect(updates[0].params).toContain(sha256Hex('next-refresh-token'));
    expect(updates[0].params).toContain(SESSION_ID);
  });

  it('替える行が 1 行でなければ投げる', async () => {
    const db = new FakeDb();
    db.updateRowCount = 0;
    await expect(rebindRefreshToken(db.asPg(), { authSessionId: SESSION_ID, refreshToken: 'x' })).rejects.toThrow();
  });
});

describe('DD-AUTH-039 createAdminSessionActor / elevateAdminSessionToAal2 の結び付け（店員はパスキーの道）', () => {
  const exp = () => Math.floor(Date.now() / 1000) + 3600;
  const passkeyAmr = () => [{ method: 'passkey', timestamp: Math.floor(Date.now() / 1000) }];

  /** provisionStaff・loginWithPasskey の偽。ok は JWT の staff_passkeys_ok、amr は passkey の amr */
  function stubStaff(options: { ok: boolean; amr?: unknown }): { authenticator: object } {
    const authenticator = { id: 'soft-1' };
    mockProvisionStaff.mockResolvedValue({ userId: USER_ID, email: 'staff@example.com', authenticators: [authenticator] });
    mockLoginWithPasskey.mockResolvedValue({
      session: {
        access_token: fakeJwt({
          sub: USER_ID,
          session_id: SESSION_ID,
          aal: 'aal1',
          amr: options.amr ?? passkeyAmr(),
          staff_passkeys_ok: options.ok,
          exp: exp(),
        }),
        refresh_token: 'refresh-from-passkey',
      },
    });
    return { authenticator };
  }

  it('店員の aal2 は認めたパスキー2本で用意し、パスキーでログインした refresh token で結び付ける', async () => {
    const { authenticator } = stubStaff({ ok: true });
    const db = new FakeDb();
    const actor = await createAdminSessionActor(db.asPg(), 'admin', 'aal2');
    expect(mockProvisionStaff).toHaveBeenCalledWith(db.asPg(), { role: 'admin', approvedPasskeys: 2 });
    expect(mockLoginWithPasskey).toHaveBeenCalledWith({ email: 'staff@example.com', authenticator });
    expect(actor).toMatchObject({ userId: USER_ID, role: 'admin', aal: 'aal2', appBound: true, sessionId: SESSION_ID });
    expect(actor.authenticators).toEqual([authenticator]);
    const inserts = db.sessionInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toContain(sha256Hex('refresh-from-passkey'));
    expect(inserts[0].params).toContain(SESSION_ID);
  });

  it('店員の aal1 は認めたパスキー1本（JWT の印は偽）', async () => {
    stubStaff({ ok: false });
    const db = new FakeDb();
    const actor = await createAdminSessionActor(db.asPg(), 'supporter', 'aal1');
    expect(mockProvisionStaff).toHaveBeenCalledWith(db.asPg(), { role: 'supporter', approvedPasskeys: 1 });
    expect(actor.aal).toBe('aal1');
  });

  it.each([
    ['JWT の amr に passkey が無い', { ok: true, amr: [{ method: 'otp', timestamp: 1 }] }],
    ['JWT の amr の passkey に時刻が無い', { ok: true, amr: [{ method: 'passkey' }] }],
  ])('結び付けの行は JWT を確かめた後に書く（%s なら行を残さない）', async (_label, options) => {
    stubStaff(options);
    const db = new FakeDb();
    await expect(createAdminSessionActor(db.asPg(), 'admin', 'aal2')).rejects.toThrow();
    expect(db.sessionInserts()).toHaveLength(0);
  });

  it('JWT の staff_passkeys_ok が頼んだ aal と合わなければ投げて、行を残さない', async () => {
    stubStaff({ ok: false });
    const db = new FakeDb();
    await expect(createAdminSessionActor(db.asPg(), 'admin', 'aal2')).rejects.toThrow();
    expect(db.sessionInserts()).toHaveLength(0);
  });

  it('bindApp: false では行を作らない', async () => {
    stubStaff({ ok: true });
    const db = new FakeDb();
    const actor = await createAdminSessionActor(db.asPg(), 'admin', 'aal2', { bindApp: false });
    expect(actor.appBound).toBe(false);
    expect(db.sessionInserts()).toHaveLength(0);
    expect(db.sessionUpdates()).toHaveLength(0);
  });

  describe('一般の利用者（user）は今のパスワードの道', () => {
    function stubPasswordAuth(userId: string): void {
      mockCreateUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
        const grant = String(input).includes('grant_type=refresh_token');
        const reply = grant
          ? { access_token: fakeJwt({ sub: userId, session_id: SESSION_ID, aal: 'aal2', exp: exp() }), refresh_token: 'refresh-after-aal2' }
          : { access_token: fakeJwt({ sub: userId, session_id: SESSION_ID, aal: 'aal1', exp: exp() }), refresh_token: 'refresh-from-password' };
        return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
      });
    }

    it('aal1 は passkey の道を通らず、パスワードのログインの refresh token で結び付ける', async () => {
      stubPasswordAuth(USER_ID);
      const db = new FakeDb();
      const actor = await createAdminSessionActor(db.asPg(), 'user', 'aal1');
      expect(mockProvisionStaff).not.toHaveBeenCalled();
      expect(actor).toMatchObject({ role: 'user', aal: 'aal1', appBound: true, authenticators: [] });
      expect(db.sessionInserts()[0].params).toContain(sha256Hex('refresh-from-password'));
    });

    it('aal2 は session に totp の印を足して refresh した token で結び付ける', async () => {
      stubPasswordAuth(USER_ID);
      const db = new FakeDb();
      await createAdminSessionActor(db.asPg(), 'user', 'aal2');
      expect(db.sessionInserts()[0].params).toContain(sha256Hex('refresh-after-aal2'));
    });

    it('頼んだ aal と JWT の aal が合わなければ投げて、行を残さない', async () => {
      stubPasswordAuth(USER_ID);
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(JSON.stringify({ access_token: fakeJwt({ sub: USER_ID, session_id: SESSION_ID, aal: 'aal2', exp: exp() }), refresh_token: 'r' }), { status: 200 }),
      );
      const db = new FakeDb();
      await expect(createAdminSessionActor(db.asPg(), 'user', 'aal1')).rejects.toThrow();
      expect(db.sessionInserts()).toHaveLength(0);
    });

    it('bindApp: false では行を作らない', async () => {
      stubPasswordAuth(USER_ID);
      const db = new FakeDb();
      const actor = await createAdminSessionActor(db.asPg(), 'user', 'aal1', { bindApp: false });
      expect(actor.appBound).toBe(false);
      expect(db.sessionInserts()).toHaveLength(0);
    });
  });

  describe('elevateAdminSessionToAal2（同じ session で2本目を登録して認める）', () => {
    function stubElevation(): void {
      mockAddApprovedPasskey.mockResolvedValue({
        authenticator: { id: 'soft-2' },
        session: {
          access_token: fakeJwt({ sub: USER_ID, session_id: SESSION_ID, aal: 'aal1', amr: passkeyAmr(), staff_passkeys_ok: true, exp: exp() }),
          refresh_token: 'refresh-after-second-key',
        },
      });
    }

    it('同じ session の token で2本目を足し、結び付いた行の refresh_token_hash を新しい token に合わせる', async () => {
      stubStaff({ ok: false });
      stubElevation();
      const db = new FakeDb();
      const aal1 = await createAdminSessionActor(db.asPg(), 'admin', 'aal1');
      const aal2 = await elevateAdminSessionToAal2(db.asPg(), aal1);
      expect(mockAddApprovedPasskey).toHaveBeenCalledWith(db.asPg(), {
        userId: USER_ID,
        accessToken: aal1.accessToken,
        refreshToken: aal1.refreshToken,
      });
      expect(aal2).toMatchObject({ aal: 'aal2', sessionId: SESSION_ID, appBound: true });
      expect(aal2.authenticators).toHaveLength(2);
      const updates = db.sessionUpdates();
      expect(updates).toHaveLength(1);
      expect(updates[0].params).toContain(sha256Hex('refresh-after-second-key'));
      expect(updates[0].params).toContain(SESSION_ID);
    });

    it('結び付けていない利用者の行を作らず・替えない', async () => {
      stubStaff({ ok: false });
      stubElevation();
      const db = new FakeDb();
      const aal1 = await createAdminSessionActor(db.asPg(), 'admin', 'aal1', { bindApp: false });
      await elevateAdminSessionToAal2(db.asPg(), aal1);
      expect(db.sessionInserts()).toHaveLength(0);
      expect(db.sessionUpdates()).toHaveLength(0);
    });

    it('aal1 でない利用者・一般の利用者は上げられない', async () => {
      stubStaff({ ok: true });
      const db = new FakeDb();
      const aal2 = await createAdminSessionActor(db.asPg(), 'admin', 'aal2');
      await expect(elevateAdminSessionToAal2(db.asPg(), aal2)).rejects.toThrow();
      expect(mockAddApprovedPasskey).not.toHaveBeenCalled();
      await expect(elevateAdminSessionToAal2(db.asPg(), { ...aal2, aal: 'aal1', role: 'user' })).rejects.toThrow();
      expect(mockAddApprovedPasskey).not.toHaveBeenCalled();
    });

    it('2本目の後の JWT の staff_passkeys_ok が真でなければ投げて、行を替えない', async () => {
      stubStaff({ ok: false });
      mockAddApprovedPasskey.mockResolvedValue({
        authenticator: { id: 'soft-2' },
        session: {
          access_token: fakeJwt({ sub: USER_ID, session_id: SESSION_ID, aal: 'aal1', amr: passkeyAmr(), staff_passkeys_ok: false, exp: exp() }),
          refresh_token: 'refresh-after-second-key',
        },
      });
      const db = new FakeDb();
      const aal1 = await createAdminSessionActor(db.asPg(), 'admin', 'aal1');
      await expect(elevateAdminSessionToAal2(db.asPg(), aal1)).rejects.toThrow();
      expect(db.sessionUpdates()).toHaveLength(0);
    });
  });
});
