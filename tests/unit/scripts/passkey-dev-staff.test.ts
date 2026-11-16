/** @jest-environment node */
/**
 * SR-AUTH-015 / FR-AUTH-014 / DD-AUTH-049 手元の開発で店員としてパスキーで入る専用のブラウザのスクリプトを確かめる。
 * Supabase・DB・ブラウザは入れ替えた偽物で、本物には触れない。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { main, type DevStaffDeps } from '../../../scripts/dev/passkey-dev-staff';

const FAKE_JWT_BODY = Buffer.from(JSON.stringify({ sub: 'user-1', session_id: 'auth-session-1' })).toString('base64url');
const ACCESS_TOKEN = `aaa.${FAKE_JWT_BODY}.sig-access-secret`;
const REFRESH_TOKEN = 'refresh-token-secret-value';

type Query = { text: string; params: unknown[] };

function setup(over: { url?: string; databaseUrl?: string } = {}) {
  const lines: string[] = [];
  const queries: Query[] = [];
  const opened: Array<{ profileDir: string; cookies: Array<{ name: string; value: string; httpOnly: boolean; sameSite: string }> }> = [];
  const db = {
    query: jest.fn(async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      return { rows: [], rowCount: 1 };
    }),
    end: jest.fn(async () => {}),
  };
  const deps = {
    readEnv: jest.fn(() => ({
      url: over.url ?? 'http://127.0.0.1:54321',
      anonKey: 'anon',
      serviceRoleKey: 'service',
      databaseUrl: over.databaseUrl ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    })),
    connectDb: jest.fn(async () => db),
    provisionStaff: jest.fn(async (_db: unknown, input: { email?: string }) => ({
      userId: 'user-1',
      email: input.email as string,
      authenticators: [{}, {}],
    })),
    loginWithPasskey: jest.fn(async () => ({ session: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN } })),
    openBrowser: jest.fn(async (input: { profileDir: string; cookies: any[] }) => {
      opened.push(input);
    }),
    print: (line: string) => lines.push(line),
  };
  return { deps: deps as unknown as DevStaffDeps, mocks: deps, db, lines, queries, opened };
}

describe('SR-AUTH-015 passkey-dev-staff', () => {
  test('DD-AUTH-049 本番の住所では、DB にも GoTrue にも触れずに投げる', async () => {
    const t = setup({ url: 'https://x.supabase.co' });
    await expect(main(['--open'], t.deps)).rejects.toThrow();
    expect(t.mocks.connectDb).not.toHaveBeenCalled();
    expect(t.mocks.provisionStaff).not.toHaveBeenCalled();
    expect(t.mocks.loginWithPasskey).not.toHaveBeenCalled();
    expect(t.mocks.openBrowser).not.toHaveBeenCalled();
  });

  test('DD-AUTH-049 DB の住所が手元でなければ、何も書かずに投げる', async () => {
    const t = setup({ databaseUrl: 'postgresql://u:p@db.example.com:5432/postgres' });
    await expect(main([], t.deps)).rejects.toThrow();
    expect(t.mocks.connectDb).not.toHaveBeenCalled();
    expect(t.mocks.provisionStaff).not.toHaveBeenCalled();
  });

  test('DD-AUTH-049 役割 owner は何もせずに投げる', async () => {
    const t = setup();
    await expect(main(['--role', 'owner'], t.deps)).rejects.toThrow();
    expect(t.mocks.readEnv).not.toHaveBeenCalled();
    expect(t.mocks.connectDb).not.toHaveBeenCalled();
    expect(t.mocks.provisionStaff).not.toHaveBeenCalled();
  });

  test('DD-AUTH-049 既定は admin・認めたパスキー2本・乱数のメールで、サポーターも選べる', async () => {
    const a = setup();
    await main([], a.deps);
    const input = a.mocks.provisionStaff.mock.calls[0][1] as { role: string; approvedPasskeys: number; email: string };
    expect(input.role).toBe('admin');
    expect(input.approvedPasskeys).toBe(2);
    expect(input.email).toMatch(/^dev-staff-[0-9a-f]+@example\.com$/);

    const b = setup();
    await main(['--role', 'supporter', '--email', 'me@example.com'], b.deps);
    const input2 = b.mocks.provisionStaff.mock.calls[0][1] as { role: string; email: string };
    expect(input2).toMatchObject({ role: 'supporter', email: 'me@example.com' });
  });

  test('DD-AUTH-049 パスキーのログインの session 以外の auth.sessions を消し、public.sessions の csrf_token_hash は Cookie の値の SHA-256 と一致する', async () => {
    const t = setup();
    const result = await main(['--open'], t.deps);

    const del = t.queries.find((q) => /delete from auth\.sessions/i.test(q.text));
    expect(del?.params).toEqual(['user-1', 'auth-session-1']);

    const ins = t.queries.find((q) => /insert into public\.sessions/i.test(q.text));
    expect(ins).toBeDefined();
    const [userId, refreshHash, csrfHash, authSessionId] = ins!.params as string[];
    expect(userId).toBe('user-1');
    expect(authSessionId).toBe('auth-session-1');
    expect(refreshHash).toBe(createHash('sha256').update(REFRESH_TOKEN).digest('hex'));

    expect(t.opened).toHaveLength(1);
    const cookies = t.opened[0].cookies;
    const csrf = cookies.find((c) => c.name === 'sb-csrf-token');
    expect(csrf).toBeDefined();
    expect(csrf!.httpOnly).toBe(false);
    expect(csrfHash).toBe(createHash('sha256').update(csrf!.value).digest('hex'));
    expect(cookies.find((c) => c.name === 'sb-access-token')).toMatchObject({ value: ACCESS_TOKEN, httpOnly: true });
    expect(cookies.find((c) => c.name === 'sb-refresh-token')).toMatchObject({ value: REFRESH_TOKEN, httpOnly: true });
    expect(result.profileDir).toBe(path.resolve('.tmp-dev-staff', 'profile'));
    expect(t.opened[0].profileDir).toBe(result.profileDir);
    expect(t.db.end).toHaveBeenCalled();
  });

  test('DD-AUTH-049 --open が無ければブラウザを開かない', async () => {
    const t = setup();
    await main([], t.deps);
    expect(t.mocks.openBrowser).not.toHaveBeenCalled();
  });

  test('DD-AUTH-049 標準出力に JWT・Cookie・token・CSRF の値を出さない', async () => {
    const t = setup();
    await main(['--open'], t.deps);
    const out = t.lines.join('\n');
    const csrf = t.opened[0].cookies.find((c) => c.name === 'sb-csrf-token')!.value;
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, csrf, 'sig-access-secret', FAKE_JWT_BODY]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('24時間');
  });

  test('DD-AUTH-049 .gitignore に /.tmp-dev-staff/ がある', () => {
    const ignore = readFileSync(path.resolve(__dirname, '../../../.gitignore'), 'utf8').split(/\r?\n/);
    expect(ignore).toContain('/.tmp-dev-staff/');
  });

  test('DD-AUTH-049 失敗しても DB の接続を閉じる', async () => {
    const t = setup();
    t.mocks.loginWithPasskey.mockRejectedValueOnce(new Error('パスキーログインの始めに失敗した'));
    await expect(main([], t.deps)).rejects.toThrow('パスキーログインの始め');
    expect(t.db.end).toHaveBeenCalled();
  });

  test('DD-AUTH-049 session_id が読めない JWT・結び付ける行を作れない時は投げ、DB の接続を閉じる', async () => {
    const a = setup();
    a.mocks.loginWithPasskey.mockResolvedValueOnce({ session: { access_token: 'broken', refresh_token: REFRESH_TOKEN } } as never);
    await expect(main([], a.deps)).rejects.toThrow('session_id');
    expect(a.db.end).toHaveBeenCalled();
    expect(a.queries.some((q) => /insert into public\.sessions/i.test(q.text))).toBe(false);

    const b = setup();
    b.db.query.mockImplementation(async (text: string) => ({ rows: [], rowCount: /insert into public\.sessions/i.test(text) ? 0 : 1 }));
    await expect(main([], b.deps)).rejects.toThrow('sessions の行');
    expect(b.mocks.openBrowser).not.toHaveBeenCalled();
    expect(b.db.end).toHaveBeenCalled();
  });
});
