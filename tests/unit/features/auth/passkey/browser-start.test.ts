/**
 * DD-AUTH-053 パスキーのログインの始めの部品（src/features/auth/passkey/browser-start.ts）の単体テスト。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPasskeyAuthenticationStarter,
  resolveBrowserStartMode,
} from '@/features/auth/passkey/browser-start';

const good = {
  challenge_id: 'chal-1',
  options: { challenge: 'abc', rpId: 'localhost', userVerification: 'preferred' },
  expires_at: 1900000000,
};
const required = { ...good, options: { ...good.options, userVerification: 'required' } };

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('createPasskeyAuthenticationStarter: server', () => {
  const run = async (res: Response | Error) => {
    const fetchApp = jest.fn(async () => {
      if (res instanceof Error) throw res;
      return res;
    });
    const result = await createPasskeyAuthenticationStarter({ mode: 'server', fetchApp: fetchApp as never })();
    return { result, fetchApp };
  };

  it('DD-AUTH-053 窓口を1回 POST（same-origin）で呼び、応答を返す', async () => {
    const { result, fetchApp } = await run(json(200, required));
    expect(fetchApp).toHaveBeenCalledTimes(1);
    expect(fetchApp).toHaveBeenCalledWith('/api/auth/passkey/login/start', { method: 'POST', credentials: 'same-origin' });
    expect(result).toEqual({ ok: true, start: required });
  });

  it('DD-AUTH-053 429 は rate_limited で Retry-After を秒で返す', async () => {
    const { result } = await run(json(429, {}, { 'Retry-After': '300' }));
    expect(result).toEqual({ ok: false, reason: 'rate_limited', retryAfterSeconds: 300 });
  });

  it('DD-AUTH-053 429 で Retry-After が無い・数でない時は retryAfterSeconds を付けない', async () => {
    expect((await run(json(429, {}))).result).toEqual({ ok: false, reason: 'rate_limited' });
    expect((await run(json(429, {}, { 'Retry-After': 'soon' }))).result).toEqual({ ok: false, reason: 'rate_limited' });
  });

  it('DD-AUTH-053 Retry-After が 0 なら付けず、options が配列・文字列・無い応答は failed', async () => {
    expect((await run(json(429, {}, { 'Retry-After': '0' }))).result).toEqual({ ok: false, reason: 'rate_limited' });
    for (const options of [[], 'x', null]) {
      expect((await run(json(200, { ...good, options }))).result).toEqual({ ok: false, reason: 'failed' });
    }
  });

  it('DD-AUTH-053 fetchApp を渡さなければ global の fetch を呼ぶ', async () => {
    const original = global.fetch;
    const spy = jest.fn().mockResolvedValue(json(200, required));
    global.fetch = spy as never;
    try {
      const result = await createPasskeyAuthenticationStarter({ mode: 'server' })();
      expect(result).toEqual({ ok: true, start: required });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = original;
    }
  });

  it.each([503, 409, 502])('DD-AUTH-053 %i は unavailable', async (status) => {
    expect((await run(json(status, {}))).result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('DD-AUTH-053 ネットワークの誤り・ほかの状態・壊れた本文・形の違う 200 は failed', async () => {
    const failed = { ok: false, reason: 'failed' };
    expect((await run(new Error('net'))).result).toEqual(failed);
    expect((await run(json(500, {}))).result).toEqual(failed);
    expect((await run(new Response('not json', { status: 200 }))).result).toEqual(failed);
    expect((await run(json(200, { challenge_id: '', options: good.options, expires_at: 1 }))).result).toEqual(failed);
    expect((await run(json(200, { ...good, options: {} }))).result).toEqual(failed);
  });
});

describe('createPasskeyAuthenticationStarter: browser', () => {
  const make = (impl: jest.Mock) =>
    createPasskeyAuthenticationStarter({
      mode: 'browser',
      supabase: { auth: { passkey: { startAuthentication: impl } } },
    });

  it('DD-AUTH-053 captchaToken が無ければ GoTrue を呼ばず captcha_required', async () => {
    const impl = jest.fn();
    expect(await make(impl)()).toEqual({ ok: false, reason: 'captcha_required' });
    expect(await make(impl)({ captchaToken: '' })).toEqual({ ok: false, reason: 'captcha_required' });
    expect(impl).not.toHaveBeenCalled();
  });

  it('DD-AUTH-053 captchaToken つきで1回呼び、userVerification が preferred でも required にして返す', async () => {
    const impl = jest.fn().mockResolvedValue({ data: good, error: null });
    const result = await make(impl)({ captchaToken: 'tok' });
    expect(impl).toHaveBeenCalledTimes(1);
    expect(impl).toHaveBeenCalledWith({ options: { captchaToken: 'tok' } });
    expect(result).toEqual({ ok: true, start: required });
  });

  it('DD-AUTH-053 GoTrue の 429 は rate_limited、captcha の誤りは captcha_required、ほかは failed', async () => {
    const err = (error: object) => make(jest.fn().mockResolvedValue({ data: null, error }))({ captchaToken: 't' });
    expect(await err({ status: 429, message: 'x' })).toEqual({ ok: false, reason: 'rate_limited' });
    expect(await err({ status: 400, code: 'captcha_failed', message: 'x' })).toEqual({ ok: false, reason: 'captcha_required' });
    expect(await err({ status: 400, message: 'captcha verification process failed' })).toEqual({ ok: false, reason: 'captcha_required' });
    expect(await err({ status: 500, message: 'boom' })).toEqual({ ok: false, reason: 'failed' });
    expect(await err({ status: 500 })).toEqual({ ok: false, reason: 'failed' });
  });

  it('DD-AUTH-053 形の違う成功・投げられた誤り・supabase が無い時は failed（閉じる）', async () => {
    const failed = { ok: false, reason: 'failed' };
    const bad = make(jest.fn().mockResolvedValue({ data: { challenge_id: 'x' }, error: null }));
    expect(await bad({ captchaToken: 't' })).toEqual(failed);
    const nul = make(jest.fn().mockResolvedValue({ data: null, error: null }));
    expect(await nul({ captchaToken: 't' })).toEqual(failed);
    const thrown = make(jest.fn().mockRejectedValue(new Error('net')));
    expect(await thrown({ captchaToken: 't' })).toEqual(failed);
    expect(await createPasskeyAuthenticationStarter({ mode: 'browser' })({ captchaToken: 't' })).toEqual(failed);
  });
});

describe('resolveBrowserStartMode', () => {
  const original = process.env.NEXT_PUBLIC_PASSKEY_START_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_PASSKEY_START_MODE;
    else process.env.NEXT_PUBLIC_PASSKEY_START_MODE = original;
  });

  it('DD-AUTH-053 NEXT_PUBLIC_PASSKEY_START_MODE の値に従い、未設定は server', () => {
    delete process.env.NEXT_PUBLIC_PASSKEY_START_MODE;
    expect(resolveBrowserStartMode()).toBe('server');
    process.env.NEXT_PUBLIC_PASSKEY_START_MODE = 'browser';
    expect(resolveBrowserStartMode()).toBe('browser');
    process.env.NEXT_PUBLIC_PASSKEY_START_MODE = 'server';
    expect(resolveBrowserStartMode()).toBe('server');
  });
});

describe('browser-start.ts のソース', () => {
  const source = readFileSync(join(process.cwd(), 'src/features/auth/passkey/browser-start.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('DD-AUTH-053 import は passkey-start-mode だけで、node:・server-only・鍵の関数の部品を含まない', () => {
    const specifiers = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers).toEqual(['@/lib/auth/passkey-start-mode']);
    expect(code).not.toMatch(/node:|server-only|passkey-start-config|passkey-gotrue/);
  });

  it('DD-AUTH-053 ブラウザの束に埋め込まれるよう process.env.NEXT_PUBLIC_PASSKEY_START_MODE をそのままの形で読み、process.env 全体は渡さない', () => {
    expect(code).toContain('process.env.NEXT_PUBLIC_PASSKEY_START_MODE');
    const bareEnv = [...code.matchAll(/process\.env(?!\.NEXT_PUBLIC_PASSKEY_START_MODE\b)/g)];
    expect(bareEnv).toEqual([]);
  });
});
