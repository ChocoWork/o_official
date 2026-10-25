/** @jest-environment node */
export {};

jest.mock('@/features/auth/return-intent/return-intent-store', () => {
  const actual = jest.requireActual('@/features/auth/return-intent/return-intent-store');
  return { ...actual, createReturnIntent: jest.fn(), consumeReturnIntent: jest.fn() };
});
jest.mock('@/lib/audit', () => ({ __esModule: true, default: jest.fn(), logAudit: jest.fn() }));

const store = require('@/features/auth/return-intent/return-intent-store');
const audit = require('@/lib/audit');
const {
  applyReturnIntentCookie,
  issueReturnIntent,
  readReturnIntentToken,
  resolveReturnDestination,
} = require('@/features/auth/return-intent/return-intent-service');

const ORIGIN = 'http://localhost:3000';
const TOKEN = 'A'.repeat(43);
const COOKIE = `sb-return-intent=${TOKEN}`;
const originalNodeEnv = process.env.NODE_ENV;

const user = { id: 'user-1', role: 'user' as const, aal: 'aal1' };
const adminAal1 = { id: 'admin-1', role: 'admin' as const, aal: 'aal1' };
const adminAal2 = { id: 'admin-1', role: 'admin' as const, aal: 'aal2' };

type TestViewer = { id: string; role: 'admin' | 'supporter' | 'user'; aal: string | null };
function resolve(viewer: TestViewer, cookieHeader: string | null = COOKIE, purpose: 'login' | 'signup' = 'login') {
  return resolveReturnDestination({ cookieHeader, purpose, viewer, origin: ORIGIN });
}

beforeEach(() => {
  jest.resetAllMocks();
  audit.default.mockResolvedValue(undefined);
});

afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
});

describe('DD-AUTH-034 issueReturnIntent', () => {
  it.each([[undefined], [null], ['']])('DD-AUTH-034 戻り先が %p なら clear・cleared で、保存も監査もしない', async (rawNext) => {
    const result = await issueReturnIntent({ rawNext, purpose: 'login', origin: ORIGIN });

    expect(result).toEqual({ action: { kind: 'clear' }, outcome: 'cleared' });
    expect(store.createReturnIntent).not.toHaveBeenCalled();
    expect(audit.default).not.toHaveBeenCalled();
  });

  it.each([
    ['//evil.example', 'not_relative'],
    ['/%09/evil.example', 'forbidden_char'],
    ['/login', 'excluded_path'],
    ['/api/x', 'excluded_path'],
  ])('DD-AUTH-034 確かめに外れる %s は clear・rejected で、監査には理由の符号だけを残す', async (rawNext, reason) => {
    const result = await issueReturnIntent({ rawNext, purpose: 'login', origin: ORIGIN });

    expect(result).toEqual({ action: { kind: 'clear' }, outcome: 'rejected' });
    expect(store.createReturnIntent).not.toHaveBeenCalled();
    expect(audit.default).toHaveBeenCalledTimes(1);
    expect(audit.default).toHaveBeenCalledWith({ action: 'auth.return_intent', outcome: 'rejected', detail: reason });
    expect(JSON.stringify(audit.default.mock.calls)).not.toContain('evil');
  });

  it('DD-AUTH-034 通った戻り先は fragment を捨てた道筋と用途を保存へ渡し、set・created を返す', async () => {
    store.createReturnIntent.mockResolvedValue({ token: TOKEN, maxAgeSeconds: 900 });

    const result = await issueReturnIntent({ rawNext: '/item/3?color=red#x', purpose: 'signup', origin: ORIGIN });

    expect(store.createReturnIntent).toHaveBeenCalledWith({ returnPath: '/item/3?color=red', purpose: 'signup' });
    expect(result).toEqual({ action: { kind: 'set', token: TOKEN, maxAgeSeconds: 900 }, outcome: 'created' });
    expect(audit.default).not.toHaveBeenCalled();
  });

  it('DD-AUTH-034 保存が null なら clear・failed で、監査は error', async () => {
    store.createReturnIntent.mockResolvedValue(null);

    const result = await issueReturnIntent({ rawNext: '/item/3', purpose: 'login', origin: ORIGIN });

    expect(result).toEqual({ action: { kind: 'clear' }, outcome: 'failed' });
    expect(audit.default).toHaveBeenCalledWith({ action: 'auth.return_intent', outcome: 'error', detail: 'create_failed' });
  });

  it('DD-AUTH-034 保存が投げても例外にならず clear・failed', async () => {
    store.createReturnIntent.mockRejectedValue(new Error('boom'));

    await expect(issueReturnIntent({ rawNext: '/item/3', purpose: 'login', origin: ORIGIN })).resolves.toEqual({
      action: { kind: 'clear' },
      outcome: 'failed',
    });
  });

  it('DD-AUTH-034 監査が投げても結果は変わらない（rejected・failed のまま）', async () => {
    audit.default.mockRejectedValue(new Error('audit down'));
    store.createReturnIntent.mockResolvedValue(null);

    await expect(issueReturnIntent({ rawNext: '//evil.example', purpose: 'login', origin: ORIGIN })).resolves.toEqual({
      action: { kind: 'clear' },
      outcome: 'rejected',
    });
    await expect(issueReturnIntent({ rawNext: '/item/3', purpose: 'login', origin: ORIGIN })).resolves.toEqual({
      action: { kind: 'clear' },
      outcome: 'failed',
    });
  });
});

