/**
 * DD-AUTH-032 戻り先の確かめ（src/features/auth/return-intent/return-path.ts）の単体テスト。
 * 入口と出口の両方が通る 1 つの関数なので、URL パーサーとの食い違いで抜ける値を具体的な入力で確かめる。
 */
import {
  RETURN_PATH_MAX_LENGTH,
  isPrivilegedRole,
  sanitizeReturnPath,
  validateReturnPath,
  type ReturnPathRejectReason,
  type ReturnViewer,
} from '@/features/auth/return-intent/return-path';

const ORIGIN = 'http://localhost:3000';
const opts = { origin: ORIGIN };

type RejectCase = [input: string, reason: ReturnPathRejectReason];

const rejectCases: RejectCase[] = [
  ['//evil.example', 'not_relative'],
  ['/\\evil.example', 'forbidden_char'],
  ['/%2F%2Fevil.example', 'not_relative'],
  ['/%5Cevil.example', 'forbidden_char'],
  ['/%09/evil.example', 'forbidden_char'],
  ['/\t/evil.example', 'forbidden_char'],
  ['/\n/evil.example', 'forbidden_char'],
  ['/\r/evil.example', 'forbidden_char'],
  ['https:evil.example', 'not_relative'],
  ['javascript:alert(1)', 'not_relative'],
  ['data:text/html,x', 'not_relative'],
  ['evil.example', 'not_relative'],
  // デコードの後は「/」で始まる単一のスラッシュでも、元の値が「/」で始まらない物（%2F から始まる）は断る
  ['%2Fitem', 'not_relative'],
  ['', 'empty'],
  ['/ ', 'forbidden_char'],
  ['/@evil.example', 'not_allowed_path'],
  ['/item@evil.example', 'not_allowed_path'],
  ['/item/' + 'a'.repeat(600), 'too_long'],
  ['/login', 'excluded_path'],
  ['/login?next=/account', 'excluded_path'],
  ['/login/verify', 'excluded_path'],
  ['/register', 'excluded_path'],
  ['/auth/verified', 'excluded_path'],
  ['/auth/callback', 'excluded_path'],
  ['/auth/password-reset', 'excluded_path'],
  ['/api/x', 'excluded_path'],
  ['/api', 'excluded_path'],
  ['/api/auth/me', 'excluded_path'],
  ['/unknown', 'not_allowed_path'],
  ['/itemx', 'not_allowed_path'],
  ['/Item/3', 'not_allowed_path'],
  ['/items/3', 'not_allowed_path'],
  ['/foo/bar', 'not_allowed_path'],
  ['/item/%2e%2e/api/x', 'excluded_path'],
  ['/item/../api/x', 'excluded_path'],
  ['/item/%', 'decode_failed'],
  ['/item/%E0%A4%A', 'decode_failed'],
  [' /item', 'forbidden_char'],
  ['/item ', 'forbidden_char'],
  ['/item/‮', 'forbidden_char'],
  ['/item/​', 'forbidden_char'],
  // デコードの後に空白へ戻る値も断る（既定 / へ倒れる）。+ は空白の文字ではないので別の行で通す
  ['/search?q=black%20coat', 'forbidden_char'],
  ['/item/%E3%80%80', 'forbidden_char'],
];

const resolvedRejectCases = [
  '/.//evil.example',
  '/%2e//evil.example',
  '/a/..//evil.example',
  '/..//evil.example',
  '/item/..//evil.example',
];

const acceptCases = [
  '/',
  '/?a=1',
  '/item',
  '/search?q=a%2Fb',
  '/account',
  '/account/orders/abc/return',
  '/wishlist',
  '/cart',
  '/checkout',
  '/contact?topic=x',
  '/look',
  '/news',
  '/stockist',
  '/about',
  '/privacy',
];

