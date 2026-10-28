/**
 * ホームの `/` にかかる共有の proxy の結合テスト。
 *
 * proxy は本物を通し、`/` の要求に付く CSP・守りの見出し・nonce の渡し方を見る。
 * あわせて、ホームが生の HTML を描かず、中身の文を字として描くことを、頁全体と
 * ホームの部品の描いた結果で見る。
 */
import React from 'react';
import { NextRequest } from 'next/server';
import { render, screen } from '@testing-library/react';
import Home from '@/app/page';
import TextReveal from '@/components/animations/TextReveal';
import { HomeSectionViewAll } from '@/features/home/components/HomeSectionViewAll';

// jsdom の Response には静的メソッド json() が無い。NextResponse が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const HOSTILE = '<img src=x onerror=alert(1)><script>alert(2)</script>';
const mockHostileItemName = '<img src=x onerror=alert(1)>';
const mockHostileNewsTitle = '<script>alert(2)</script>';

jest.mock('@/lib/items/public', () => ({
  getPublishedItems: jest.fn(async () => [
    { id: 1, name: mockHostileItemName, price: 1000, image_url: '/item.png', category: 'TOPS' },
  ]),
  getPublishedItemsCount: jest.fn(async () => 1),
}));
jest.mock('@/lib/look/server', () => ({
  getPublishedLooks: jest.fn(async () => []),
  getPublishedLooksCount: jest.fn(async () => 0),
}));
jest.mock('@/features/news/services/public', () => ({
  getPublishedNews: jest.fn(async () => [
    {
      id: '1',
      title: mockHostileNewsTitle,
      published_date: '2026-10-01',
      category: 'NEWS',
      content: 'body',
    },
  ]),
  getPublishedNewsCount: jest.fn(async () => 1),
}));
jest.mock('@/features/stockist/services/public', () => ({
  getHomePublicStockists: jest.fn(async () => []),
}));
jest.mock('@/features/look/components/PublicLookGrid', () => ({ PublicLookGrid: () => null }));
jest.mock('@/features/stockist/components/PublicStockistGrid', () => ({
  PublicStockistGrid: () => null,
}));
jest.mock('@/features/search/components/SearchHomePreview', () => ({ SearchHomePreview: () => null }));
jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) =>
    require('react').createElement('img', { src, alt }),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    require('react').createElement('a', { href, ...props }, children),
}));
jest.mock('react-dom', () => {
  const actual = jest.requireActual('react-dom');
  return { ...actual, __esModule: true, default: { ...actual, preload: jest.fn() } };
});

const ORIGIN = 'https://shop.example.com';
const env = () => process.env as Record<string, string | undefined>;

async function loadProxyModule() {
  return import('@/proxy');
}

function homeRequest(path = '/') {
  return new NextRequest(`${ORIGIN}${path}`, { method: 'GET' });
}

function directives(csp: string | null) {
  const map = new Map<string, string[]>();
  for (const part of (csp ?? '').split('; ')) {
    const [name, ...values] = part.split(' ');
    map.set(name, values);
  }
  return map;
}

