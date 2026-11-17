/**
 * FR-LOGIN-051 パスキーの登録の始め・終わり（POST /api/auth/passkey/register/start・finish）
 * 対応: FR-AUTH-020-AC-01〜09
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase（GoTrue）・手元の DB だけで流す HTTP の試験。画面は開かない（幅で結果は変わらないが、3つの幅でくり返す）。
 * ソフトの認証器で本物の GoTrue に当てる。道具は e2e/passkey-app-api.ts・e2e/admin-session-test-utils.ts・scripts/e2e/passkey-staff.ts。
 * 要求ごとに別の x-real-ip と origin を付ける（回数の枠を使い切らないため・proxy の Origin の確かめ）。
 * 窓の店員は Bearer の通行証で呼ぶ（Cookie が無いので CSRF の確かめは掛からない）。入り直しの店員は Cookie と x-csrf-token で呼ぶ。
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { assertLocalDbClient, isLocalUrl } from '../scripts/e2e/environment';
import { provisionPasskeyUser, provisionStaff } from '../scripts/e2e/passkey-staff';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { bindAppSession, createWindowSessionActor } from './admin-session-test-utils';
import { signInWithEmailCode } from './passkey-hook-scenarios';
import { finishRegisterViaApp, loginViaApp, startRegisterViaApp } from './passkey-app-api';
import { createSoftAuthenticator, type SoftAuthenticator } from './passkey-soft-authenticator';

test.use({ trace: 'off' });

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const RELYING_PARTY = { origin: 'http://localhost:3000', rpId: 'localhost' } as const;

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 253);
  return `10.${octet()}.${octet()}.${octet()}`;
}

async function withDb<T>(run: (db: PgClient) => Promise<T>): Promise<T> {
  if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB だけで流す');
  const client = new Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    const db = client as unknown as PgClient;
    assertLocalDbClient(db);
    return await run(db);
  } finally {
    await client.end();
  }
}

async function countOf(db: PgClient, sql: string, userId: string): Promise<number> {
  const rows = await db.query(sql, [userId]);
  return (rows.rows[0] as { n: number }).n;
}
const goTrueKeys = (db: PgClient, userId: string) =>
  countOf(db, 'select count(*)::int as n from auth.webauthn_credentials where user_id = $1::uuid', userId);
const approvedKeys = (db: PgClient, userId: string) =>
  countOf(db, 'select count(*)::int as n from private.approved_passkeys where user_id = $1::uuid', userId);

type RegisterOutcome = { start: { status: number; body: unknown }; finish?: { status: number; body: unknown } };

/** 始め → 認証器の register → 終わり。始めが 200 でなければ終わりは呼ばない。 */
async function registerKey(
  request: APIRequestContext,
  auth: { authorization?: string; csrfToken?: string },
  authenticator: SoftAuthenticator = createSoftAuthenticator(RELYING_PARTY),
  opts?: { userVerified?: boolean },
): Promise<RegisterOutcome> {
  const start = await startRegisterViaApp(request, { ip: uniqueIp(), ...auth });
  if (start.status !== 200) return { start };
  const body = start.body as { challenge_id: string; options: Parameters<SoftAuthenticator['register']>[0] };
  const credential = authenticator.register(body.options, opts);
  const finish = await finishRegisterViaApp(request, {
    ip: uniqueIp(),
    challengeId: body.challenge_id,
    credential: credential as unknown as Record<string, unknown>,
    ...auth,
  });
  return { start, finish };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-020-AC-01 窓の中の店員は登録でき（認めた鍵が1本→2本）、3本目は窓が開いていても始めで403 (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const actor = await createWindowSessionActor(db, { role: 'admin' });
        const auth = bearer(actor.accessToken);

        const first = await registerKey(request, auth);
        expect(first.start.status).toBe(200);
        expect((first.start.body as { mode: string; options: { authenticatorSelection: { userVerification: string } } }).mode).toBe('window');
        expect((first.start.body as { options: { authenticatorSelection: { userVerification: string } } }).options.authenticatorSelection.userVerification).toBe('required');
        expect(first.finish?.status).toBe(200);
        expect(first.finish?.body).toMatchObject({ approvedCount: 1, passkey: { id: expect.any(String) } });

        const second = await registerKey(request, auth);
        expect(second.finish?.status).toBe(200);
        expect(second.finish?.body).toMatchObject({ approvedCount: 2 });

        const third = await registerKey(request, auth);
        expect(third.start.status).toBe(403);
        expect(third.start.body).toEqual({ error: 'registration_not_allowed', reason: 'reauth_required' });
        expect(await goTrueKeys(db, actor.userId)).toBe(2);
        expect(await approvedKeys(db, actor.userId)).toBe(2);
      });
    });

    test(`FR-AUTH-020-AC-02 始めの後に窓を閉じると終わりは403で鍵ができず、別の人・別のセッションの窓では始めが403 (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const actor = await createWindowSessionActor(db, { role: 'admin', withOtherSession: true });
        const auth = bearer(actor.accessToken);

        const start = await startRegisterViaApp(request, { ip: uniqueIp(), ...auth });
        expect(start.status).toBe(200);
        const body = start.body as { challenge_id: string; options: Parameters<SoftAuthenticator['register']>[0] };
        await db.query('select public.passkey_window_close($1::uuid)', [actor.sessionId]);
        const finish = await finishRegisterViaApp(request, {
          ip: uniqueIp(),
          challengeId: body.challenge_id,
          credential: createSoftAuthenticator(RELYING_PARTY).register(body.options) as unknown as Record<string, unknown>,
          ...auth,
        });
        expect(finish.status).toBe(403);
        expect(finish.body).toEqual({ error: 'registration_not_allowed', reason: 'window_closed' });
        expect(await goTrueKeys(db, actor.userId)).toBe(0);
        expect(await approvedKeys(db, actor.userId)).toBe(0);

        // 別の人の窓: 窓を持つ別の店員がいても、窓を持たない（閉じた）この店員の要求は通らない。
        const other = await createWindowSessionActor(db, { role: 'supporter' });
        const otherStart = await startRegisterViaApp(request, { ip: uniqueIp(), ...bearer(other.accessToken) });
        expect(otherStart.status).toBe(200);
        const crossed = await startRegisterViaApp(request, { ip: uniqueIp(), ...auth });
        expect(crossed.status).toBe(403);

        // 別のセッション: 同じ人でも、窓を開けたセッションと別の session の通行証は通らない。
        const sibling = await createWindowSessionActor(db, { role: 'admin', withOtherSession: true });
        const siblingOther = await startRegisterViaApp(request, { ip: uniqueIp(), ...bearer(sibling.otherSession!.accessToken) });
        expect(siblingOther.status).toBe(403);
        expect(siblingOther.body).toEqual({ error: 'registration_not_allowed', reason: 'window_closed' });
        const siblingOwn = await startRegisterViaApp(request, { ip: uniqueIp(), ...bearer(sibling.accessToken) });
        expect(siblingOwn.status).toBe(200);
      });
    });

    test(`FR-AUTH-020-AC-03 窓を閉じた後は、始めが403 window_closed で鍵ができない (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const actor = await createWindowSessionActor(db, { role: 'supporter' });
        await db.query('select public.passkey_window_close($1::uuid)', [actor.sessionId]);
        const result = await registerKey(request, bearer(actor.accessToken));
        expect(result.start.status).toBe(403);
        expect(result.start.body).toEqual({ error: 'registration_not_allowed', reason: 'window_closed' });
        expect(await goTrueKeys(db, actor.userId)).toBe(0);
      });
    });

    test(`FR-AUTH-020-AC-04 認めた鍵2本の店員は、パスキーで入り直した直後は窓が無くても3本目を足せる（reauth）(${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const staff = await provisionStaff(db, { role: 'admin', approvedPasskeys: 2 });
        const login = await loginViaApp(request, { authenticator: staff.authenticators[0], ip: uniqueIp() });
        expect(login.status).toBe(200);
        const csrfToken = login.cookies.find((cookie) => cookie.name === 'sb-csrf-token')?.value;
        expect(csrfToken).toBeTruthy();

        const added = await registerKey(request, { csrfToken });
        expect((added.start.body as { mode: string }).mode).toBe('reauth');
        expect(added.finish?.status).toBe(200);
        expect(added.finish?.body).toMatchObject({ approvedCount: 3 });
        expect(await approvedKeys(db, staff.userId)).toBe(3);
        expect(await goTrueKeys(db, staff.userId)).toBe(3);
      });
    });

    test(`FR-AUTH-020-AC-05 お客さんはメールのコードで入った直後に登録でき、認めの表に行が増えない (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const customer = await provisionPasskeyUser(db, { approvedPasskeys: 0 });
        const signedIn = await signInWithEmailCode(customer.email);
        if (!signedIn.accessToken || !signedIn.refreshToken) throw new Error(`メールのコードのログインに失敗した（status: ${signedIn.status}）`);
        await bindAppSession(db, { userId: customer.userId, accessToken: signedIn.accessToken, refreshToken: signedIn.refreshToken });

        const added = await registerKey(request, bearer(signedIn.accessToken));
        expect((added.start.body as { mode: string }).mode).toBe('customer');
        expect(added.finish?.status).toBe(200);
        expect(added.finish?.body).not.toHaveProperty('approvedCount');
        expect(await goTrueKeys(db, customer.userId)).toBe(1);
        expect(await approvedKeys(db, customer.userId)).toBe(0);
      });
    });

    test(`FR-AUTH-020-AC-06 通行証が無ければ 401、Cookie だけで CSRF の見出しが無ければ 403 で、鍵ができない (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const anonymous = await startRegisterViaApp(request, { ip: uniqueIp() });
        expect(anonymous.status).toBe(401);

        const staff = await provisionStaff(db, { role: 'supporter', approvedPasskeys: 2 });
        const login = await loginViaApp(request, { authenticator: staff.authenticators[0], ip: uniqueIp() });
        expect(login.status).toBe(200);
        const noCsrf = await registerKey(request, {});
        expect(noCsrf.start.status).toBe(403);
        expect(await goTrueKeys(db, staff.userId)).toBe(2);
      });
    });

    test(`FR-AUTH-020-AC-07 id と rawId が違う終わりは400で、鍵ができない (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const actor = await createWindowSessionActor(db, { role: 'admin' });
        const auth = bearer(actor.accessToken);
        const start = await startRegisterViaApp(request, { ip: uniqueIp(), ...auth });
        expect(start.status).toBe(200);
        const body = start.body as { challenge_id: string; options: Parameters<SoftAuthenticator['register']>[0] };
        const other = createSoftAuthenticator(RELYING_PARTY);
        const own = createSoftAuthenticator(RELYING_PARTY).register(body.options);
        const forged = { ...own, rawId: other.register(body.options).rawId };
        const finish = await finishRegisterViaApp(request, {
          ip: uniqueIp(),
          challengeId: body.challenge_id,
          credential: forged as unknown as Record<string, unknown>,
          ...auth,
        });
        expect(finish.status).toBe(400);
        expect(await goTrueKeys(db, actor.userId)).toBe(0);
        expect(await approvedKeys(db, actor.userId)).toBe(0);
      });
    });

    test(`FR-AUTH-020-AC-08 UV の無い認証器の登録は400 uv_required で、鍵ができない (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const actor = await createWindowSessionActor(db, { role: 'admin' });
        const result = await registerKey(request, bearer(actor.accessToken), createSoftAuthenticator(RELYING_PARTY), { userVerified: false });
        expect(result.start.status).toBe(200);
        expect(result.finish?.status).toBe(400);
        expect(result.finish?.body).toEqual({ error: 'uv_required' });
        expect(await goTrueKeys(db, actor.userId)).toBe(0);
        expect(await approvedKeys(db, actor.userId)).toBe(0);
      });
    });

    test(`FR-AUTH-020-AC-09 店員が窓口で登録した鍵は認めた鍵に数えられ、GoTrue に直に足した鍵は数えられない (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const actor = await createWindowSessionActor(db, { role: 'admin' });
        const viaApp = await registerKey(request, bearer(actor.accessToken));
        expect(viaApp.finish?.status).toBe(200);
        expect(await approvedKeys(db, actor.userId)).toBe(1);

        // 直に足す（窓口を通さない）。通行証は本人のもの。
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        if (!url || !anonKey || !isLocalUrl(url)) throw new Error('手元の Supabase の環境が無い');
        const [a, b, c] = [1 + Math.floor(Math.random() * 253), 1 + Math.floor(Math.random() * 253), 1 + Math.floor(Math.random() * 253)];
        const direct = createClient(url, anonKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: { 'x-forwarded-for': `10.${a}.${b}.${c}` } },
        });
        const set = await direct.auth.setSession({ access_token: actor.accessToken, refresh_token: actor.refreshToken });
        expect(set.error).toBeNull();
        const authenticator = createSoftAuthenticator(RELYING_PARTY);
        const started = await direct.auth.passkey.startRegistration();
        expect(started.error).toBeNull();
        const verified = await direct.auth.passkey.verifyRegistration({
          challengeId: started.data!.challenge_id,
          credential: authenticator.register(started.data!.options),
        });
        expect(verified.error).toBeNull();
        expect(await goTrueKeys(db, actor.userId)).toBe(2);
        expect(await approvedKeys(db, actor.userId)).toBe(1);
        const count = await db.query('select public.passkey_approved_count($1::uuid) as n', [actor.userId]);
        expect((count.rows[0] as { n: number }).n).toBe(1);
      });
    });
  });
}
