/**
 * PRIVACY の `/privacy` にかかる共有の proxy（ARC-PRIVACY-002）の結合テスト。
 *
 * proxy は本物を通し、`/privacy` の要求に付く守りの見出し・nonce の渡し方・セッションの Cookie を見る。
 * proxy の対象が全部の道で、`/privacy` も外れないことを見る。
 */
import { NextRequest } from 'next/server';

// jsdom の Response には静的メソッド json() が無い。NextResponse が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const ORIGIN = 'https://shop.example.com';
const SESSION_COOKIE = 'session_id';
const THIRTY_DAYS = 60 * 60 * 24 * 30;
const env = () => process.env as Record<string, string | undefined>;

function privacyRequest(headers: Record<string, string> = {}, path = '/privacy') {
  return new NextRequest(`${ORIGIN}${path}`, { method: 'GET', headers });
}

async function loadProxy() {
  const mod = await import('@/proxy');
  return mod.proxy;
}

function directives(csp: string | null) {
  const map = new Map<string, string[]>();
  for (const part of (csp ?? '').split('; ')) {
    const [name, ...values] = part.split(' ');
    map.set(name, values);
  }
  return map;
}

describe('PRIVACY の頁にかかる共有の proxy', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.resetModules();
  });

  it('ARC-PRIVACY-002 /privacy の応答に枠の禁止・HSTS・nosniff・Referrer・Permissions の見出しを付ける', async () => {
    const proxy = await loadProxy();

    const res = proxy(privacyRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('ARC-PRIVACY-002 CSP は既定を全拒否にし、枠への埋め込み・フォーム・基点を絞る', async () => {
    const proxy = await loadProxy();

    const csp = directives(proxy(privacyRequest()).headers.get('Content-Security-Policy'));

    expect(csp.get('default-src')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.has('upgrade-insecure-requests')).toBe(true);
  });

  it('ARC-PRIVACY-002 script-src は自分の源と nonce を持ち、本番では unsafe-eval も unsafe-inline も許さない', async () => {
    env().NODE_ENV = 'production';
    const proxy = await loadProxy();

    const scriptSrc =
      directives(proxy(privacyRequest()).headers.get('Content-Security-Policy')).get('script-src') ?? [];

    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc.some((value) => /^'nonce-[0-9a-f]{24}'$/.test(value))).toBe(true);
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('ARC-PRIVACY-002 script-src は使っていない jsDelivr を許さず、Stripe.js と Turnstile は全頁で許す（Q29）', async () => {
    env().NODE_ENV = 'production';
    const proxy = await loadProxy();

    const scriptSrc =
      directives(proxy(privacyRequest()).headers.get('Content-Security-Policy')).get('script-src') ?? [];

    expect(scriptSrc).not.toContain('https://cdn.jsdelivr.net');
    expect(scriptSrc).toEqual(
      expect.arrayContaining([
        'https://js.stripe.com',
        'https://*.js.stripe.com',
        'https://challenges.cloudflare.com',
      ]),
    );
  });

  it('ARC-PRIVACY-002 応答の x-nonce は CSP の nonce と同じ値で、要求ごとに変わる', async () => {
    const proxy = await loadProxy();

    const first = proxy(privacyRequest());
    const second = proxy(privacyRequest());

    const nonceOf = (res: Response) => res.headers.get('x-nonce');
    expect(nonceOf(first)).toMatch(/^[0-9a-f]{24}$/);
    expect(first.headers.get('Content-Security-Policy')).toContain(`'nonce-${nonceOf(first)}'`);
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  it('ARC-PRIVACY-002 nonce と CSP を頁へ渡す要求の見出しにも載せる', async () => {
    const proxy = await loadProxy();

    const res = proxy(privacyRequest());

    const overridden = res.headers.get('x-middleware-override-headers') ?? '';
    expect(overridden.split(',')).toEqual(
      expect.arrayContaining(['content-security-policy', 'x-nonce']),
    );
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(res.headers.get('x-nonce'));
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(
      res.headers.get('Content-Security-Policy'),
    );
  });

  it('ARC-PRIVACY-002 /privacy ではセッションの Cookie を発行せず、守りの見出しは付く（SEC-PRIVACY-015。既定は配らない）', async () => {
    const proxy = await loadProxy();

    const res = proxy(privacyRequest());

    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('ARC-PRIVACY-002 許可リストの道（/cart）では、セッションの Cookie が無い閲覧者に id を作り Set-Cookie で渡す', async () => {
    const proxy = await loadProxy();

    const res = proxy(privacyRequest({}, '/cart'));

    const cookie = res.cookies.get(SESSION_COOKIE);
    expect(cookie?.value).toMatch(/^[0-9a-f]{32}$/);
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: THIRTY_DAYS,
    });
    expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=${cookie?.value}`);
  });

  it('ARC-PRIVACY-002 許可リストの道（/cart）では、本番で Cookie に Secure を付け、本番以外では付けない', async () => {
    env().NODE_ENV = 'production';
    const production = (await loadProxy())(privacyRequest({}, '/cart'));
    expect(production.cookies.get(SESSION_COOKIE)?.secure).toBe(true);

    jest.resetModules();
    env().NODE_ENV = 'test';
    const nonProduction = (await loadProxy())(privacyRequest({}, '/cart'));
    expect(nonProduction.cookies.get(SESSION_COOKIE)?.secure).toBeFalsy();
  });

  it('ARC-PRIVACY-002 セッションの Cookie が既にある閲覧者には Set-Cookie を付けないが、守りの見出しは付く', async () => {
    const proxy = await loadProxy();

    const res = proxy(privacyRequest({ cookie: `${SESSION_COOKIE}=existing-session-id` }));

    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('ARC-PRIVACY-002 /privacy に付く見出しは別の頁（/news）と同じ', async () => {
    const proxy = await loadProxy();

    const privacy = proxy(privacyRequest());
    const news = proxy(privacyRequest({}, '/news'));

    for (const name of [
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Strict-Transport-Security',
      'Referrer-Policy',
      'Permissions-Policy',
    ]) {
      expect(privacy.headers.get(name)).toBe(news.headers.get(name));
    }
  });

  it('ARC-PRIVACY-002 proxy は /privacy にキャッシュの指定を足さない', async () => {
    const proxy = await loadProxy();

    expect(proxy(privacyRequest()).headers.get('Cache-Control')).toBeNull();
  });

  it('ARC-PRIVACY-002 proxy の対象は全部の道で、/privacy も外れない', async () => {
    const mod = await import('@/proxy');

    expect(mod.config.matcher).toEqual(['/:path*']);
  });
});
