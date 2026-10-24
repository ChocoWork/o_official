/**
 * ホーム `/` のヒーローの区画（SCR-HOME-002）を、ページ本体 `Home` を描いて確かめる結合テスト。
 * 取得の関数と範囲外の格子の部品は差し替え、ヒーローの写真・重ね・ブランド名・SCROLL の印を実物の部品で描く。
 */
import React from 'react';
import ReactDOM from 'react-dom';
import { render, screen, within } from '@testing-library/react';
import Home from '@/app/page';

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const { src, alt, className, sizes, priority, width, height } = props;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src as string}
        alt={alt as string}
        className={className as string}
        sizes={sizes as string}
        width={width as number}
        height={height as number}
        data-priority={priority ? 'true' : 'false'}
      />
    );
  },
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock('@/lib/items/public', () => ({
  getPublishedItems: jest.fn().mockResolvedValue([]),
  getPublishedItemsCount: jest.fn().mockResolvedValue(0),
}));
jest.mock('@/lib/look/server', () => ({
  getPublishedLooks: jest.fn().mockResolvedValue([]),
  getPublishedLooksCount: jest.fn().mockResolvedValue(0),
}));
jest.mock('@/features/news/services/public', () => ({
  getPublishedNews: jest.fn().mockResolvedValue([]),
  getPublishedNewsCount: jest.fn().mockResolvedValue(0),
}));
jest.mock('@/features/stockist/services/public', () => ({
  getHomePublicStockists: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/features/items/components/PublicItemGrid', () => ({
  PublicItemGrid: () => <div data-testid="stub-item-grid" />,
}));
jest.mock('@/features/look/components/PublicLookGrid', () => ({
  PublicLookGrid: () => <div data-testid="stub-look-grid" />,
}));
jest.mock('@/features/news/components/PublicNewsGrid', () => ({
  PublicNewsGrid: () => <div data-testid="stub-news-grid" />,
}));
jest.mock('@/features/stockist/components/PublicStockistGrid', () => ({
  PublicStockistGrid: () => <div data-testid="stub-stockist-grid" />,
}));
jest.mock('@/features/search/components/SearchHomePreview', () => ({
  SearchHomePreview: () => null,
}));

function setObserver(value: unknown): void {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = value;
}

const BRAND_NAME = 'Le Fil des Heures';
const NBSP = '\u00a0';

type IntersectionCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

class ControlledIntersectionObserver {
  static instances: ControlledIntersectionObserver[] = [];
  readonly callback: IntersectionCallback;
  constructor(callback: IntersectionCallback) {
    this.callback = callback;
    ControlledIntersectionObserver.instances.push(this);
  }
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
}

function installMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: jest.fn().mockImplementation(() => ({
      matches,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })),
  });
}

async function renderHome(): Promise<{ hero: HTMLElement }> {
  const ui = await Home();
  const { container } = render(ui);
  const hero = container.querySelector('section');
  if (!hero) {
    throw new Error('hero section not found');
  }
  return { hero };
}

