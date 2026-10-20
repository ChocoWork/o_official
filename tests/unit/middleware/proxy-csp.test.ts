import { NextRequest } from 'next/server';

// 管理画面の写真は、署名つきのリンク（Supabase の置き場）を <img> で出す。CSP の img-src に、使っている Supabase の origin が要る。
// 本番は https://*.supabase.co に含まれるが、手元の Supabase（http://127.0.0.1:54321）は含まれない

describe('proxy の CSP の img-src', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    jest.resetModules();
  });

  /** Supabase の住所を決めて proxy を読み直し、答えの CSP の img-src の項目を返す */
  async function imgSources(supabaseUrl: string | null): Promise<string[]> {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    if (supabaseUrl !== null) process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
    jest.resetModules();
    const { proxy } = await import('@/proxy');
    const response = proxy(new NextRequest('https://shop.example.com/admin', { method: 'GET' }));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const directive = csp.split('; ').find((part) => part.startsWith('img-src '));
    return directive ? directive.slice('img-src '.length).split(' ') : [];
  }

  it('使っている Supabase の origin を許す。本番の *.supabase.co は許したままで、origin はその前に入る（connect-src と同じ並び）', async () => {
    const sources = await imgSources('http://127.0.0.1:54321');

    expect(sources).toContain('http://127.0.0.1:54321');
    expect(sources).toContain('https://*.supabase.co');
    expect(sources.indexOf('http://127.0.0.1:54321')).toBeLessThan(sources.indexOf('https://*.supabase.co'));
  });

  it('Supabase の住所が無い時は、空の項目を入れず、これまでの項目のままにする', async () => {
    const sources = await imgSources(null);

    expect(sources).not.toContain('');
    expect(sources).toEqual(expect.arrayContaining(["'self'", 'data:', 'https://*.supabase.co', 'https://*.stripe.com']));
  });
});
