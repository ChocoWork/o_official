/** @jest-environment node */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  E2E_FIXED_ENV,
  buildE2EOverrides,
  computeServerFingerprint,
  decideServerReuse,
  findUnsafeE2ESettings,
  isLocalUrl,
  parseSupabaseStatus,
  prepareE2EEnvironment,
  probeServer,
  readLocalSupabaseStatus,
  type LocalSupabaseStatus,
  type ServerProbe,
} from '@/../scripts/e2e/environment';

const status: LocalSupabaseStatus = {
  apiUrl: 'http://127.0.0.1:54321',
  anonKey: 'local-anon-key',
  serviceRoleKey: 'local-service-role-key',
  jwtSecret: 'local-jwt-secret-0123456789abcdef0123456789',
  mailpitUrl: 'http://127.0.0.1:54324',
};

// .env.local に近い値（本番の Supabase・Resend の鍵が入っている）
const dotEnvLocal = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://prodproject.supabase.co',
  SUPABASE_URL: 'https://prodproject.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'prod-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'prod-service',
  MAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_prod_key',
  RESEND_WEBHOOK_SECRET: 'whsec_prod_secret',
  STRIPE_SECRET_KEY: 'sk_test_abc',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc',
};

const safeEnv = { ...dotEnvLocal, ...buildE2EOverrides(status) };

describe('isLocalUrl', () => {
  it.each(['http://127.0.0.1:54321', 'http://localhost:3000', 'http://[::1]:54321'])('%s は手元', (url) => {
    expect(isLocalUrl(url)).toBe(true);
  });
  it.each(['https://prodproject.supabase.co', 'not a url', undefined, ''])('%s は手元ではない', (url) => {
    expect(isLocalUrl(url)).toBe(false);
  });
});

describe('parseSupabaseStatus', () => {
  it('npx supabase status -o json の出力から E2E に要る値を取り出す', () => {
    const json = JSON.stringify({
      API_URL: status.apiUrl,
      ANON_KEY: status.anonKey,
      SERVICE_ROLE_KEY: status.serviceRoleKey,
      JWT_SECRET: status.jwtSecret,
      MAILPIT_URL: status.mailpitUrl,
      DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    });
    expect(parseSupabaseStatus(json)).toEqual(status);
  });

  it('値が欠けていたら、手元の Supabase を起動するよう言って止める', () => {
    expect(() => parseSupabaseStatus(JSON.stringify({ API_URL: status.apiUrl }))).toThrow('npx supabase start');
  });
});

describe('readLocalSupabaseStatus', () => {
  it('状態を読めない（Docker や手元の Supabase が止まっている）ときは、起動を促して止める', () => {
    const run = () => {
      throw new Error('supabase start is not running');
    };
    expect(() => readLocalSupabaseStatus(run)).toThrow('npx supabase start で手元の Supabase を起動してください');
  });

  it('読めたら E2E に要る値を返す', () => {
    const run = () =>
      JSON.stringify({
        API_URL: status.apiUrl,
        ANON_KEY: status.anonKey,
        SERVICE_ROLE_KEY: status.serviceRoleKey,
        JWT_SECRET: status.jwtSecret,
        MAILPIT_URL: status.mailpitUrl,
      });
    expect(readLocalSupabaseStatus(run)).toEqual(status);
  });
});

