/**
 * ABOUT `/about` の題・説明・OG（ARC-ABOUT-003）を、ページの metadata の関数と共有の layout の `metadataBase` をつないで確かめる結合テスト。
 * 共有の layout は実物を読み、フォントと Providers だけ差し替える。サイトの URL は環境変数だけで決まることを確かめる（環境変数が無い時の起点は SEC-ABOUT-007 の判断待ちなので固めない）。
 */
import React from 'react';
import type { Metadata } from 'next';

jest.mock('next/font/google', () => ({
  Geist: () => ({ variable: 'geist-sans' }),
  Geist_Mono: () => ({ variable: 'geist-mono' }),
}));
jest.mock('@/contexts/Providers', () => ({
  Providers: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const SITE_ENV_KEYS = [
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_BASE_URL',
  'BASE_URL',
  'NEXT_PUBLIC_VERCEL_URL',
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of SITE_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of SITE_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** ページの metadata の関数と layout の metadata を、環境変数を反映した新しい読み込みで取り出す。 */
function loadModules(): { page: typeof import('@/app/about/page'); layoutMetadata: Metadata } {
  let page!: typeof import('@/app/about/page');
  let layoutMetadata!: Metadata;
  jest.isolateModules(() => {
    page = require('@/app/about/page');
    layoutMetadata = require('@/app/layout').metadata;
  });
  return { page, layoutMetadata };
}

/** Next が metadataBase を起点に相対の道を絶対の URL にするのと同じ解決。 */
function resolveImage(image: unknown, base: Metadata['metadataBase']): string {
  if (typeof image !== 'string') throw new Error('OG の画像は文字列の道で書く');
  return new URL(image, base ?? undefined).href;
}

describe('ABOUT の題・説明・OG（ARC-ABOUT-003）', () => {
  it('ARC-ABOUT-003 題は layout の題を上書きする「ABOUT | Le Fil des Heures」で、OG の題も同じ', async () => {
    const { page, layoutMetadata } = loadModules();
    const metadata = await page.generateMetadata();
    expect(metadata.title).toBe('ABOUT | Le Fil des Heures');
    expect(metadata.title).not.toBe(layoutMetadata.title);
    expect(metadata.openGraph?.title).toBe(metadata.title);
  });

  it('ARC-ABOUT-003 説明はブランドの哲学と主な特徴を書き、OG の説明は説明より短い別の一文', async () => {
    const { page } = loadModules();
    const metadata = await page.generateMetadata();
    const description = metadata.description ?? '';
    const ogDescription = metadata.openGraph?.description ?? '';
    expect(description).toContain('Le Fil des Heures');
    for (const feature of ['天然繊維', '国内生産', '受注生産', 'タイムレス', 'ユニセックス']) {
      expect(description).toContain(feature);
    }
    expect(ogDescription).toContain('Le Fil des Heures');
    expect(ogDescription.length).toBeGreaterThan(0);
    expect(ogDescription.length).toBeLessThan(description.length);
    expect(ogDescription).not.toBe(description);
  });

  it('ARC-ABOUT-003 呼ぶたびに同じ固定の値を返し、環境変数が変わっても値は変わらない', async () => {
    const { page } = loadModules();
    const first = await page.generateMetadata();
    process.env.NEXT_PUBLIC_SITE_URL = 'https://other.example.com';
    const second = await page.generateMetadata();
    expect(second).toEqual(first);
  });

  it('ARC-ABOUT-003 OG の画像は /about.png の1枚だけで、相対の道で書く（外のオリジンを指さない）', async () => {
    const { page } = loadModules();
    const metadata = await page.generateMetadata();
    expect(metadata.openGraph?.images).toEqual(['/about.png']);
  });

  it('ARC-ABOUT-003 canonical・og:url・og:type・twitter のカードは返さない', async () => {
    const { page } = loadModules();
    const metadata = await page.generateMetadata();
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.twitter).toBeUndefined();
    expect(metadata.openGraph).not.toHaveProperty('url');
    expect(metadata.openGraph).not.toHaveProperty('type');
  });

  it('ARC-ABOUT-003 ページの側は metadataBase を持たず、起点は共有の layout に任せる', async () => {
    const { page } = loadModules();
    const metadata = await page.generateMetadata();
    expect(metadata.metadataBase).toBeUndefined();
  });
});

describe('ABOUT の OG の絶対の URL の起点（ARC-ABOUT-003）', () => {
  it('ARC-ABOUT-003 サイトの URL の環境変数があれば、OG の画像はその起点の /about.png になる', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://shop.example.com';
    const { page, layoutMetadata } = loadModules();
    const metadata = await page.generateMetadata();
    const image = (metadata.openGraph?.images as string[])[0];
    expect(resolveImage(image, layoutMetadata.metadataBase)).toBe('https://shop.example.com/about.png');
  });

  it('ARC-ABOUT-003 起点は環境変数だけから作り、要求の Host の見出しを受け取らない（metadata の関数は引数が0個）', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://shop.example.com';
    const { page, layoutMetadata } = loadModules();
    expect(page.generateMetadata).toHaveLength(0);
    const metadata = await page.generateMetadata();
    const image = (metadata.openGraph?.images as string[])[0];
    expect(resolveImage(image, layoutMetadata.metadataBase)).toBe('https://shop.example.com/about.png');
  });
});
