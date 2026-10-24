/**
 * ABOUT の `/about` にかかる共有の proxy の結合テスト。
 *
 * proxy は本物を通し、`/about` の要求に付く守りの見出し・nonce の渡し方・
 * セッションの Cookie を見る。あわせて、ABOUT のページが守りの見出しを自分では
 * 重ねず、描く時の設定を共有の layout に任せていることを、ソースの字で見る。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
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

function aboutRequest(headers: Record<string, string> = {}, path = '/about') {
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

function readSource(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('ABOUT の頁にかかる共有の proxy', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.resetModules();
  });

  it('ARC-ABOUT-002 /about の応答に守りの見出しを付ける', async () => {
    const proxy = await loadProxy();

    const res = proxy(aboutRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('ARC-ABOUT-002 CSP は既定を全拒否にし、枠・フォーム・基点を自分の源に絞る', async () => {
    const proxy = await loadProxy();

    const csp = directives(proxy(aboutRequest()).headers.get('Content-Security-Policy'));

    expect(csp.get('default-src')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.has('upgrade-insecure-requests')).toBe(true);
  });

  it('ARC-ABOUT-002 script-src に nonce を入れ、本番では unsafe-eval を許さない', async () => {
    env().NODE_ENV = 'production';
    const proxy = await loadProxy();

    const res = proxy(aboutRequest());

    const scriptSrc = directives(res.headers.get('Content-Security-Policy')).get('script-src') ?? [];
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc.some((value) => /^'nonce-[0-9a-f]{24}'$/.test(value))).toBe(true);
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('ARC-ABOUT-002 応答の x-nonce は CSP の nonce と同じ値で、要求ごとに変わる', async () => {
    const proxy = await loadProxy();

    const first = proxy(aboutRequest());
    const second = proxy(aboutRequest());

    const nonceOf = (res: Response) => res.headers.get('x-nonce');
    expect(nonceOf(first)).toMatch(/^[0-9a-f]{24}$/);
    expect(first.headers.get('Content-Security-Policy')).toContain(`'nonce-${nonceOf(first)}'`);
    expect(nonceOf(first)).not.toBe(nonceOf(second));
    expect(first.headers.get('Content-Security-Policy')).not.toBe(
      second.headers.get('Content-Security-Policy'),
    );
  });

  it('ARC-ABOUT-002 nonce と CSP を頁へ渡す要求の見出しにも載せる', async () => {
    const proxy = await loadProxy();

    const res = proxy(aboutRequest());

    // NextResponse.next({ request: { headers } }) は上書きした見出しの名前をこの見出しに並べる
    const overridden = res.headers.get('x-middleware-override-headers') ?? '';
    expect(overridden.split(',')).toEqual(expect.arrayContaining(['content-security-policy', 'x-nonce']));
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(res.headers.get('x-nonce'));
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(
      res.headers.get('Content-Security-Policy'),
    );
  });

  it('ARC-ABOUT-002 セッションの Cookie が無い最初の要求で id を作り Set-Cookie で渡す', async () => {
    const proxy = await loadProxy();

    const res = proxy(aboutRequest());

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

  it('ARC-ABOUT-002 最初の要求ごとに違う id を作る', async () => {
    const proxy = await loadProxy();

    const first = proxy(aboutRequest()).cookies.get(SESSION_COOKIE)?.value;
    const second = proxy(aboutRequest()).cookies.get(SESSION_COOKIE)?.value;

    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it('ARC-ABOUT-002 本番では Cookie に Secure を付け、本番以外では付けない', async () => {
    env().NODE_ENV = 'production';
    const production = (await loadProxy())(aboutRequest());
    expect(production.cookies.get(SESSION_COOKIE)?.secure).toBe(true);

    jest.resetModules();
    env().NODE_ENV = 'test';
    const nonProduction = (await loadProxy())(aboutRequest());
    expect(nonProduction.cookies.get(SESSION_COOKIE)?.secure).toBeFalsy();
  });

  it('ARC-ABOUT-002 セッションの Cookie が既にある要求では Set-Cookie を付けない', async () => {
    const proxy = await loadProxy();

    const res = proxy(aboutRequest({ cookie: `${SESSION_COOKIE}=existing-session-id` }));

    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(res.headers.get('set-cookie')).toBeNull();
    // 既存の Cookie があっても守りの見出しは付く
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('ARC-ABOUT-002 ほかの Cookie だけがある要求ではセッションの id を作る', async () => {
    const proxy = await loadProxy();

    const res = proxy(aboutRequest({ cookie: 'cart=abc; wishlist=def' }));

    expect(res.cookies.get(SESSION_COOKIE)?.value).toMatch(/^[0-9a-f]{32}$/);
  });

  it('ARC-ABOUT-002 /about に付く見出しは別の頁（/news）と同じ', async () => {
    const proxy = await loadProxy();

    const about = proxy(aboutRequest());
    const news = proxy(aboutRequest({}, '/news'));

    for (const name of [
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Strict-Transport-Security',
      'Referrer-Policy',
      'Permissions-Policy',
    ]) {
      expect(about.headers.get(name)).toBe(news.headers.get(name));
    }
  });

  it('ARC-ABOUT-002 proxy の対象は全部の道で、ABOUT のページは守りの見出しを自分では重ねない', async () => {
    const mod = await import('@/proxy');
    // コメントに守りの見出しの名前を書いても落ちないよう、コメントを除いた字で見る
    const pageSource = readSource('src/app/about/page.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(mod.config.matcher).toEqual(['/:path*']);
    expect(pageSource).not.toMatch(
      /Content-Security-Policy|Strict-Transport-Security|X-Frame-Options|Set-Cookie|cookies\(\)|headers\(\)/i,
    );
  });
});