describe('buildE2EOverrides', () => {
  it('手元の住所と鍵・E2E の固定値を返し、Resend の鍵は空にする', () => {
    const overrides = buildE2EOverrides(status);
    expect(overrides).toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: status.apiUrl,
      SUPABASE_URL: status.apiUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: status.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: status.serviceRoleKey,
      JWT_SECRET: status.jwtSecret,
      MAIL_LOCAL_URL: status.mailpitUrl,
      MAIL_PROVIDER: 'local',
      RESEND_API_KEY: '',
      RESEND_WEBHOOK_SECRET: 'whsec_ZTJlLWxvY2FsLXJlc2VuZC13ZWJob29rLW9ubHk=',
    });
    expect(overrides).toMatchObject(E2E_FIXED_ENV);
  });

  it('E2E の定期処理の合言葉は32文字以上', () => {
    expect(E2E_FIXED_ENV.CRON_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});

describe('findUnsafeE2ESettings', () => {
  it('手元の設定なら止める理由は無い', () => {
    expect(findUnsafeE2ESettings(safeEnv)).toEqual([]);
  });

  it.each([
    ['NEXT_PUBLIC_SUPABASE_URL', 'https://prodproject.supabase.co'],
    ['SUPABASE_URL', 'https://prodproject.supabase.co'],
    ['STRIPE_SECRET_KEY', 'sk_live_abc'],
    ['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_live_abc'],
    ['MAIL_PROVIDER', 'resend'],
    ['MAIL_LOCAL_URL', 'https://mail.example.com'],
    ['RESEND_API_KEY', 're_prod_key'],
  ])('%s が %s なら止める理由に挙げる', (key, value) => {
    expect(findUnsafeE2ESettings({ ...safeEnv, [key]: value }).join('\n')).toContain(key);
  });

  it('制限付きのテスト用の鍵（rk_test_）は受け付ける', () => {
    expect(findUnsafeE2ESettings({ ...safeEnv, STRIPE_SECRET_KEY: 'rk_test_abc' })).toEqual([]);
  });
});

describe('computeServerFingerprint', () => {
  it('同じ設定なら同じ値（16進32文字）', () => {
    const a = computeServerFingerprint(safeEnv, 'start');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(computeServerFingerprint({ ...safeEnv }, 'start')).toBe(a);
  });

  it('起動のしかた（本番ビルド・開発サーバー）で変わる', () => {
    expect(computeServerFingerprint(safeEnv, 'dev')).not.toBe(computeServerFingerprint(safeEnv, 'start'));
  });

  it('Supabase の住所で変わる', () => {
    expect(computeServerFingerprint({ ...safeEnv, NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }, 'start')).not.toBe(
      computeServerFingerprint(safeEnv, 'start'),
    );
  });
});

describe('decideServerReuse', () => {
  it('3000番が空いていれば起動する（使い回さない）', () => {
    expect(decideServerReuse({ kind: 'down' }, 'fp', false)).toBe(false);
  });

  it('同じ印のアプリなら使い回す', () => {
    expect(decideServerReuse({ kind: 'up', fingerprint: 'fp' }, 'fp', false)).toBe(true);
  });

  it('印を返さないアプリ（普段の開発サーバーなど）が動いていたら止める', () => {
    expect(() => decideServerReuse({ kind: 'up', fingerprint: null }, 'fp', false)).toThrow('止めてから流してください');
  });

  it('印が違うアプリが動いていたら止める', () => {
    expect(() => decideServerReuse({ kind: 'up', fingerprint: 'other' }, 'fp', false)).toThrow('止めてから流してください');
  });

  it('E2E_STRICT=1 では同じ印でも使い回さずに止める', () => {
    expect(() => decideServerReuse({ kind: 'up', fingerprint: 'fp' }, 'fp', true)).toThrow('E2E_STRICT=1');
  });
});

describe('probeServer', () => {
  jest.setTimeout(20_000);

  const children: ChildProcess[] = [];

  const startServer = async (handler: string): Promise<{ baseUrl: string; child: ChildProcess }> => {
    const script = [
      "const http = require('node:http');",
      `const server = http.createServer(${handler});`,
      "server.listen(0, '127.0.0.1', () => {",
      "  process.stdout.write(String(server.address().port) + '\\n');",
      '});',
    ].join('\n');
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(child);

    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string | Buffer) => {
        output += chunk;
        const port = Number(output.split(/\r?\n/, 1)[0]);
        if (!settled && Number.isInteger(port) && port > 0) {
          settled = true;
          resolve({ baseUrl: `http://127.0.0.1:${port}`, child });
        }
      });
      child.once('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once('exit', (code, signal) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Test HTTP server exited before listening: code=${code}, signal=${signal}`));
        }
      });
    });
  };

  const stopServer = (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(), 1_000);
      timeout.unref();
      child.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill();
    });
  };

  afterEach(async () => {
    await Promise.all(children.splice(0).map(stopServer));
  });

  it('returns the fingerprint from a successful response', async () => {
    const { baseUrl } = await startServer(
      "(request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ fingerprint: 'abc' })); }",
    );
    expect(probeServer(baseUrl, 300)).toEqual({ kind: 'up', fingerprint: 'abc' });
  });

  it('treats a non-OK response as an up server without a fingerprint', async () => {
    const { baseUrl } = await startServer("(request, response) => { response.statusCode = 404; response.end('not found'); }");
    expect(probeServer(baseUrl, 300)).toEqual({ kind: 'up', fingerprint: null });
  });

  it('treats a JSON null response as an up server without a fingerprint', async () => {
    const { baseUrl } = await startServer("(request, response) => { response.setHeader('content-type', 'application/json'); response.end('null'); }");
    expect(probeServer(baseUrl, 300)).toEqual({ kind: 'up', fingerprint: null });
  });

  it('treats a response slower than the probe timeout as an up server without a fingerprint', async () => {
    const { baseUrl } = await startServer(
      "(request, response) => { setTimeout(() => response.end(JSON.stringify({ fingerprint: 'late' })), 2000); }",
    );
    expect(probeServer(baseUrl, 300)).toEqual({ kind: 'up', fingerprint: null });
  });

  it('treats a refused connection as a down server', async () => {
    const { baseUrl, child } = await startServer('(request, response) => response.end()');
    await stopServer(child);
    expect(probeServer(baseUrl, 300)).toEqual({ kind: 'down' });
  });
});

