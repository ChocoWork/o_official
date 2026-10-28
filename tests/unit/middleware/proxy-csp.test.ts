import { NextRequest } from 'next/server';

// CSP は、自分のプロジェクトの Supabase・Stripe（全頁）・Turnstile だけを許す。
// 使っていない CDN（jsDelivr）・外の画像のホスト（placehold.co・readdy.ai）・全 Supabase プロジェクト（*.supabase.co）は許さない。
// 管理画面の写真は署名つきのリンク（Supabase の置き場）を <img> で出すので、使っている Supabase の origin だけが img-src・connect-src に要る。
// 手元の Supabase（http://127.0.0.1:54321）も origin で通る。

describe('proxy の CSP', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    jest.resetModules();
  });

  type EnvOverrides = { publicUrl?: string | null; serverUrl?: string | null; nodeEnv?: string };

  /** 環境を決めて proxy を読み直し、答えの CSP を指令ごとの配列にして返す */
  async function cspFor(pathname: string, overrides: EnvOverrides = {}): Promise<Map<string, string[]>> {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    if (overrides.publicUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = overrides.publicUrl;
    if (overrides.serverUrl) process.env.SUPABASE_URL = overrides.serverUrl;
    (process.env as Record<string, string | undefined>).NODE_ENV = overrides.nodeEnv ?? 'production';
    jest.resetModules();
    const { proxy } = await import('@/proxy');
    const response = proxy(new NextRequest(`https://shop.example.com${pathname}`, { method: 'GET' }));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const map = new Map<string, string[]>();
    for (const part of csp.split('; ')) {
      const [name, ...values] = part.split(' ');
      map.set(name, values);
    }
    return map;
  }

  const PATHS = ['/', '/privacy', '/checkout', '/api/auth/login'];

  describe.each(PATHS)('%s', (pathname) => {
    it('DD-HOME-004 Stripe と Turnstile は全頁で同じ許可先に揃え、Stripe 公式の一覧に合わせる', async () => {
      const csp = await cspFor(pathname, { publicUrl: 'https://abc.supabase.co' });

      expect(csp.get('script-src')?.filter((v) => !v.startsWith("'nonce-"))).toEqual([
        "'self'",
        'https://challenges.cloudflare.com',
        'https://js.stripe.com',
        'https://*.js.stripe.com',
      ]);
      expect(csp.get('script-src')?.some((v) => /^'nonce-[0-9a-f]{24}'$/.test(v))).toBe(true);
      expect(csp.get('frame-src')).toEqual([
        'https://challenges.cloudflare.com',
        'https://js.stripe.com',
        'https://*.js.stripe.com',
        'https://hooks.stripe.com',
        'https://www.google.com',
        'https://maps.google.com',
      ]);
      expect(csp.get('connect-src')).toEqual([
        "'self'",
        'https://abc.supabase.co',
        'https://challenges.cloudflare.com',
        'https://api.stripe.com',
        'https://r.stripe.com',
        'https://m.stripe.network',
        'https://q.stripe.com',
      ]);
      expect(csp.get('img-src')).toEqual([
        "'self'",
        'data:',
        'https://abc.supabase.co',
        'https://q.stripe.com',
        'https://*.stripe.com',
      ]);
    });

    it('DD-HOME-004 style・font に外の CDN を許さず、style 要素は self だけに締める', async () => {
      const csp = await cspFor(pathname);

      expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
      expect(csp.get('style-src-elem')).toEqual(["'self'"]);
      expect(csp.get('font-src')).toEqual(["'self'"]);
    });

    it('DD-HOME-004 jsDelivr・placehold.co・readdy.ai・全 Supabase プロジェクトがどの指令にも無い', async () => {
      const csp = await cspFor(pathname, { publicUrl: 'https://abc.supabase.co' });
      const all = [...csp.values()].flat().join(' ');

      expect(all).not.toContain('jsdelivr');
      expect(all).not.toContain('placehold.co');
      expect(all).not.toContain('readdy.ai');
      expect(all).not.toContain('*.supabase.co');
    });
  });

  it('DD-HOME-004 使っている Supabase の origin を img-src と connect-src に入れる（手元の Supabase も通る）', async () => {
    const csp = await cspFor('/admin', { publicUrl: 'http://127.0.0.1:54321' });

    expect(csp.get('img-src')).toContain('http://127.0.0.1:54321');
    expect(csp.get('connect-src')).toContain('http://127.0.0.1:54321');
    expect(csp.get('img-src')).not.toContain('https://*.supabase.co');
  });

  it('DD-HOME-004 NEXT_PUBLIC_SUPABASE_URL が無く SUPABASE_URL だけの時は、その origin を使う', async () => {
    const csp = await cspFor('/admin', { serverUrl: 'https://server.supabase.co/rest/v1' });

    expect(csp.get('img-src')).toContain('https://server.supabase.co');
    expect(csp.get('connect-src')).toContain('https://server.supabase.co');
  });

  it('DD-HOME-004 NEXT_PUBLIC_SUPABASE_URL と SUPABASE_URL が両方ある時は NEXT_PUBLIC_SUPABASE_URL を使う', async () => {
    const csp = await cspFor('/admin', {
      publicUrl: 'https://public.supabase.co',
      serverUrl: 'https://server.supabase.co',
    });

    expect(csp.get('img-src')).toContain('https://public.supabase.co');
    expect(csp.get('img-src')).not.toContain('https://server.supabase.co');
  });

  it('DD-HOME-004 Supabase の住所が無い時は、空の項目を入れない', async () => {
    const csp = await cspFor('/admin');

    expect(csp.get('img-src')).not.toContain('');
    expect(csp.get('connect-src')).not.toContain('');
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'https://q.stripe.com', 'https://*.stripe.com']);
  });

  it('DD-HOME-004 本番の script-src に unsafe-eval を入れず、開発では入れる', async () => {
    const production = await cspFor('/', { nodeEnv: 'production' });
    const development = await cspFor('/', { nodeEnv: 'development' });

    expect(production.get('script-src')).not.toContain("'unsafe-eval'");
    expect(development.get('script-src')).toContain("'unsafe-eval'");
    expect(development.get('style-src-elem')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(development.get('connect-src')).toEqual(expect.arrayContaining(['ws:', 'wss:']));
  });
});