describe('DD-AUTH-034 resolveReturnDestination', () => {
  it('DD-AUTH-034 一般の会員・番号あり・保存が /item/3 なら /item/3 へ行き、Cookie を消す', async () => {
    store.consumeReturnIntent.mockResolvedValue('/item/3');

    await expect(resolve(user)).resolves.toEqual({ path: '/item/3', needsMfa: false, action: { kind: 'clear' } });
    expect(store.consumeReturnIntent).toHaveBeenCalledWith({ token: TOKEN, purpose: 'login', userId: 'user-1' });
  });

  it('DD-AUTH-034 用途 signup をそのまま使い切りへ渡す', async () => {
    store.consumeReturnIntent.mockResolvedValue('/account');

    await resolve(user, COOKIE, 'signup');

    expect(store.consumeReturnIntent).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'signup' }));
  });

  it('DD-AUTH-034 Cookie の見出しに戻り先が無ければ既定の / と keep で、使い切りを呼ばない', async () => {
    for (const header of [null, '', 'other=1; sb-access-token=zzz']) {
      await expect(resolve(user, header)).resolves.toEqual({ path: '/', needsMfa: false, action: { kind: 'keep' } });
    }
    expect(store.consumeReturnIntent).not.toHaveBeenCalled();
  });

  it('DD-AUTH-034 番号がパターン外・名前の重複なら既定の / と clear で、使い切りを呼ばない', async () => {
    for (const header of ['sb-return-intent=short', `${COOKIE}; ${COOKIE}`, `sb-return-intent=${'*'.repeat(43)}`]) {
      await expect(resolve(user, header)).resolves.toEqual({ path: '/', needsMfa: false, action: { kind: 'clear' } });
    }
    expect(store.consumeReturnIntent).not.toHaveBeenCalled();
  });

  it('DD-AUTH-034 保存が null（期限切れ・使用済み・失敗）なら既定の / と clear', async () => {
    store.consumeReturnIntent.mockResolvedValue(null);

    await expect(resolve(user)).resolves.toEqual({ path: '/', needsMfa: false, action: { kind: 'clear' } });
  });

  it('DD-AUTH-034 管理者が aal1 なら /auth/verified・needsMfa・keep で、使い切りを呼ばない', async () => {
    await expect(resolve(adminAal1)).resolves.toEqual({
      path: '/auth/verified',
      needsMfa: true,
      action: { kind: 'keep' },
    });
    await expect(resolve({ ...adminAal1, role: 'supporter' as const, aal: null })).resolves.toEqual({
      path: '/auth/verified',
      needsMfa: true,
      action: { kind: 'keep' },
    });
    expect(store.consumeReturnIntent).not.toHaveBeenCalled();
  });

  it('DD-AUTH-034 管理者が aal2 なら保存の戻り先へ、無ければ /admin へ', async () => {
    store.consumeReturnIntent.mockResolvedValueOnce('/item/3');
    await expect(resolve(adminAal2)).resolves.toEqual({ path: '/item/3', needsMfa: false, action: { kind: 'clear' } });

    store.consumeReturnIntent.mockResolvedValueOnce(null);
    await expect(resolve(adminAal2)).resolves.toEqual({ path: '/admin', needsMfa: false, action: { kind: 'clear' } });

    await expect(resolve(adminAal2, null)).resolves.toEqual({ path: '/admin', needsMfa: false, action: { kind: 'keep' } });
  });

  it('DD-AUTH-034 管理者が aal2 で保存が /admin なら /admin', async () => {
    store.consumeReturnIntent.mockResolvedValue('/admin');

    await expect(resolve(adminAal2)).resolves.toEqual({ path: '/admin', needsMfa: false, action: { kind: 'clear' } });
  });

  it('DD-AUTH-034 一般の会員で保存が /admin（古い控え）なら出口の確かめで外れて /、監査は理由の符号だけ', async () => {
    store.consumeReturnIntent.mockResolvedValue('/admin');

    await expect(resolve(user)).resolves.toEqual({ path: '/', needsMfa: false, action: { kind: 'clear' } });
    expect(audit.default).toHaveBeenCalledWith({
      action: 'auth.return_intent',
      outcome: 'rejected',
      detail: 'admin_requires_privileged_aal2',
    });
  });

  it.each([
    ['//evil.example', 'not_relative'],
    ['/login', 'excluded_path'],
    ['/api/auth/me', 'excluded_path'],
    ['/%09/evil.example', 'forbidden_char'],
  ])('DD-AUTH-034 保存の値が改ざんされて %s を返しても出口の確かめで既定へ倒れる', async (tampered, reason) => {
    store.consumeReturnIntent.mockResolvedValue(tampered);

    await expect(resolve(user)).resolves.toEqual({ path: '/', needsMfa: false, action: { kind: 'clear' } });
    await expect(resolve(adminAal2)).resolves.toEqual({ path: '/admin', needsMfa: false, action: { kind: 'clear' } });
    expect(audit.default).toHaveBeenCalledWith({ action: 'auth.return_intent', outcome: 'rejected', detail: reason });
    expect(JSON.stringify(audit.default.mock.calls)).not.toContain('evil');
  });

  it('DD-AUTH-034 使い切りが投げても例外にならず既定と clear', async () => {
    store.consumeReturnIntent.mockRejectedValue(new Error('boom'));

    await expect(resolve(user)).resolves.toEqual({ path: '/', needsMfa: false, action: { kind: 'clear' } });
    await expect(resolve(adminAal2)).resolves.toEqual({ path: '/admin', needsMfa: false, action: { kind: 'clear' } });
  });

  it('DD-AUTH-034 監査が投げても例外にならず既定と clear', async () => {
    store.consumeReturnIntent.mockResolvedValue('//evil.example');
    audit.default.mockRejectedValue(new Error('audit down'));

    await expect(resolve(user)).resolves.toEqual({ path: '/', needsMfa: false, action: { kind: 'clear' } });
  });
});