describe('ARC-HOME-003 ホームの / にかかる共有の proxy', () => {
  const envBackup = { ...process.env };

  beforeAll(() => {
    // TextReveal は表示の検知と動きの設定を端末に問い合わせる。jsdom には無いので何もしない形で補う
    window.matchMedia = jest.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }));
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.resetModules();
  });

  describe('本番の設定', () => {
    beforeEach(() => {
      env().NODE_ENV = 'production';
      env().NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
      jest.resetModules();
    });

    it('ARC-HOME-003 proxy は全部の道を対象にし、/ にも効く', async () => {
      const { config } = await loadProxyModule();

      expect(config.matcher).toEqual(['/:path*']);
    });

    it('ARC-HOME-003 / の応答に守りの見出しを付け、frame-ancestors は none にする', async () => {
      const { proxy } = await loadProxyModule();

      const res = proxy(homeRequest());

      expect(res.status).toBe(200);
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Strict-Transport-Security')).toBe(
        'max-age=63072000; includeSubDomains; preload',
      );
      expect(res.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
      const csp = directives(res.headers.get('Content-Security-Policy'));
      expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
      expect(csp.get('default-src')).toEqual(["'none'"]);
      expect(csp.get('object-src')).toEqual(["'none'"]);
    });

    it('ARC-HOME-003 script-src は要求ごとの nonce だけで許し、unsafe-inline と unsafe-eval を含まない', async () => {
      const { proxy } = await loadProxyModule();

      const res = proxy(homeRequest());

      const script = directives(res.headers.get('Content-Security-Policy')).get('script-src') ?? [];
      const nonce = res.headers.get('x-nonce');
      expect(nonce).toMatch(/^[0-9a-f]{24}$/);
      expect(script).toContain(`'nonce-${nonce}'`);
      expect(script).not.toContain("'unsafe-inline'");
      expect(script).not.toContain("'unsafe-eval'");
    });

    it('ARC-HOME-003 nonce は応答ごとに変わる', async () => {
      const { proxy } = await loadProxyModule();

      const first = proxy(homeRequest());
      const second = proxy(homeRequest());

      expect(first.headers.get('x-nonce')).not.toBe(second.headers.get('x-nonce'));
      expect(first.headers.get('Content-Security-Policy')).not.toBe(
        second.headers.get('Content-Security-Policy'),
      );
    });

    it('ARC-HOME-003 style の属性だけ unsafe-inline で許し、style 要素と link 要素は self だけに締める（外の CDN は許さない）', async () => {
      const { proxy } = await loadProxyModule();

      const res = proxy(homeRequest());

      const csp = directives(res.headers.get('Content-Security-Policy'));
      expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
      expect(csp.get('style-src-elem')).toEqual(["'self'"]);
    });

    it('ARC-HOME-003 CSP と nonce を、ページを描く側へ渡す要求の見出しにも載せる', async () => {
      const { proxy } = await loadProxyModule();

      const res = proxy(homeRequest());

      const nonce = res.headers.get('x-nonce');
      const csp = res.headers.get('Content-Security-Policy');
      expect(res.headers.get('x-middleware-override-headers')).toEqual(
        expect.stringContaining('content-security-policy'),
      );
      expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
      expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
    });
  });

  describe('ホームは生の HTML を描かない', () => {
    it('ARC-HOME-003 ホームの頁全体を描いても、商品名・記事の題の HTML は要素にならず字として出る', async () => {
      const { container } = render(await Home());

      expect(container.querySelector('script, img[src="x"]')).toBeNull();
      expect(screen.getByText(mockHostileItemName)).toBeInTheDocument();
      expect(screen.getByText(mockHostileNewsTitle)).toBeInTheDocument();
      const withHandler = Array.from(container.querySelectorAll('*')).filter((el) =>
        el.getAttributeNames().some((name) => name.startsWith('on')),
      );
      expect(withHandler).toHaveLength(0);
      expect(container.querySelector('h1')).not.toBeNull();
    });

    it('ARC-HOME-003 TextReveal は HTML を含む文を1文字ずつの字として描き、要素にしない', async () => {
      const { container } = render(React.createElement(TextReveal, { as: 'h1', text: HOSTILE }));

      expect(container.querySelector('img, script')).toBeNull();
      expect(container.querySelectorAll('span')).toHaveLength(HOSTILE.length);
      // 空白は改行されない空白に置き換えて描かれる
      expect(container.querySelector('h1')?.textContent?.replace(/\u00a0/g, ' ')).toBe(HOSTILE);
      expect(container.querySelector('h1')?.getAttribute('aria-label')).toBe(HOSTILE);
    });

    it('ARC-HOME-003 HomeSectionViewAll は名前に HTML があっても属性の中の字として描く', async () => {
      const { container } = render(
        React.createElement(HomeSectionViewAll, { href: '/item', ariaLabel: HOSTILE }),
      );

      expect(container.querySelector('img, script')).toBeNull();
      expect(container.querySelector('a')?.getAttribute('aria-label')).toBe(HOSTILE);
    });
  });
});
