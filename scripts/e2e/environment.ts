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
};

export function isLocalUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return LOCAL_HOSTNAMES.has(new URL(raw).hostname);
  } catch {
    return false;
  }
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
  return problems;
}

export function assertSafeE2EEnv(env: EnvRecord): void {
  const problems = findUnsafeE2ESettings(env);
  if (problems.length > 0) {
    throw new Error(`E2E の見張り: 本番につながるおそれがあるので止めました。\n- ${problems.join('\n- ')}`);
  }
}

/** 3000番のアプリが「この設定で起動した E2E 用のもの」かを見分ける印。秘密は含めない。 */
export function computeServerFingerprint(env: EnvRecord, mode: E2EServerMode): string {
  const material = JSON.stringify({
    v: 2,
    mode,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    mailProvider: env.MAIL_PROVIDER ?? '',
    mailUrl: env.MAIL_LOCAL_URL ?? '',
    stripeKeyPrefix: (env.STRIPE_SECRET_KEY ?? '').slice(0, 8),
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
