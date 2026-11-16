/**
 * 店員（admin・supporter）をパスキー付きで用意し、パスキーでログインする、試験・手元の開発の共有の道具。手元の Supabase だけ。
 *
 * 用意の順は計画の案 B: 利用者を作る（パスワード無し）→ magiclink の session → パスキーを N 本登録 →
 * passkey_approve(..., 'script') → 最後に user_roles を有効にする。役割が無い間に登録するのは、有効な店員の magiclink は
 * フックに拒否され、TOTP の要素が残ると GoTrue が登録に aal2 を求めるため。だから既にいる店員は再利用しない。
 * アプリ（src/）はこのファイルを読まない。本番に試験専用の入口を作らない。JWT・鍵・token は失敗の文面に出さない。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-244
 * @design DD-AUTH-046
 * @remarks captcha（Turnstile）は始めの要求だけが対象。手元の config は有効（秘密は Cloudflare の公開のテスト用）なので、
 * e2e/captcha-test-utils.ts のダミーのトークンを options.captchaToken で渡す。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { DUMMY_CAPTCHA_TOKEN } from '../../e2e/captcha-test-utils';
import { createSoftAuthenticator, type SoftAuthenticator } from '../../e2e/passkey-soft-authenticator';
import type { PgClient } from '../../tests/integration/db/helpers/local-db';
import { isLocalUrl, readLocalSupabaseStatus } from './environment';

/** 手元の supabase/config.toml の [auth.webauthn]（rp_id・rp_origins）と同じ */
const RELYING_PARTY = { origin: 'http://localhost:3000', rpId: 'localhost' } as const;

type LocalEnv = { url: string; anonKey: string; serviceRoleKey: string };

/** 呼び手が環境変数で渡した値を優先し、無ければ手元の `supabase status -o json` をプロセスの中で読む（.env* は読まない） */
function localEnv(): LocalEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const env: LocalEnv =
    url && anonKey && serviceRoleKey
      ? { url, anonKey, serviceRoleKey }
      : (() => {
          const s = readLocalSupabaseStatus();
          return { url: s.apiUrl, anonKey: s.anonKey, serviceRoleKey: s.serviceRoleKey };
        })();
  if (!isLocalUrl(env.url)) throw new Error('パスキーの店員の道具は手元の Supabase だけで使える');
  return env;
}

/** Auth の回数の制限は送り元ごとに数える。全部の試験が 1 つの枠を使い切らないよう、呼ぶごとに別の送り元にする（admin-session-test-utils と同じ） */
function client(env: LocalEnv, key: string): SupabaseClient {
  const [a, b, c] = randomBytes(3);
  return createClient(env.url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-forwarded-for': `10.${a}.${b}.${c}` } },
  });
}

function fail(step: string, error: { status?: number; code?: string } | null | undefined): never {
  throw new Error(`${step}に失敗した（status: ${error?.status ?? '不明'}, code: ${error?.code ?? '不明'}）`);
}

/**
 * パスワード無しの店員を作り、パスキーを approvedPasskeys 本登録して認める。同じメールが既にあれば投げる。
 * 返す authenticators は、登録した順の認証器（loginWithPasskey に渡す）。
 */
export async function provisionStaff(
  db: PgClient,
  input: { role: 'admin' | 'supporter'; approvedPasskeys: 0 | 1 | 2; email?: string },
): Promise<{ userId: string; email: string; authenticators: SoftAuthenticator[] }> {
  const env = localEnv();
  const email = input.email ?? `passkey-staff-${input.role}-${randomUUID().slice(0, 8)}@example.com`;

  const existing = await db.query('select 1 from auth.users where lower(email) = lower($1)', [email]);
  if (existing.rowCount > 0) throw new Error('同じメールの利用者が既にいる（既にいる店員は再利用しない）');

  const admin = client(env, env.serviceRoleKey);
  const created = await admin.auth.admin.createUser({ email, email_confirm: true, app_metadata: { role: input.role } }).catch(() => {
    throw new Error('店員を作る要求に失敗した');
  });
  if (created.error || !created.data.user) fail('店員を作ること', created.error);
  const userId = created.data.user.id;

  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) fail('magiclink を作ること', link.error);

  const user = client(env, env.anonKey);
  const verified = await user.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  if (verified.error || !verified.data.session) fail('magiclink の検証', verified.error);

  const authenticators: SoftAuthenticator[] = [];
  for (let i = 0; i < input.approvedPasskeys; i += 1) {
    const authenticator = createSoftAuthenticator(RELYING_PARTY);
    const start = await user.auth.passkey.startRegistration();
    if (start.error || !start.data) fail('パスキー登録の始め', start.error);
    const done = await user.auth.passkey.verifyRegistration({
      challengeId: start.data.challenge_id,
      credential: authenticator.register(start.data.options),
    });
    if (done.error || !done.data) fail('パスキー登録の終わり', done.error);
    await db.query('select public.passkey_approve($1::uuid, $2::uuid, $3)', [userId, done.data.id, 'script']);
    authenticators.push(authenticator);
  }

  const assigned = await db.query(
    `insert into public.user_roles (user_id, role_id, active, expires_at)
     select $1::uuid, r.id, true, null from public.roles r where r.code = $2`,
    [userId, input.role],
  );
  if (assigned.rowCount !== 1) throw new Error(`役割 ${input.role} の行が手元の DB に無い`);

  return { userId, email, authenticators };
}

/** パスキーでログインし、session を返す。メールは、返った利用者が期待どおりかの確かめにだけ使う */
export async function loginWithPasskey(input: { email: string; authenticator: SoftAuthenticator }): Promise<{ session: Session }> {
  const env = localEnv();
  const c = client(env, env.anonKey);
  const start = await c.auth.passkey.startAuthentication({ options: { captchaToken: DUMMY_CAPTCHA_TOKEN } });
  if (start.error || !start.data) fail('パスキーログインの始め', start.error);
  const done = await c.auth.passkey.verifyAuthentication({
    challengeId: start.data.challenge_id,
    credential: input.authenticator.authenticate(start.data.options),
  });
  if (done.error || !done.data?.session) fail('パスキーログインの終わり', done.error);
  if (done.data.user?.email?.toLowerCase() !== input.email.toLowerCase()) throw new Error('パスキーでログインした利用者がメールと合わない');
  return { session: done.data.session };
}