describe('prepareE2EEnvironment', () => {
  const baseUrl = 'http://localhost:3000';

  it('.env.local の本番の値を手元の値で上書きし、印を付ける', () => {
    const readStatus = jest.fn(() => status);
    const probe = jest.fn((): ServerProbe => ({ kind: 'down' }));

    const result = prepareE2EEnvironment({
      baseEnv: dotEnvLocal, mode: 'start', strict: false, isWorker: false, baseUrl, readStatus, probe,
    });

    expect(result.reuseExistingServer).toBe(false);
    expect(result.env.NEXT_PUBLIC_SUPABASE_URL).toBe(status.apiUrl);
    expect(result.env.SUPABASE_SERVICE_ROLE_KEY).toBe(status.serviceRoleKey);
    expect(result.env.RESEND_API_KEY).toBe('');
    expect(result.env.RESEND_WEBHOOK_SECRET).toBe('whsec_ZTJlLWxvY2FsLXJlc2VuZC13ZWJob29rLW9ubHk=');
    expect(result.env.E2E_SERVER_FINGERPRINT).toBe(computeServerFingerprint(safeEnv, 'start'));
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(baseUrl);
  });

  it('同じ印のアプリが動いていれば使い回す', () => {
    const fingerprint = computeServerFingerprint(safeEnv, 'start');
    const result = prepareE2EEnvironment({
      baseEnv: dotEnvLocal, mode: 'start', strict: false, isWorker: false, baseUrl,
      readStatus: () => status, probe: () => ({ kind: 'up', fingerprint }),
    });
    expect(result.reuseExistingServer).toBe(true);
  });

  it('Stripe の鍵が本番用なら止める', () => {
    expect(() =>
      prepareE2EEnvironment({
        baseEnv: { ...dotEnvLocal, STRIPE_SECRET_KEY: 'sk_live_abc' }, mode: 'start', strict: false, isWorker: false,
        baseUrl, readStatus: () => status, probe: () => ({ kind: 'down' }),
      }),
    ).toThrow('STRIPE_SECRET_KEY');
  });

  it('worker では手元の状態を読み直さず、受け継いだ値を確かめるだけ', () => {
    const readStatus = jest.fn(() => status);
    const probe = jest.fn((): ServerProbe => ({ kind: 'down' }));
    expect(
      prepareE2EEnvironment({ baseEnv: safeEnv, mode: 'start', strict: false, isWorker: true, baseUrl, readStatus, probe }),
    ).toEqual({ env: {}, reuseExistingServer: false });
    expect(readStatus).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('worker が本番の値を受け継いでいたら止める', () => {
    expect(() =>
      prepareE2EEnvironment({ baseEnv: dotEnvLocal, mode: 'start', strict: false, isWorker: true, baseUrl }),
    ).toThrow('E2E の見張り');
  });
});