describe('DD-AUTH-032 validateReturnPath: 断る値', () => {
  it.each(rejectCases)('DD-AUTH-032 %j は断る（%s）', (input, reason) => {
    expect(validateReturnPath(input, opts)).toEqual({ ok: false, reason });
  });

  it.each(resolvedRejectCases)('DD-AUTH-032 解釈の後に別の道筋へ変わる %j は断る', (input) => {
    const result = validateReturnPath(input, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['not_allowed_path', 'resolved_not_local']).toContain(result.reason);
    }
  });

  it.each([null, undefined, 123, {}, ['/item']])('DD-AUTH-032 文字列でない値 %j は empty', (input) => {
    expect(validateReturnPath(input, opts)).toEqual({ ok: false, reason: 'empty' });
  });

  it('DD-AUTH-032 長さの上限は 512 文字（ちょうどは通り、超えると too_long）', () => {
    const exact = '/item/' + 'a'.repeat(RETURN_PATH_MAX_LENGTH - '/item/'.length);
    expect(exact).toHaveLength(RETURN_PATH_MAX_LENGTH);
    expect(validateReturnPath(exact, opts)).toEqual({ ok: true, path: exact });
    expect(validateReturnPath(exact + 'a', opts)).toEqual({ ok: false, reason: 'too_long' });
  });

  it('DD-AUTH-032 解釈の後に 512 文字を超える値は too_long', () => {
    // 日本語の 1 文字はパーセントエンコードで 9 文字に伸びる
    const input = '/item/' + '日'.repeat(60);
    expect(input.length).toBeLessThan(RETURN_PATH_MAX_LENGTH);
    expect(validateReturnPath(input, opts)).toEqual({ ok: false, reason: 'too_long' });
  });
});

describe('DD-AUTH-032 validateReturnPath: 通す値', () => {
  it.each(acceptCases)('DD-AUTH-032 %j は入力と同じ形で通す', (input) => {
    expect(validateReturnPath(input, opts)).toEqual({ ok: true, path: input });
  });

  it('DD-AUTH-032 fragment は捨てる', () => {
    expect(validateReturnPath('/item/3?color=red#x', opts)).toEqual({ ok: true, path: '/item/3?color=red' });
  });

  it('DD-AUTH-032 日本語は解釈し直した形で返す', () => {
    expect(validateReturnPath('/item/日本語?q=あ', opts)).toEqual({
      ok: true,
      path: '/item/%E6%97%A5%E6%9C%AC%E8%AA%9E?q=%E3%81%82',
    });
  });

  it('DD-AUTH-032 二重のエンコードは 1 回のデコードの後も無害で、そのまま返る', () => {
    expect(validateReturnPath('/item/%252F%252Fevil', opts)).toEqual({ ok: true, path: '/item/%252F%252Fevil' });
  });

  it('DD-AUTH-032 + は空白の文字ではないので通る', () => {
    expect(validateReturnPath('/search?q=black+coat', opts)).toEqual({ ok: true, path: '/search?q=black+coat' });
  });
});

describe('DD-AUTH-032 validateReturnPath: /admin', () => {
  it.each(['/admin', '/admin/orders'])('DD-AUTH-032 入口（viewer なし）は %s を通す', (input) => {
    expect(validateReturnPath(input, opts)).toEqual({ ok: true, path: input });
  });

  const denied: ReturnViewer[] = [
    { role: 'user', aal: 'aal1' },
    { role: 'user', aal: 'aal2' },
    { role: 'admin', aal: 'aal1' },
    { role: 'supporter', aal: null },
  ];
  it.each(denied)('DD-AUTH-032 出口は %j に /admin を断る', (viewer) => {
    expect(validateReturnPath('/admin', { ...opts, viewer })).toEqual({
      ok: false,
      reason: 'admin_requires_privileged_aal2',
    });
  });

  const allowed: ReturnViewer[] = [
    { role: 'admin', aal: 'aal2' },
    { role: 'supporter', aal: 'aal2' },
  ];
  it.each(allowed)('DD-AUTH-032 出口は %j に /admin を通す', (viewer) => {
    expect(validateReturnPath('/admin', { ...opts, viewer })).toEqual({ ok: true, path: '/admin' });
  });

  it('DD-AUTH-032 /item/../admin は解釈した /admin として扱う（入口は通り、出口で一般の会員は断る）', () => {
    expect(validateReturnPath('/item/../admin', opts)).toEqual({ ok: true, path: '/admin' });
    expect(validateReturnPath('/item/../admin', { ...opts, viewer: { role: 'user', aal: 'aal2' } })).toEqual({
      ok: false,
      reason: 'admin_requires_privileged_aal2',
    });
  });

  it('DD-AUTH-032 viewer は /admin 以外の頁には影響しない', () => {
    expect(validateReturnPath('/account', { ...opts, viewer: { role: 'user', aal: 'aal1' } })).toEqual({
      ok: true,
      path: '/account',
    });
  });
});

