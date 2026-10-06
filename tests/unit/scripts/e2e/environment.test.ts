/** @jest-environment node */
import childProcess, { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
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
  ALERT_AUDIT_URL: 'https://audit.example.com/records',
  RESEND_WEBHOOK_SECRET: 'whsec_prod_secret',
  STRIPE_SECRET_KEY: 'sk_test_abc',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc',
};

const safeEnv = { ...dotEnvLocal, ...buildE2EOverrides(status) };

describe('Playwright のサーバー環境', () => {
  it('鍵はプロセスに渡し、JSON に保存される webServer 設定には入れない', () => {
    const env = { NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon', SUPABASE_SERVICE_ROLE_KEY: 'fake-service', JWT_SECRET: 'fake-jwt' };
    const testProcess = { env: {}, cwd: () => 'unit-test' };
    const exported: { default?: { webServer: Record<string, unknown> } } = {};
    const dependencies: Record<string, unknown> = {
      '@playwright/test': { defineConfig: (config: unknown) => config, devices: { 'Desktop Chrome': {} } },
      '@next/env': { loadEnvConfig: () => {} },
      './scripts/e2e/environment': { prepareE2EEnvironment: () => ({ env }) },
    };
    const source = readFileSync(path.resolve('playwright.config.ts'), 'utf8');
    const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
    // 設定を隔離して実行し、実際の .env 読み込み・Supabase・アプリ起動を避ける。
    runInNewContext(compiled, { exports: exported, process: testProcess, require: (name: string) => dependencies[name] });
    expect(testProcess.env).toEqual(env);
    expect(exported.default?.webServer.command).toBe('node scripts/e2e-server.mjs');
    expect(exported.default?.webServer).not.toHaveProperty('env');
  });
});

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
      ALERT_AUDIT_URL: '',
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

  it('E2E の固定キーの値だけが違っても印が変わる', () => {
    expect(computeServerFingerprint({ ...safeEnv, ALERT_AUDIT_URL: 'https://audit.example.com/records' }, 'start')).not.toBe(
      computeServerFingerprint({ ...safeEnv, ALERT_AUDIT_URL: '' }, 'start'),
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

describe('起動スクリプトと probeServer の接続失敗の分類', () => {
  const refused = { code: 'ECONNREFUSED' };
  const mixed = Object.assign(new AggregateError([refused, { code: 'ETIMEDOUT' }]), { code: 'ECONNREFUSED' });
  const allRefused = Object.assign(new AggregateError([refused, refused]), { code: 'ECONNREFUSED' });
  const emptyAggregate = Object.assign(new AggregateError([]), { code: 'ECONNREFUSED' });
  const cases = [
    { name: '正常な応答', failure: undefined, up: true },
    { name: '接続拒否', failure: { cause: refused }, up: false },
    { name: 'すべて接続拒否の AggregateError', failure: { cause: allRefused }, up: false },
    { name: '拒否とタイムアウトが混ざり code が拒否の AggregateError', failure: { cause: mixed }, up: true },
    { name: '空で code だけが拒否の AggregateError', failure: { cause: emptyAggregate }, up: true },
    { name: 'タイムアウト', failure: { name: 'TimeoutError' }, up: true },
    { name: '接続リセット', failure: { cause: { code: 'ECONNRESET' } }, up: true },
    { name: '名前解決失敗', failure: { cause: { code: 'ENOTFOUND' } }, up: true },
    { name: '原因不明', failure: new Error('unknown'), up: true },
  ];

  // トップレベルの起動処理は実行せず、実際の関数を VM 内の fetch に対して動かす。
  const source = readFileSync(path.resolve('scripts/e2e-server.mjs'), 'utf8');
  const isUpSource = source.match(/async function isUp\(\) \{[\s\S]*?\r?\n\}/)?.[0];
  if (!isUpSource) throw new Error('isUp が見つかりません');

  it.each(cases)('isUp: $name のとき up=$up', async ({ failure, up }) => {
    const result = await runInNewContext(`${isUpSource}\nisUp()`, {
      BASE_URL: 'http://unit-test.invalid', AbortSignal, AggregateError,
      fetch: async () => {
        if (failure) throw failure;
        return {};
      },
    });
    expect(result).toBe(up);
  });

  it.each(cases)('probeServer: $name のとき up=$up', async ({ failure, up }) => {
    const exec = jest.spyOn(childProcess, 'execFileSync').mockReturnValueOnce('{"kind":"up","fingerprint":null}');
    let script: string;
    try {
      probeServer('http://unit-test.invalid', 300);
      script = (exec.mock.calls[0][1] as string[])[1];
    } finally {
      exec.mockRestore();
    }
    let output = '';
    await runInNewContext(script, {
      AbortSignal, AggregateError,
      process: { argv: ['node', 'http://unit-test.invalid/api/e2e/server-info', '300'], stdout: { write: (chunk: string) => { output += chunk; } } },
      fetch: async () => {
        if (failure) throw failure;
        return { ok: true, json: async () => ({ fingerprint: 'test-fp' }) };
      },
    });
    expect(JSON.parse(output)).toEqual(up
      ? { kind: 'up', fingerprint: failure ? null : 'test-fp' }
      : { kind: 'down' });
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

    expect(Object.keys(result)).toEqual(['env']);
    expect(result.env.NEXT_PUBLIC_SUPABASE_URL).toBe(status.apiUrl);
    expect(result.env.SUPABASE_SERVICE_ROLE_KEY).toBe(status.serviceRoleKey);
    expect(result.env.RESEND_API_KEY).toBe('');
    expect(result.env.ALERT_AUDIT_URL).toBe('');
    expect(result.env.RESEND_WEBHOOK_SECRET).toBe('whsec_ZTJlLWxvY2FsLXJlc2VuZC13ZWJob29rLW9ubHk=');
    expect(result.env.E2E_SERVER_FINGERPRINT).toBe(computeServerFingerprint(safeEnv, 'start'));
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(baseUrl);
  });

  it('同じ印のアプリが動いていれば止めずに環境だけを返す', () => {
    const fingerprint = computeServerFingerprint(safeEnv, 'start');
    const result = prepareE2EEnvironment({
      baseEnv: dotEnvLocal, mode: 'start', strict: false, isWorker: false, baseUrl,
      readStatus: () => status, probe: () => ({ kind: 'up', fingerprint }),
    });
    expect(Object.keys(result)).toEqual(['env']);
    expect(result.env.E2E_SERVER_FINGERPRINT).toBe(fingerprint);
  });

  it.each([null, 'other'])('印が %s の起動済みアプリは使い回せないので止める', (fingerprint) => {
    expect(() => prepareE2EEnvironment({
      baseEnv: dotEnvLocal, mode: 'start', strict: false, isWorker: false, baseUrl,
      readStatus: () => status, probe: () => ({ kind: 'up', fingerprint }),
    })).toThrow('止めてから流してください');
  });

  it('E2E_STRICT=1 では同じ印の起動済みアプリも止める', () => {
    const fingerprint = computeServerFingerprint(safeEnv, 'start');
    expect(() => prepareE2EEnvironment({
      baseEnv: dotEnvLocal, mode: 'start', strict: true, isWorker: false, baseUrl,
      readStatus: () => status, probe: () => ({ kind: 'up', fingerprint }),
    })).toThrow('E2E_STRICT=1');
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
    ).toEqual({ env: {} });
    expect(readStatus).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('worker が本番の値を受け継いでいたら止める', () => {
    expect(() =>
      prepareE2EEnvironment({ baseEnv: dotEnvLocal, mode: 'start', strict: false, isWorker: true, baseUrl }),
    ).toThrow('E2E の見張り');
  });
});
