/**
 * ABOUT `/about` の画面（SCR-ABOUT-001）と、文を持つだけのページの作り（ARC-ABOUT-001）を、ページ本体 `StoryPage` を描いて確かめる結合テスト。
 * 共有の Button と next/link は実物を使い、next/link だけ a 要素に差し替える。DB・外のサービスは1つも差し替えない（読まない作りの確認が目的）。
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, within } from '@testing-library/react';
import StoryPage from '@/app/about/page';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const PAGE_PATH = path.join(process.cwd(), 'src', 'app', 'about', 'page.tsx');

function renderPage() {
  return render(<StoryPage />);
}

/** 区画は h2 を含む直近の「罫線つきの塊」。h2 から祖先をたどり、罫線（border-t）を持つ最初の要素を返す。 */
function sectionOf(heading: HTMLElement): HTMLElement {
  let node: HTMLElement | null = heading;
  while (node && !node.className.toString().includes('border-t')) {
    node = node.parentElement;
  }
  if (!node) throw new Error('罫線つきの区画が見つからない');
  return node;
}

describe('ABOUT の画面（SCR-ABOUT-001）', () => {
  it('SCR-ABOUT-001 h2 は Brand Philosophy・WHY WE MAKE・OUR COMMITMENTS・COLLECTION の4つで、この順に並ぶ', () => {
    renderPage();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'Brand Philosophy / ブランドの思想',
      'WHY WE MAKE / なぜ、つくるのか',
      'OUR COMMITMENTS / 取り組み',
      'COLLECTION / 商品設計思想',
    ]);
  });

  it('SCR-ABOUT-001 ブランドの思想の区画はブランド名の意味「時の糸」と「時を超えて価値の続く服」を3段落で述べる', () => {
    renderPage();
    const section = sectionOf(screen.getByRole('heading', { level: 2, name: /Brand Philosophy/ }));
    const paragraphs = within(section).getAllByText(/./, { selector: 'p' });
    expect(paragraphs).toHaveLength(3);
    expect(section).toHaveTextContent('「時の糸」を意味します');
    expect(section).toHaveTextContent('「時を超えて価値の続く服」');
  });

  it('SCR-ABOUT-001 服をつくる理由の区画は問題提起の1段落・創業者の引用2つ・署名の順に出す', () => {
    renderPage();
    const section = sectionOf(screen.getByRole('heading', { level: 2, name: /WHY WE MAKE/ }));
    const paragraphs = within(section).getAllByText(/./, { selector: 'p' });
    expect(paragraphs).toHaveLength(4);
    expect(paragraphs[0]).toHaveTextContent('低価格。大量生産。機能性。');
    expect(paragraphs[1].textContent).toMatch(/^「シルエットは良くても/);
    expect(paragraphs[2].textContent).toMatch(/^「形と生地にも妥協せず/);
    expect(paragraphs[3]).toHaveTextContent('— Founder, Le Fil des Heures');
  });

  it('SCR-ABOUT-001 創業者の引用は表示用の書体と広い行の間で、説明の本文と分ける', () => {
    renderPage();
    const quote = screen.getByText(/^「シルエットは良くても/);
    expect(quote).toHaveClass('font-display');
    expect(quote).toHaveStyle({ lineHeight: '1.9', fontSize: 'var(--lk-size-sm)' });
    const body = screen.getByText(/^低価格。大量生産。機能性。/);
    expect(body).toHaveClass('about-main-text');
    expect(body).not.toHaveClass('font-display');
  });

  it('SCR-ABOUT-001 取り組みの区画は3つの原則を番号 01〜03・英語のラベル・日本語の h3・説明の順に出す', () => {
    renderPage();
    const h3s = screen.getAllByRole('heading', { level: 3 });
    expect(h3s.map((h) => h.textContent)).toEqual([
      'タイムレス・ユニセックス',
      '天然繊維',
      '国内受注生産',
    ]);

    const expected = [
      { no: '01', en: 'TIMELESS / UNISEX', text: 'どの時代でも手に取りたくなる服を。' },
      { no: '02', en: 'NATURAL FIBERS', text: '生地は天然繊維を中心に。' },
      { no: '03', en: 'DOMESTIC, MADE TO ORDER', text: 'すべて、国内で受注生産。' },
    ];
    expected.forEach(({ no, en, text }, i) => {
      const row = h3s[i].parentElement as HTMLElement;
      const ps = within(row).getAllByText(/./, { selector: 'p' });
      expect(ps[0]).toHaveTextContent(en);
      expect(ps[1].textContent).toContain(text);
      // 番号は行の外側（親の grid）の先頭の p
      const numberCell = row.parentElement?.querySelector('p');
      expect(numberCell).toHaveTextContent(no);
    });
  });

  it('SCR-ABOUT-001 原則の行は最後の1つだけ下にも罫線（border-b）を引き、他は上の罫線だけにする', () => {
    renderPage();
    const rows = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.parentElement as HTMLElement);
    expect(rows).toHaveLength(3);
    rows.forEach((row, i) => {
      expect(row).toHaveClass('border-t', 'border-black/10');
      if (i === rows.length - 1) {
        expect(row).toHaveClass('border-b');
      } else {
        expect(row).not.toHaveClass('border-b');
      }
    });
  });

  it('SCR-ABOUT-001 取り組みの番号は表示用の書体で、640px 以上では右寄せの列に置く', () => {
    renderPage();
    const numbers = ['01', '02', '03'].map((n) => screen.getByText(n, { selector: 'p' }));
    numbers.forEach((el) => {
      expect(el).toHaveClass('font-display', 'sm:text-right');
      expect(el.parentElement).toHaveClass('grid-cols-1', 'sm:grid-cols-[64px_1fr]', 'lg:grid-cols-[88px_1fr]');
    });
  });

  it('SCR-ABOUT-001 商品設計の考え方の区画は1段落だけを出す', () => {
    renderPage();
    const section = sectionOf(screen.getByRole('heading', { level: 2, name: /COLLECTION/ }));
    const paragraphs = within(section).getAllByText(/./, { selector: 'p' });
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toHaveTextContent('毎日に寄り添うベーシックも、もちろんそろえています。');
  });

  it('SCR-ABOUT-001 締めの区画は見出しを持たず、一文「時を超えて価値の続く服を。」の後に CTA を2つ並べる', () => {
    renderPage();
    const tagline = screen.getByText('時を超えて価値の続く服を。');
    const closing = tagline.parentElement as HTMLElement;
    expect(within(closing).queryAllByRole('heading')).toHaveLength(0);
    expect(closing).toHaveClass('text-center');

    const links = within(closing).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['VIEW COLLECTION', 'VIEW LOOKBOOK']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/item', '/look']);
    // 一文は CTA より前
    expect(tagline.compareDocumentPosition(links[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('SCR-ABOUT-001 CTA は VIEW COLLECTION を primary、VIEW LOOKBOOK を secondary の中くらいの大きさで出す', () => {
    renderPage();
    const collection = screen.getByRole('link', { name: 'VIEW COLLECTION' });
    const lookbook = screen.getByRole('link', { name: 'VIEW LOOKBOOK' });
    expect(collection).toHaveAttribute('data-ui-button-variant', 'primary');
    expect(lookbook).toHaveAttribute('data-ui-button-variant', 'secondary');
    [collection, lookbook].forEach((a) => {
      expect(a).toHaveAttribute('data-ui-button-size', 'md');
      expect(a).toHaveClass('w-full', 'sm:w-auto');
    });
  });

  it('SCR-ABOUT-001 区画は5つで、どれも上に細い罫線（border-t border-black/10）を持つ', () => {
    const { container } = renderPage();
    const ruled = Array.from(container.querySelectorAll('div')).filter(
      (el) =>
        el.className.includes('border-t border-black/10') &&
        el.className.includes('pt-8.5') &&
        !el.className.includes('grid-cols'),
    );
    // 区画1・3・4・5は自身が罫線を持ち、区画2は内側の div が持つ
    expect(ruled).toHaveLength(5);
  });

  it('SCR-ABOUT-001 本文に画像・アイコンは無い', () => {
    const { container } = renderPage();
    expect(container.querySelectorAll('img, svg, picture, video, i')).toHaveLength(0);
  });

  it('SCR-ABOUT-001 区画1・2・4の並びは 1024px 以上で見出しと本文を 1:2 の2列、未満は1列に積む', () => {
    renderPage();
    for (const name of [/Brand Philosophy/, /WHY WE MAKE/, /COLLECTION/]) {
      const grid = screen.getByRole('heading', { level: 2, name }).parentElement as HTMLElement;
      expect(grid).toHaveClass('grid', 'grid-cols-1', 'lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]');
    }
  });

  it('SCR-ABOUT-001 文字の大きさは共有トークンを style で付け、h2 は 2xl、本文は xs にする', () => {
    renderPage();
    screen.getAllByRole('heading', { level: 2 }).forEach((h) => {
      expect(h).toHaveStyle({ fontSize: 'var(--lk-size-2xl)', letterSpacing: '0.08em' });
    });
    expect(screen.getByText(/^低価格。大量生産。機能性。/)).toHaveStyle({
      fontSize: 'var(--lk-size-xs)',
    });
    expect(screen.getByText('時を超えて価値の続く服を。')).toHaveStyle({
      fontSize: 'var(--lk-size-md)',
    });
  });

  it('SCR-ABOUT-001 外側は最大幅 6xl の中央寄せで、左右の余白を幅ごとに3段で持つ', () => {
    const { container } = renderPage();
    expect(container.firstElementChild).toHaveClass('max-w-6xl', 'mx-auto', 'px-1', 'sm:px-4', 'lg:px-8');
  });
});

describe('ABOUT のページの作り（ARC-ABOUT-001）', () => {
  it('ARC-ABOUT-001 ページは非同期でない普通の関数で、引数なしで描け、描く時にデータを読まない', () => {
    expect(StoryPage.constructor.name).toBe('Function');
    expect(StoryPage).toHaveLength(0);
    const element = StoryPage();
    expect(React.isValidElement(element)).toBe(true);
  });

  it('ARC-ABOUT-001 描く間に fetch を呼ばない', () => {
    const fetchSpy = jest.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      renderPage();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('ARC-ABOUT-001 Supabase の client と DB の部品を読み込まない（読むと失敗する差し替えを置いても読み込める）', () => {
    jest.isolateModules(() => {
      jest.doMock('@supabase/supabase-js', () => {
        throw new Error('ABOUT は supabase-js を読み込まない');
      });
      jest.doMock('@supabase/ssr', () => {
        throw new Error('ABOUT は @supabase/ssr を読み込まない');
      });
      jest.doMock('@/lib/supabase/server', () => {
        throw new Error('ABOUT は supabase の server を読み込まない');
      });
      jest.doMock('@/lib/supabase/client', () => {
        throw new Error('ABOUT は supabase の client を読み込まない');
      });
      const mod = require('@/app/about/page') as { default: () => React.ReactElement };
      expect(typeof mod.default).toBe('function');
      expect(React.isValidElement(mod.default())).toBe(true);
    });
  });

  it('ARC-ABOUT-001 ページのファイルはクライアント・サーバーの指定と fetch と Supabase の字を持たない', () => {
    // コメントに書いた語で落ちないよう、コメントを除いた字で見る
    const source = fs
      .readFileSync(PAGE_PATH, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/^\s*["']use client["']/m);
    expect(source).not.toMatch(/^\s*["']use server["']/m);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/supabase/i);
  });
});
