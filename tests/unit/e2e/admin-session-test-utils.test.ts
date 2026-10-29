/** @jest-environment node */
/**
 * DD-AUTH-039 E2E の道具 admin-session-test-utils が、アプリが作る sessions の行と同じ形の「結び付いた」行を作るかを、偽の DB と偽の Auth で確かめる。
 * bindAppSession の入力の検査・手元以外の拒否・失敗の文面に token を出さないこと、createAdminSessionActor / elevateAdminSessionToAal2 が
 * 昇格の後の refresh token で結び付けること、bindApp: false では何も書かないこと。
 */
import { createHash, randomUUID } from 'node:crypto';

const mockCreateUser = jest.fn();
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

describe('DD-AUTH-039 createAdminSessionActor / elevateAdminSessionToAal2 の結び付け', () => {
  /** password → aal1 の token、refresh_token → aal2 の token を返す偽の Auth */
  function stubAuth(userId: string): void {
    mockCreateUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      const grant = url.includes('grant_type=refresh_token');
      const reply = grant
        ? { access_token: fakeJwt({ sub: userId, session_id: SESSION_ID, aal: 'aal2', exp }), refresh_token: 'refresh-after-aal2' }
        : { access_token: fakeJwt({ sub: userId, session_id: SESSION_ID, aal: 'aal1', exp }), refresh_token: 'refresh-from-password' };
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  }

  it('既定で結び付ける。aal2 は昇格の後の refresh token で行を作る', async () => {
    stubAuth(USER_ID);
    const db = new FakeDb();
    const actor = await createAdminSessionActor(db.asPg(), 'admin', 'aal2');
    expect(actor.appBound).toBe(true);
    const inserts = db.sessionInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toContain(sha256Hex('refresh-after-aal2'));
    expect(inserts[0].params).not.toContain(sha256Hex('refresh-from-password'));
    expect(inserts[0].params).toContain(SESSION_ID);
  });

  it('結び付けの行は aal を確かめた後に書く（aal が合わなければ行を残さない）', async () => {
    stubAuth(USER_ID);
    const db = new FakeDb();
    // aal1 を頼んだのに aal2 の token が返る状況を作る: password の応答も aal2 にする
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          access_token: fakeJwt({ sub: USER_ID, session_id: SESSION_ID, aal: 'aal2', exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: 'r',
        }),
        { status: 200 },
      ),
    );
    await expect(createAdminSessionActor(db.asPg(), 'admin', 'aal1')).rejects.toThrow();
    expect(db.sessionInserts()).toHaveLength(0);
  });

  it('bindApp: false では行を作らない', async () => {
    stubAuth(USER_ID);
    const db = new FakeDb();
    const actor = await createAdminSessionActor(db.asPg(), 'user', 'aal1', { bindApp: false });
    expect(actor.appBound).toBe(false);
    expect(db.sessionInserts()).toHaveLength(0);
    expect(db.sessionUpdates()).toHaveLength(0);
  });

  it('elevate は結び付いた利用者の行の refresh_token_hash を昇格後の token に合わせる', async () => {
    stubAuth(USER_ID);
    const db = new FakeDb();
    const aal1 = await createAdminSessionActor(db.asPg(), 'admin', 'aal1');
    expect(aal1.appBound).toBe(true);
    const aal2 = await elevateAdminSessionToAal2(db.asPg(), aal1);
    expect(aal2.appBound).toBe(true);
    const updates = db.sessionUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toContain(sha256Hex('refresh-after-aal2'));
    expect(updates[0].params).toContain(SESSION_ID);
  });

  it('elevate は結び付けていない利用者の行を作らず・替えない', async () => {
    stubAuth(USER_ID);
    const db = new FakeDb();
    const aal1 = await createAdminSessionActor(db.asPg(), 'admin', 'aal1', { bindApp: false });
    await elevateAdminSessionToAal2(db.asPg(), aal1);
    expect(db.sessionInserts()).toHaveLength(0);
    expect(db.sessionUpdates()).toHaveLength(0);
  });
});
