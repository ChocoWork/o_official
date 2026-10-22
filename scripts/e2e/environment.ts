/**
 * E2E を手元の Supabase で流すための環境づくりと見張り（設計書 2026-10-05 グループ B の 7-3）。
 *
 * - 手元の Supabase の住所と鍵は、起動のたびに `npx supabase status -o json` から読む（ファイルに書かない）。
 * - `.env.local` の本番の Supabase の鍵と Resend の鍵は、E2E のアプリにもテストにも渡さない。
 * - 本番につながるおそれのある設定なら、理由を出して止める。
 * - 3000番のアプリは、この仕組みが同じ設定で起動したもの（同じ印を返すもの）だけ使い回す。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export type EnvRecord = Record<string, string | undefined>;

export type E2EServerMode = 'start' | 'dev';

export type LocalSupabaseStatus = {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  jwtSecret: string;
  mailpitUrl: string;
};

export type ServerProbe = { kind: 'down' } | { kind: 'up'; fingerprint: string | null };

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * 作り物の 17TRACK（scripts/e2e/fake-17track.mjs。グループ E-4）。手元の 127.0.0.1:4017 だけで動き、本物の 17TRACK へは転送しない。
 * 鍵は試験用の決まった文字列で、本物の鍵ではない。scripts/e2e-server.mjs にも同じ port・鍵が書いてある（二重の見張り。ずれは単体の試験が見つける）。
 * 契約版は共通の見本 tests/fixtures/17track/v2.4.json の contract と同じ。
 */
export const E2E_FAKE_17TRACK_PORT = 4017;
export const E2E_FAKE_17TRACK_URL = `http://127.0.0.1:${E2E_FAKE_17TRACK_PORT}/track/v2.4`;
export const E2E_FAKE_17TRACK_KEY = 'e2e-fake-17track-key-0123456789';
export const E2E_FAKE_17TRACK_CONTRACT = '17track-v2.4';

/**
 * 作り物のコード（scripts/e2e/fake-17track.mjs）と、答えの元の見本（tests/fixtures/17track/v2.4.json）の内容から作る短いハッシュ。
 * 作り物の /__health の build、scripts/e2e-server.mjs の使い回しの判断、サーバーの fingerprint が同じ値を使う
 * （作り物のコードや見本を直したのに、古い作り物で通ってしまうのを防ぐ。計算は fake-17track.mjs・e2e-server.mjs の computeFakeBuild と同じで、単体の試験が一致を確かめる）。
 */
export function computeFake17TrackBuild(): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path.resolve(__dirname, 'fake-17track.mjs')));
  hash.update('\0');
  hash.update(readFileSync(path.resolve(__dirname, '../../tests/fixtures/17track/v2.4.json')));
  return hash.digest('hex').slice(0, 16);
}

/** E2E だけで使う固定の値。本番の値ではない。 */
export const E2E_FIXED_ENV: Readonly<Record<string, string>> = {
  MAIL_PROVIDER: 'local',
  MAIL_FROM_ADDRESS: 'no-reply@e2e.test',
  CONTACT_TO_EMAIL: 'shop@e2e.test',
  SHOP_ALERT_EMAIL: 'shop-alert@e2e.test',
  CONTACT_INBOUND_DOMAIN: 'inbound.e2e.test',
  CONTACT_REPLY_SECRET: 'e2e-local-contact-reply-secret-0123456789',
  RESEND_API_KEY: '',
  ALERT_AUDIT_URL: '',
  RESEND_WEBHOOK_SECRET: 'whsec_ZTJlLWxvY2FsLXJlc2VuZC13ZWJob29rLW9ubHk=',
  STRIPE_WEBHOOK_SECRET: 'whsec_e2e_local_only',
  CRON_SECRET: 'e2e-local-cron-secret-0123456789abcdef',
  ORDER_STATUS_SESSION_SECRET: 'e2e-order-status-session-secret-only',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
  TRACKING_17TRACK_BASE_URL: E2E_FAKE_17TRACK_URL,
  TRACKING_17TRACK_API_KEY: E2E_FAKE_17TRACK_KEY,
};

export function isLocalUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return LOCAL_HOSTNAMES.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * 17TRACK の接続先が、手元の作り物（http・loopback・4017番・/track/v2.4 だけ）かを見る。安全なら null、そうでなければ止める理由。
 * 省略（アプリは本物の https://api.17track.net へ向かう）・本番・手元でない住所・別の道・別の port・URL の中の認証情報を拒む。
 * 理由には URL の中身を出さない（認証情報が入りうるため）。
 */
