/** @jest-environment node */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  E2E_FAKE_17TRACK_KEY,
  E2E_FAKE_17TRACK_PORT,
  E2E_FAKE_17TRACK_URL,
} from '@/../scripts/e2e/environment';

/**
 * scripts/e2e-server.mjs の 17TRACK の見張りと、作り物（scripts/e2e/fake-17track.mjs）の起動の決め方。
 * トップレベルの起動処理（ビルド・サーバーの起動）は実行しない。
 * - 純粋な関数は、実際のソースから取り出して VM の中で動かす（既存の environment.test.ts の isUp と同じやり方）。
 * - 直接の起動は、危険な値で終わることだけを確かめる。空のフォルダを作業場所にするので、見張りが働かなくても
 *   `npm run build` は package.json を見つけられず、ビルドも 3000番のサーバーも起こらない。
 */
const serverSource = readFileSync(path.resolve('scripts/e2e-server.mjs'), 'utf8');
const serverScript = path.resolve('scripts/e2e-server.mjs');

function extract(name: string): string {
  const source = serverSource.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n\\}`))?.[0];
  if (!source) throw new Error(`${name} が scripts/e2e-server.mjs に見つかりません`);
  return source;
}

function extractConst(name: string): string {
  const source = serverSource.match(new RegExp(`const ${name} = [^;]+;`))?.[0];
  if (!source) throw new Error(`${name} が scripts/e2e-server.mjs に見つかりません`);
  return source;
}

const SAFE_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  STRIPE_SECRET_KEY: 'sk_test_unit',
  MAIL_PROVIDER: 'local',
  MAIL_LOCAL_URL: 'http://127.0.0.1:54324',
  RESEND_API_KEY: '',
  E2E_SERVER_FINGERPRINT: 'unit-test-fingerprint',
  TRACKING_17TRACK_BASE_URL: 'http://127.0.0.1:4017/track/v2.4',
  TRACKING_17TRACK_API_KEY: 'e2e-fake-17track-key-0123456789',
};

function findUnsafe(env: Record<string, string | undefined>): string[] {
  const source = [
    extractConst('FAKE_17TRACK_PORT'),
    extractConst('FAKE_17TRACK_KEY'),
    extract('isLocalUrl'),
    extract('findUnsafeTrackingUrl'),
    extract('findUnsafeSettings'),
    'findUnsafeSettings(env)',
  ].join('\n');
  return runInNewContext(source, { env, URL, LOCAL_HOSTNAMES: new Set(['localhost', '127.0.0.1', '::1', '[::1]']) }) as string[];
}

describe('scripts/e2e-server.mjs の 17TRACK の見張り（純粋な関数）', () => {
  it('作り物の鍵・port・契約版は environment.ts の定数と同じ（二重の見張りがずれない）', () => {
    expect(extractConst('FAKE_17TRACK_KEY')).toContain(`"${E2E_FAKE_17TRACK_KEY}"`);
    expect(extractConst('FAKE_17TRACK_PORT')).toContain(`= ${E2E_FAKE_17TRACK_PORT};`);
    expect(new URL(E2E_FAKE_17TRACK_URL).port).toBe(String(E2E_FAKE_17TRACK_PORT));
    expect(serverSource).toContain('tests/fixtures/17track/v2.4.json');
  });

  it('手元の作り物の URL と鍵なら止める理由は無い', () => {
    expect(findUnsafe(SAFE_ENV)).toEqual([]);
  });

  it.each([
    ['本番の URL', 'https://api.17track.net/track/v2.4'],
    ['省略', undefined],
    ['空', ''],
    ['手元でない住所', 'http://192.168.0.10:4017/track/v2.4'],
    ['別の道', 'http://127.0.0.1:4017/track/v2.3'],
    ['別の道（登録の口）', 'http://127.0.0.1:4017/track/v2.4/register'],
    ['別の port', 'http://127.0.0.1:4018/track/v2.4'],
    ['URL 内の認証情報', 'http://user:pass@127.0.0.1:4017/track/v2.4'],
  ])('%s は理由に 17TRACK を挙げて止める', (_name, url) => {
    const problems = findUnsafe({ ...SAFE_ENV, TRACKING_17TRACK_BASE_URL: url });
    expect(problems.join('\n')).toContain('17TRACK');
  });

  it('作り物の鍵と違う鍵・鍵の省略も止め、鍵の値は理由に出さない', () => {
    const problems = findUnsafe({ ...SAFE_ENV, TRACKING_17TRACK_API_KEY: 'real-looking-key-value' });
    expect(problems.join('\n')).toContain('TRACKING_17TRACK_API_KEY');
    expect(problems.join('\n')).not.toContain('real-looking-key-value');
    expect(findUnsafe({ ...SAFE_ENV, TRACKING_17TRACK_API_KEY: undefined }).length).toBeGreaterThan(0);
  });

  it('URL の認証情報は理由に出さない', () => {
    const problems = findUnsafe({ ...SAFE_ENV, TRACKING_17TRACK_BASE_URL: 'http://secret-user:secret-pass@127.0.0.1:4017/track/v2.4' });
    expect(problems.join('\n')).not.toContain('secret-user');
    expect(problems.join('\n')).not.toContain('secret-pass');
  });
});

describe('作り物の 17TRACK を起こすか使い回すかの決め方', () => {
  const decide = (probe: unknown, contract: string): string =>
    runInNewContext(`${extract('decideFake')}\ndecideFake(probe, contract)`, { probe, contract }) as string;

  it('4017番が空いていれば起こす', () => {
    expect(decide({ kind: 'down' }, '17track-v2.4')).toBe('start');
  });

  it('作り物の印（契約版まで同じ）を返すものだけ使い回す', () => {
    expect(decide({ kind: 'up', fake: '17track-v2.4' }, '17track-v2.4')).toBe('reuse');
  });

  it('契約版が違う作り物・印の無いもの（別のプロセス）は止めずに失敗にする', () => {
    expect(decide({ kind: 'up', fake: '17track-v2.3' }, '17track-v2.4')).toBe('conflict');
    expect(decide({ kind: 'up', fake: null }, '17track-v2.4')).toBe('conflict');
  });
});

describe('直接の起動は、危険な 17TRACK の URL ならビルドや作り物の前に終了する', () => {
  jest.setTimeout(60_000);

  const run = (overrides: Record<string, string | undefined>) => {
    const workDir = mkdtempSync(path.join(tmpdir(), 'e2e-server-tracking-'));
    try {
      const env: Record<string, string | undefined> = { ...process.env, ...SAFE_ENV, E2E_STRICT: '0', E2E_DEV_SERVER: '0', ...overrides };
      for (const key of Object.keys(env)) {
        if (env[key] === undefined) delete env[key];
      }
      return spawnSync(process.execPath, [serverScript], { cwd: workDir, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 45_000 });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  };

  it.each([
    ['本番の URL', 'https://api.17track.net/track/v2.4'],
    ['省略', undefined],
    ['手元でない住所', 'http://192.168.0.10:4017/track/v2.4'],
    ['別の道', 'http://127.0.0.1:4017/track/v2.3'],
    ['URL 内の認証情報', 'http://user:pass@127.0.0.1:4017/track/v2.4'],
  ])('%s なら終了コード 1・stderr に 17TRACK・ready を出さない', (_name, url) => {
    const result = run({ TRACKING_17TRACK_BASE_URL: url });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('17TRACK');
    expect(result.stdout).not.toContain('[e2e-server] ready');
    expect(result.stderr).not.toContain('user:pass');
  });
});
