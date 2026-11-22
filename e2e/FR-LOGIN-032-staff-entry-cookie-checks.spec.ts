/**
 * FR-LOGIN-032 管理者・サポーターの入口の条件と Cookie だけの認証の守り（管理画面の門・iss と aud・ログアウトの失効）
 * 対応: FR-LOGIN-007-AC-02 / FREQ-316-REQ-01-AC-01 / FREQ-316-REQ-03-AC-01
 *
 * 前提（手元の Supabase だけで流す。本番の鍵は env に無い）:
 * - 管理者・サポーターは createAdminSessionActor（認めたパスキーの店員）と placeAdminCookies で作る。
 * - 認証アプリ（TOTP）の窓口と、その試験（SEC-AUTH-009・030-AC-01・031-AC-01・FREQ-316-REQ-02-AC-01・SEC-AUTH-010-AC-02）は
 *   パスキー段4で窓口ごと消した（ADR-0475）。窓口が無いことは FR-LOGIN-080 が確かめる。
 * JWT・Cookie が通信記録に残らないよう trace は切る。
 */
import { createHmac, randomBytes } from 'node:crypto';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createAdminSessionActor, placeAdminCookies } from './admin-session-test-utils';
import { withLocalDb } from './order-email-test-utils';
import { viewports } from './order-fulfillment-test-utils';

test.use({ trace: 'off' });
test.describe.configure({ timeout: 180_000 });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const JWT_SECRET = process.env.JWT_SECRET ?? '';

const LOGOUT_ROUTE = '/api/auth/logout';

type PrivilegedRole = 'admin' | 'supporter';

/** 管理の窓口として要求が通ったかを見る窓口。admin.permissions.manage は管理者に、admin.users.read はサポーターに付く */
const PROBE_ROUTE: Record<PrivilegedRole, string> = {
  admin: '/api/admin/permissions',
  supporter: '/api/admin/users',
};

function requireLocalEnv(): void {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
}

function originOf(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  return new URL(baseURL).origin;
}

/** 回数の制限を試験ごとに別の送り元で数えるための値（手元の E2E サーバーだけで効く） */
function uniqueSourceIp(): string {
  const bytes = randomBytes(2);
  return `198.18.${bytes[0]}.${(bytes[1] % 253) + 1}`;
}

type Claims = { sub?: string; session_id?: string; aal?: string; iss?: string; aud?: string | string[] };

function claimsOf(jwt: string): Claims {
  return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Claims;
}

/** Authorization の見出しを付けず、ブラウザの Cookie だけで管理の窓口を呼ぶ */
function probeWithCookie(page: Page, role: PrivilegedRole): Promise<APIResponse> {
  return page.request.get(new URL(PROBE_ROUTE[role], new URL(page.url()).origin).toString(), {
    failOnStatusCode: false,
    maxRedirects: 0,
  });
}

// ---- JWT の作り直し（iss・aud の確かめ用。手元の JWT_SECRET の HS256） ----