describe('ホームのヒーローの区画', () => {
  const originalObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  let preloadSpy: jest.SpyInstance;

  beforeEach(() => {
    ControlledIntersectionObserver.instances = [];
    setObserver(ControlledIntersectionObserver);
    installMatchMedia(false);
    preloadSpy = jest.spyOn(ReactDOM, 'preload').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setObserver(originalObserver);
    jest.restoreAllMocks();
  });

  it('SCR-HOME-002 区画は画面の見える高さいっぱいで、上にヘッダーの余白を取って中央寄せにし、ページの最初に置く', async () => {
    const { hero } = await renderHome();

    expect(hero).toHaveClass('min-h-svh', 'w-full', 'flex', 'items-center', 'justify-center', 'pt-20');
    expect(hero).toHaveClass('relative', 'bg-white');
    expect(hero.previousElementSibling).toBeNull();
  });

  it('SCR-HOME-002 写真は /mainphoto.png を不透明度 90% で敷き、優先の印と幅 1024px 未満の画像の選び方を付ける', async () => {
    const { hero } = await renderHome();

    const photo = within(hero).getByRole('img');
    expect(photo).toHaveAttribute('src', '/mainphoto.png');
    expect(photo).toHaveClass('image', 'opacity-90');
    expect(photo).toHaveAttribute('data-priority', 'true');
    expect(photo).toHaveAttribute('sizes', '(max-width: 1023px) 300vw, 100vw');
    expect(photo).toHaveAttribute('width', '2752');
    expect(photo).toHaveAttribute('height', '1536');
  });

  it('SCR-HOME-002 写真の代替テキストはニュートラルな日常着のメインビジュアルを説明する文にする', async () => {
    await renderHome();

    expect(
      screen.getByRole('img', {
        name: 'ニュートラルな日常着をまとう Le Fil des Heures のメインビジュアル',
      }),
    ).toBeInTheDocument();
  });

  it('SCR-HOME-002 写真の上に黒 40% から透明を経て黒 60% になる縦の階調の重ねを敷き、読み上げから隠す', async () => {
    const { hero } = await renderHome();

    const overlay = hero.querySelector('[aria-hidden="true"].absolute.inset-0');
    expect(overlay).not.toBeNull();
    expect(overlay).toHaveClass('bg-linear-to-b', 'from-black/40', 'via-transparent', 'to-black/60');
    expect(overlay?.textContent).toBe('');
  });

  it('SCR-HOME-002 ブランド名は h1 の見出し1つで、名前の全体を読み上げに渡し、字は白にする', async () => {
    await renderHome();

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    const h1 = screen.getByRole('heading', { level: 1, name: BRAND_NAME });
    expect(h1).toHaveAttribute('aria-label', BRAND_NAME);
    expect(h1).toHaveClass('hero-title', 'text-white', 'tracking-tight');
  });

  it('SCR-HOME-002 ブランド名は1文字ずつの span に分け、どの span も読み上げの木から外し、始まりは 100ms 後で 30ms ずつ遅らせる', async () => {
    await renderHome();

    const h1 = screen.getByRole('heading', { level: 1 });
    const spans = Array.from(h1.children) as HTMLElement[];
    expect(spans).toHaveLength(BRAND_NAME.length);
    expect(spans.map((span) => span.textContent).join('')).toBe(BRAND_NAME.replace(/ /g, NBSP));
    for (const span of spans) {
      expect(span).toHaveAttribute('aria-hidden', 'true');
    }
    expect(spans[0].style.transition).toContain('100ms');
    expect(spans[1].style.transition).toContain('130ms');
    expect(spans[spans.length - 1].style.transition).toContain(`${100 + (spans.length - 1) * 30}ms`);
  });

  it('SCR-HOME-002 SCROLL の印は下の中央に字と細い縦線を縦に並べ、まとめて読み上げから隠す', async () => {
    const { hero } = await renderHome();

    const label = within(hero).getByText('SCROLL');
    const mark = label.parentElement as HTMLElement;
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveClass('absolute', 'left-1/2', '-translate-x-1/2', 'flex', 'flex-col', 'items-center', 'gap-2');
    expect(mark).toHaveClass('bottom-6.5', 'sm:bottom-8.5');
    expect(label).toHaveClass('hero-scroll-label', 'font-brand', 'text-white/90', 'tracking-[0.3em]');
    expect(label.style.fontSize).toBe('var(--lk-size-4xs)');
    expect(screen.queryByRole('link', { name: /SCROLL/ })).toBeNull();
  });

  it('SCR-HOME-002 縦線は SCROLL の字の下に白 90% の幅 1px の線として置き、繰り返しの動きはクラスで当てる', async () => {
    const { hero } = await renderHome();

    const line = hero.querySelector('.hero-thread');
    expect(line).not.toBeNull();
    expect(line).toHaveClass('block', 'h-8.5', 'w-px', 'bg-white/90');
    expect(line?.previousElementSibling).toBe(within(hero).getByText('SCROLL'));
    expect(line?.getAttribute('style')).toBeNull();
  });

  it('SCR-HOME-002 ヒーローにはコンセプトの文・CTA のボタン・リンクを置かない', async () => {
    const { hero } = await renderHome();

    expect(within(hero).queryAllByRole('link')).toHaveLength(0);
    expect(within(hero).queryAllByRole('button')).toHaveLength(0);
    expect(hero.querySelectorAll('p')).toHaveLength(0);
  });

  it('SCR-HOME-002 メインの写真を先読みの指定で1回だけ前もって取らせる', async () => {
    await renderHome();

    expect(preloadSpy).toHaveBeenCalledTimes(1);
    expect(preloadSpy).toHaveBeenCalledWith('/mainphoto.png', { as: 'image' });
  });
});