describe('DD-AUTH-032 sanitizeReturnPath と補助', () => {
  it('DD-AUTH-032 外れたら既定の / を返す', () => {
    expect(sanitizeReturnPath('//evil.example', undefined, opts)).toBe('/');
  });

  it('DD-AUTH-032 fallback は確かめずにそのまま返す', () => {
    expect(sanitizeReturnPath('//evil.example', '/auth/verified', opts)).toBe('/auth/verified');
  });

  it('DD-AUTH-032 通る値は解釈した道筋を返す', () => {
    expect(sanitizeReturnPath('/item/3?color=red#x', '/', opts)).toBe('/item/3?color=red');
  });

  it('DD-AUTH-032 isPrivilegedRole は admin と supporter だけ真', () => {
    expect(isPrivilegedRole('admin')).toBe(true);
    expect(isPrivilegedRole('supporter')).toBe(true);
    expect(isPrivilegedRole('user')).toBe(false);
    expect(isPrivilegedRole(undefined)).toBe(false);
    expect(isPrivilegedRole('Admin')).toBe(false);
  });
});

describe('DD-AUTH-032 基準の origin', () => {
  const keys = ['NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_BASE_URL', 'BASE_URL', 'NEXT_PUBLIC_VERCEL_URL'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('DD-AUTH-032 origin を省略すると環境変数のサイトの origin を基準にする', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://shop.example';
    expect(validateReturnPath('/item/3')).toEqual({ ok: true, path: '/item/3' });
    expect(validateReturnPath('/item/3', { origin: 'https://shop.example' })).toEqual({ ok: true, path: '/item/3' });
  });

  it('DD-AUTH-032 基準の origin が読めない時は origin_mismatch', () => {
    expect(validateReturnPath('/item/3', { origin: 'not a url' })).toEqual({ ok: false, reason: 'origin_mismatch' });
  });
});

describe('DD-AUTH-032 不変条件', () => {
  const everyAccepted = [
    ...acceptCases,
    '/item/3?color=red#x',
    '/item/日本語?q=あ',
    '/item/%252F%252Fevil',
    '/search?q=black+coat',
    '/admin',
    '/admin/orders',
    '/item/../admin',
  ];

  it.each(everyAccepted)('DD-AUTH-032 通した %j の道筋は同じ origin に解釈され、//・/\\・# で始まらない', (input) => {
    const result = validateReturnPath(input, opts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new URL(result.path, ORIGIN).origin).toBe(ORIGIN);
    expect(result.path.startsWith('//')).toBe(false);
    expect(result.path.startsWith('/\\')).toBe(false);
    expect(result.path).not.toContain('#');
    expect(result.path.length).toBeLessThanOrEqual(RETURN_PATH_MAX_LENGTH);
  });

  it('DD-AUTH-032 例外を投げず、通した値は必ず同じ origin に解釈される（固定の seed の 1000 個）', () => {
    let seed = 20261025;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const alphabet = [
      '/', '/', '/', '\\', '%', '%2', 'F', '5', 'C', '0', '9', '.', '..', 'a', 'item', 'admin', 'api',
      '?', '#', '@', ':', ' ', '\t', '\n', '\u0000', '​', '日', 'e',
    ];
    const corpus: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const length = 1 + Math.floor(next() * 12);
      let value = next() < 0.6 ? '/' : '';
      for (let j = 0; j < length; j += 1) value += alphabet[Math.floor(next() * alphabet.length)];
      corpus.push(value);
    }

    const all = [...corpus, ...rejectCases.map(([input]) => input), ...resolvedRejectCases, ...everyAccepted];
    for (const value of all) {
      let result: ReturnType<typeof validateReturnPath> | undefined;
      expect(() => {
        result = validateReturnPath(value, opts);
      }).not.toThrow();
      if (result?.ok) {
        expect(new URL(result.path, ORIGIN).origin).toBe(ORIGIN);
        expect(result.path.startsWith('//')).toBe(false);
        expect(result.path).not.toContain('#');
        expect(/[\s\\]/.test(result.path)).toBe(false);
      }
    }
  });
});
