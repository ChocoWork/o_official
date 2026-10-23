jest.mock('server-only', () => ({}), { virtual: true });

import { checkSiteUrlForEmail, isEmailOriginAllowed } from '@/lib/site-url-guard';
import { getSiteUrl } from '@/lib/redirect';

describe('メールのサイトの住所の確認', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([undefined, 'preview', 'development'])('本番以外は今の住所と localhost の既定値をそのまま通す (%s)', (deployment) => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'production', VERCEL_ENV: deployment });
    expect(checkSiteUrlForEmail().ok).toBe(true);
    expect(checkSiteUrlForEmail()).toEqual({ ok: true, origin: getSiteUrl() });
    expect(isEmailOriginAllowed('invalid')).toBe(true);
  });

  const rejected = [
    ['未設定', undefined], ['壊れた住所', 'http://'], ['http', 'http://shop.example.test'],
    ['localhost', 'https://localhost'], ['末尾の点', 'https://LOCALHOST.'],
    ['localhost の子', 'https://shop.localhost'], ['子と末尾の点', 'https://shop.localhost.'],
    ['IPv4', 'https://127.0.0.1'], ['IPv4 の範囲', 'https://127.255.1.2'],
    ['IPv4 の短縮', 'https://127.1'], ['IPv6', 'https://[::1]'],
    ['IPv6 の展開形', 'https://[0:0:0:0:0:0:0:1]'], ['全インターフェース', 'https://0.0.0.0'],
  ] as const;
  it.each(rejected)('本番は %s を固定の記号だけで断る', (_label, site) => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', VERCEL_ENV: 'production', NEXT_PUBLIC_SITE_URL: site });
    const logs = ['error', 'warn', 'log'] as const;
    const spies = logs.map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
    expect(checkSiteUrlForEmail()).toEqual({ ok: false, code: 'config_site_url' });
    expect(isEmailOriginAllowed(getSiteUrl())).toBe(false);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it.each(['https://shop.example.test', 'https://localhost.example.com', 'shop.example.test'])('本番の有効な https の住所を通す (case %#)', (site) => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', VERCEL_ENV: 'production', NEXT_PUBLIC_SITE_URL: site });
    expect(checkSiteUrlForEmail().ok).toBe(true);
  });

  it('本番の実際の origin は補完せず URL として検査する', () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', VERCEL_ENV: 'production' });
    expect(isEmailOriginAllowed('not-an-origin')).toBe(false);
  });

  it('IPv4 に似た外部のドメインは拒否しない', () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', VERCEL_ENV: 'production' });
    expect(isEmailOriginAllowed('https://127.example.com')).toBe(true);
  });
});