const base64Json = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** 本物の JWT のクレームを写し、mutate で一部を変えて、手元の JWT_SECRET（HS256）で署名し直す。署名は常に正しい */
function resignedToken(realToken: string, mutate: (claims: Record<string, unknown>) => void): string {
  const claims = JSON.parse(Buffer.from(realToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  mutate(claims);
  const head = base64Json({ alg: 'HS256', typ: 'JWT' });
  const body = base64Json(claims);
  const signature = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

// ======================================================================================

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-032 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-LOGIN-007-AC-02 管理者とサポーターは入口の条件（認めたパスキー2本）を満たすまで管理画面へ進めない (${viewport.name})`, async ({ page }) => {
      // 古い版は TOTP を通るまでの門を見ていた。今の門（SR-AUTH-014: パスキーのログイン＋認めたパスキー2本）が同じ守りを担うので、
      // 認めたパスキー1本の店員（古い名前の aal1）が画面でも窓口でも断られ、2本の店員（aal2）は通る、で確かめる。
      requireLocalEnv();
      for (const role of ['admin', 'supporter'] as const) {
        const oneKey = await withLocalDb((db) => createAdminSessionActor(db, role, 'aal1'));
        await placeAdminCookies(page, oneKey, uniqueSourceIp());

        // 入口の条件を満たさないので、管理画面は「2要素認証が必要です」で止まり、管理の窓口も 403（MFA required）
        await page.goto('/admin');
        await expect(page.getByRole('heading', { name: '2要素認証が必要です' }), `${role}（1本）の管理画面`).toBeVisible({ timeout: 15_000 });
        const probe = await probeWithCookie(page, role);
        expect(probe.status(), `${role}（1本）では管理の窓口が 403`).toBe(403);
        expect(((await probe.json()) as { reason?: string }).reason).toBe('MFA required');

        // 対照: 認めたパスキー2本の店員は同じ窓口が通る
        const twoKeys = await withLocalDb((db) => createAdminSessionActor(db, role, 'aal2'));
        await placeAdminCookies(page, twoKeys, uniqueSourceIp());
        expect((await probeWithCookie(page, role)).status(), `${role}（2本）では管理の窓口が 200`).toBe(200);
        // 画面でも入口を通る: 止める見出しが出ず、管理画面の中身の列（admin-content-column）が出る
        await page.goto('/admin');
        await expect(page.getByTestId('admin-content-column'), `${role}（2本）の管理画面`).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole('heading', { name: '2要素認証が必要です' })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'アクセス権限がありません' })).toHaveCount(0);

        await page.context().clearCookies();
      }
    });

    test(`FREQ-316-REQ-02-AC-01 認めた鍵が1本の店員の JWT では管理の窓口が 403（MFA required）、2本の店員では通る (${viewport.name})`, async ({ page }) => {
      requireLocalEnv();
      const oneKey = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal1'));
      await placeAdminCookies(page, oneKey, uniqueSourceIp());
      const denied = await probeWithCookie(page, 'admin');
      expect(denied.status(), '認めた鍵が1本の店員は 403').toBe(403);
      expect(((await denied.json()) as { reason?: string }).reason).toBe('MFA required');

      const twoKeys = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      await placeAdminCookies(page, twoKeys, uniqueSourceIp());
      expect((await probeWithCookie(page, 'admin')).status(), '認めた鍵が2本の店員は 200').toBe(200);
    });

    test(`FREQ-316-REQ-01-AC-01 Cookie の access token だけで管理の窓口が通り、iss か aud の違うトークンは断られる (${viewport.name})`, async ({ page, request }) => {
      requireLocalEnv();
      if (!JWT_SECRET) throw new Error('JWT_SECRET が env に無い（署名し直した JWT の確かめに要る）');
      // 認めたパスキー2本の店長（古い名前の aal2）の JWT を Cookie に置く。TOTP は使わない
      const actor = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const aal2Token = actor.accessToken;
      await placeAdminCookies(page, actor, uniqueSourceIp());

      // Authorization の見出しが無く Cookie の access token だけを持つ管理者の要求が、管理の窓口を通る
      const viaCookie = await probeWithCookie(page, 'admin');
      expect(viaCookie.status()).toBe(200);

      // 署名が正しい（手元の JWT_SECRET で署名し直した）JWT。対照: クレームを変えなければ通る
      const probeUrl = new URL(PROBE_ROUTE.admin, originOf(page.url())).toString();
      const probeWith = async (token: string) =>
        (await request.get(probeUrl, { headers: { Authorization: `Bearer ${token}` }, failOnStatusCode: false, maxRedirects: 0 })).status();
      expect(await probeWith(resignedToken(aal2Token, () => undefined)), '対照: クレームを変えない署名し直しは通る').toBe(200);

      // 署名が正しくても iss か aud が違うトークンは 401
      expect(
        await probeWith(resignedToken(aal2Token, (claims) => { claims.iss = 'https://issuer.invalid/auth/v1'; })),
        'iss が違うトークン',
      ).toBe(401);
      expect(
        await probeWith(resignedToken(aal2Token, (claims) => { claims.aud = 'not-authenticated'; })),
        'aud が違うトークン',
      ).toBe(401);
    });

    test(`FREQ-316-REQ-03-AC-01 ログアウトの後、その前の access token で管理の窓口が 401 になる (${viewport.name})`, async ({ page, request }) => {
      const actor = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const aal2Token = actor.accessToken;
      const ip = uniqueSourceIp();
      const { origin, csrfToken } = await placeAdminCookies(page, actor, ip);
      const probeUrl = new URL(PROBE_ROUTE.admin, origin).toString();
      const probeBearer = async () =>
        (await request.get(probeUrl, { headers: { Authorization: `Bearer ${aal2Token}` }, failOnStatusCode: false, maxRedirects: 0 })).status();

      // ログアウトの前は、期限内の access token で通る
      expect(await probeBearer()).toBe(200);

      const logout = await page.request.post(new URL(LOGOUT_ROUTE, origin).toString(), {
        headers: { origin, 'x-csrf-token': csrfToken, 'x-real-ip': ip },
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      expect(logout.status()).toBe(200);

      // ログアウトの前の access token（期限内）で管理の窓口を呼ぶと 401
      expect(claimsOf(aal2Token).sub, '期限内の access token は同じ店長のもの').toBe(actor.userId);
      expect(await probeBearer()).toBe(401);
    });
  });
}