describe('DD-AUTH-034 applyReturnIntentCookie', () => {
  function apply(action: unknown) {
    const set = jest.fn();
    applyReturnIntentCookie({ cookies: { set } }, action);
    return set;
  }

  it('DD-AUTH-034 set は名前 sb-return-intent・HttpOnly・SameSite=Lax・Path=/・Max-Age を付ける（本番は Secure）', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const prod = apply({ kind: 'set', token: TOKEN, maxAgeSeconds: 900 });
    expect(prod).toHaveBeenCalledWith({
      name: 'sb-return-intent',
      value: TOKEN,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 900,
    });

    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    const dev = apply({ kind: 'set', token: TOKEN, maxAgeSeconds: 3600 });
    expect(dev).toHaveBeenCalledWith(expect.objectContaining({ secure: false, maxAge: 3600, sameSite: 'lax' }));
  });

  it('DD-AUTH-034 clear は値が空で maxAge 0、同じ属性（HttpOnly・Lax・Path=/）で上書きする', () => {
    const set = apply({ kind: 'clear' });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sb-return-intent', value: '', maxAge: 0, httpOnly: true, sameSite: 'lax', path: '/' }),
    );
  });

  it('DD-AUTH-034 keep は cookies.set を呼ばない', () => {
    expect(apply({ kind: 'keep' })).not.toHaveBeenCalled();
  });
});

describe('DD-AUTH-034 readReturnIntentToken', () => {
  it('DD-AUTH-034 他の Cookie が混ざる見出しから番号を取れる', () => {
    expect(readReturnIntentToken(`a=1; ${COOKIE}; b=2`)).toBe(TOKEN);
    expect(readReturnIntentToken(`${COOKIE}`)).toBe(TOKEN);
  });

  it('DD-AUTH-034 無い・43 文字でない・文字種が違う・名前が重なるときは null', () => {
    expect(readReturnIntentToken(null)).toBeNull();
    expect(readReturnIntentToken('')).toBeNull();
    expect(readReturnIntentToken('a=1')).toBeNull();
    expect(readReturnIntentToken(`sb-return-intent=${'A'.repeat(42)}`)).toBeNull();
    expect(readReturnIntentToken(`sb-return-intent=${'A'.repeat(44)}`)).toBeNull();
    expect(readReturnIntentToken(`sb-return-intent=${'A'.repeat(42)}+`)).toBeNull();
    expect(readReturnIntentToken(`sb-return-intent=${'A'.repeat(42)}=`)).toBeNull();
    expect(readReturnIntentToken(`${COOKIE}; sb-return-intent=${'B'.repeat(43)}`)).toBeNull();
  });

  it('DD-AUTH-034 「=」を持たない断片が混ざる見出しでも、番号の Cookie だけを読む', () => {
    expect(readReturnIntentToken(`garbage; ${COOKIE}`)).toBe(TOKEN);
  });

  it('DD-AUTH-034 名前が似ているだけの Cookie は読まない', () => {
    expect(readReturnIntentToken(`x-sb-return-intent=${TOKEN}`)).toBeNull();
    expect(readReturnIntentToken(`sb-return-intent2=${TOKEN}`)).toBeNull();
  });
});