function findUnsafeTrackingUrl(raw: string | undefined): string | null {
  if (!raw || raw.trim() === '') {
    return 'TRACKING_17TRACK_BASE_URL が無い（省略すると本番の 17TRACK へ向かう）';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'TRACKING_17TRACK_BASE_URL が URL ではない（17TRACK の作り物の住所だけを受け付ける）';
  }
  if (url.username !== '' || url.password !== '') {
    return 'TRACKING_17TRACK_BASE_URL に認証情報が入っている';
  }
  if (url.protocol !== 'http:' || !LOCAL_HOSTNAMES.has(url.hostname)) {
    return 'TRACKING_17TRACK_BASE_URL が手元の 17TRACK の作り物（http の loopback）ではない';
  }
  if (url.port !== String(E2E_FAKE_17TRACK_PORT)) {
    return `TRACKING_17TRACK_BASE_URL が 17TRACK の作り物の port（${E2E_FAKE_17TRACK_PORT}番）ではない`;
  }
  if (url.pathname.replace(/\/+$/, '') !== '/track/v2.4' || url.search !== '' || url.hash !== '') {
    return 'TRACKING_17TRACK_BASE_URL が 17TRACK の作り物の道（/track/v2.4）ではない';
  }
  return null;
}

/** `npx supabase status -o json` の出力から、E2E に要る値だけを取り出す。 */
export function parseSupabaseStatus(json: string): LocalSupabaseStatus {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const pick = (key: string): string => {
    const value = raw[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `E2E の見張り: 手元の Supabase の状態に ${key} がありません。Docker を起動し、npx supabase start で手元の Supabase を起動してください。`,
      );
    }
    return value;
  };
  return {
    apiUrl: pick('API_URL'),
    anonKey: pick('ANON_KEY'),
    serviceRoleKey: pick('SERVICE_ROLE_KEY'),
    jwtSecret: pick('JWT_SECRET'),
    mailpitUrl: pick('MAILPIT_URL'),
  };
}

/** E2E のアプリとテストに渡す値。`.env.local` の同じ名前の値を上書きする。 */
export function buildE2EOverrides(status: LocalSupabaseStatus): Record<string, string> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: status.apiUrl,
    SUPABASE_URL: status.apiUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: status.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: status.serviceRoleKey,
    JWT_SECRET: status.jwtSecret,
    MAIL_LOCAL_URL: status.mailpitUrl,
    ...E2E_FIXED_ENV,
  };
}

/** 本番につながるおそれのある設定を挙げる。空なら安全。 */
export function findUnsafeE2ESettings(env: EnvRecord): string[] {
  const problems: string[] = [];
  for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL']) {
    if (!isLocalUrl(env[key])) problems.push(`${key} が手元（localhost）ではない`);
  }
  if (!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? '')) {
    problems.push('STRIPE_SECRET_KEY がテスト用（sk_test_ / rk_test_）ではない');
  }
  if (!(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '').startsWith('pk_test_')) {
    problems.push('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY がテスト用（pk_test_）ではない');
  }
  if (env.MAIL_PROVIDER !== 'local') problems.push('MAIL_PROVIDER が local ではない');
  if (!isLocalUrl(env.MAIL_LOCAL_URL)) problems.push('MAIL_LOCAL_URL が手元（localhost）ではない');
  if (env.RESEND_API_KEY) problems.push('RESEND_API_KEY が空ではない');
  const trackingUrlProblem = findUnsafeTrackingUrl(env.TRACKING_17TRACK_BASE_URL);
  if (trackingUrlProblem) problems.push(trackingUrlProblem);
  // 17TRACK の鍵は、作り物の鍵だけ。本物の鍵を作り物へ（まして本物の 17TRACK へ）送らない。理由に鍵の値は出さない
  if (env.TRACKING_17TRACK_API_KEY !== E2E_FAKE_17TRACK_KEY) {
    problems.push('TRACKING_17TRACK_API_KEY が E2E 用の作り物の鍵ではない（本物の 17TRACK の鍵かもしれない）');
  }
  return problems;
}

export function assertSafeE2EEnv(env: EnvRecord): void {
  const problems = findUnsafeE2ESettings(env);
  if (problems.length > 0) {
    throw new Error(`E2E の見張り: 本番につながるおそれがあるので止めました。\n- ${problems.join('\n- ')}`);
  }
}

/**
 * 3000番のアプリが「この設定で起動した E2E 用のもの」かを見分ける印。秘密は含めない。
 * 作り物の 17TRACK の URL・契約版・コードのハッシュも入れる（変われば、前の設定で起動したアプリを使い回さない）。
 */
export function computeServerFingerprint(
  env: EnvRecord,
  mode: E2EServerMode,
  fakeContract: string = E2E_FAKE_17TRACK_CONTRACT,
  fakeBuild: string = computeFake17TrackBuild(),
): string {
  const material = JSON.stringify({
    v: 3,
    mode,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    mailProvider: env.MAIL_PROVIDER ?? '',
    mailUrl: env.MAIL_LOCAL_URL ?? '',
    stripeKeyPrefix: (env.STRIPE_SECRET_KEY ?? '').slice(0, 8),
    fake17track: { url: env.TRACKING_17TRACK_BASE_URL ?? '', contract: fakeContract, build: fakeBuild },
    fixed: Object.fromEntries(Object.keys(E2E_FIXED_ENV).sort().map((key) => [key, env[key] ?? null])),
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** 3000番を使い回すか。使い回せないアプリが動いていれば止める。 */
export function decideServerReuse(probe: ServerProbe, expectedFingerprint: string, strict: boolean): boolean {
  if (probe.kind === 'down') return false;
  if (probe.fingerprint !== expectedFingerprint) {
    throw new Error(
      'E2E の見張り: 3000番で、この E2E が手元の設定で起動したものではないアプリが動いています（普段の開発サーバーなど）。止めてから流してください。',
    );
  }
  if (strict) {
    throw new Error(
      'E2E の見張り: E2E_STRICT=1 では起動済みのアプリを使い回しません。3000番のアプリを止めてから流してください。',
    );
  }
  return true;
}

function runSupabaseStatus(): string {
  return execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
    timeout: 60_000,
  });
}

/** 手元の Supabase の状態を読む。読めなければ（Docker や Supabase が止まっている）、起動を促して止める。 */
export function readLocalSupabaseStatus(run: () => string = runSupabaseStatus): LocalSupabaseStatus {
  let output: string;
  try {
    output = run();
  } catch {
    throw new Error(
      'E2E の見張り: 手元の Supabase の状態を読めません。Docker を起動し、npx supabase start で手元の Supabase を起動してください。',
    );
  }
  return parseSupabaseStatus(output);
}

// 設定の読み込みは同期なので、別の node で3000番の印を読む。
const PROBE_SCRIPT = [
  'const isConnectionRefused = (error) => {',
  "  const cause = error && typeof error === 'object' ? error.cause : null;",
  "  if (!cause || typeof cause !== 'object') return false;",
  '  if (cause instanceof AggregateError) {',
  '    return cause.errors.length > 0 &&',
  "      cause.errors.every((item) => item && typeof item === 'object' && item.code === 'ECONNREFUSED');",
  '  }',
  "  return cause.code === 'ECONNREFUSED';",
  '};',
  'fetch(process.argv[1], { signal: AbortSignal.timeout(Number(process.argv[2])) })',
  '  .then(async (res) => {',
  '    const body = res.ok ? await res.json().catch(() => null) : null;',
  "    const fingerprint = body !== null && typeof body === 'object' && typeof body.fingerprint === 'string' ? body.fingerprint : null;",
  "    process.stdout.write(JSON.stringify({ kind: 'up', fingerprint }));",
  '  })',
  '  .catch((error) => {',
  "    const result = isConnectionRefused(error) ? { kind: 'down' } : { kind: 'up', fingerprint: null };",
  '    process.stdout.write(JSON.stringify(result));',
  '  });',
].join('\n');

export function probeServer(baseUrl: string, timeoutMs = 3000): ServerProbe {
  const target = new URL('/api/e2e/server-info', baseUrl).toString();
  const output = execFileSync(process.execPath, ['-e', PROBE_SCRIPT, target, String(timeoutMs)], {
    encoding: 'utf8',
    timeout: timeoutMs + 7000,
  });
  return JSON.parse(output) as ServerProbe;
}

export function prepareE2EEnvironment(options: {
  baseEnv: EnvRecord;
  mode: E2EServerMode;
  strict: boolean;
  isWorker: boolean;
  baseUrl: string;
  readStatus?: () => LocalSupabaseStatus;
  probe?: (baseUrl: string) => ServerProbe;
}): { env: Record<string, string> } {
  if (options.isWorker) {
    // Playwright の worker は設定を読み直す。本体のプロセスが上書きした値を受け継いでいるので、確かめるだけにする。
    assertSafeE2EEnv(options.baseEnv);
    return { env: {} };
  }

  // 17TRACK の接続先が明示されているなら、作り物の URL で上書きして隠す前に確かめる（本番の URL を書いたまま流しても、気づけるように止める）。
  // 省略されている時は下で作り物の URL を入れるので、ここでは止めない（入れた後の検査で必ず確かめる）
  const explicitTrackingUrl = options.baseEnv.TRACKING_17TRACK_BASE_URL;
  if (explicitTrackingUrl !== undefined && explicitTrackingUrl.trim() !== '') {
    const problem = findUnsafeTrackingUrl(explicitTrackingUrl);
    if (problem) {
      throw new Error(
        `E2E の見張り: 本番につながるおそれがあるので止めました。\n- ${problem}\n（E2E では 17TRACK の接続先を指定しないか、手元の作り物の URL にしてください）`,
      );
    }
  }

  const overrides = buildE2EOverrides((options.readStatus ?? readLocalSupabaseStatus)());
  const merged: EnvRecord = { ...options.baseEnv, ...overrides };
  assertSafeE2EEnv(merged);

  const fingerprint = computeServerFingerprint(merged, options.mode);
  const probe = (options.probe ?? probeServer)(options.baseUrl);
  // ここでは安全でない使い回しを止めるだけで、scripts/e2e-server.mjs が印で使い回しを決める。
  decideServerReuse(probe, fingerprint, options.strict);
  return {
    env: { ...overrides, E2E_SERVER_FINGERPRINT: fingerprint },
  };
}
