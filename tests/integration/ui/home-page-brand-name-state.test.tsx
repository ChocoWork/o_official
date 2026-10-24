/**
 * ホーム `/` のブランド名の1文字ずつの出方（STATE-HOME-001: 隠れている・見えている）を、
 * ページ本体 `Home` を描き、画面に入る見張りと動きの設定を操作して確かめる結合テスト。
 * 取得の関数と範囲外の格子の部品は差し替え、ブランド名は実物の `TextReveal` で描く。
 */
import React from 'react';
import ReactDOM from 'react-dom';
import { act, render, screen } from '@testing-library/react';
import Home from '@/app/page';

jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
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
jest.mock('@/features/items/components/PublicItemGrid', () => ({ PublicItemGrid: () => null }));
jest.mock('@/features/look/components/PublicLookGrid', () => ({ PublicLookGrid: () => null }));
jest.mock('@/features/news/components/PublicNewsGrid', () => ({ PublicNewsGrid: () => null }));
jest.mock('@/features/stockist/components/PublicStockistGrid', () => ({
  PublicStockistGrid: () => null,
}));
jest.mock('@/features/search/components/SearchHomePreview', () => ({
  SearchHomePreview: () => null,
}));

// jsdom には MessageChannel が無く react-dom/server の読み込みが落ちる。
// renderToString は同期で描くので、何も送らない代用の物を置いてから読む
if (typeof globalThis.MessageChannel === 'undefined') {
  class InertMessageChannel {
    port1 = { onmessage: null, postMessage: () => undefined, close: () => undefined };
    port2 = { onmessage: null, postMessage: () => undefined, close: () => undefined };
  }
  (globalThis as { MessageChannel?: unknown }).MessageChannel = InertMessageChannel;
}
const { renderToString } = require('react-dom/server') as typeof import('react-dom/server');

const BRAND_NAME = 'Le Fil des Heures';

type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

class ControlledIntersectionObserver {
  static instances: ControlledIntersectionObserver[] = [];
  readonly callback: ObserverCallback;
  readonly options: unknown;
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  constructor(callback: ObserverCallback, options?: unknown) {
    this.callback = callback;
    this.options = options;
    ControlledIntersectionObserver.instances.push(this);
  }
}

type MotionQuery = {
  matches: boolean;
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
};

let motionQuery: MotionQuery;

function installMatchMedia(matches: boolean): void {
  motionQuery = { matches, addEventListener: jest.fn(), removeEventListener: jest.fn() };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: jest.fn().mockImplementation(() => motionQuery),
  });
}

function setObserver(value: unknown): void {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = value;
}

function lastObserver(): ControlledIntersectionObserver {
  const observer = ControlledIntersectionObserver.instances[ControlledIntersectionObserver.instances.length - 1];
  if (!observer) {
    throw new Error('observer not created');
  }
  return observer;
}

function enterScreen(): void {
  act(() => {
    lastObserver().callback([{ isIntersecting: true }]);
  });
}

function leaveScreen(): void {
  act(() => {
    lastObserver().callback([{ isIntersecting: false }]);
  });
}

function letters(): HTMLElement[] {
  return Array.from(screen.getByRole('heading', { level: 1 }).children) as HTMLElement[];
}

async function renderBrandName() {
  return render(await Home());
}

describe('ブランド名の1文字ずつの出方の状態', () => {
  const originalObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

  beforeEach(() => {
    ControlledIntersectionObserver.instances = [];
    setObserver(ControlledIntersectionObserver);
    installMatchMedia(false);
    jest.spyOn(ReactDOM, 'preload').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setObserver(originalObserver);
    jest.restoreAllMocks();
  });

  it('STATE-HOME-001 描いた直後は「隠れている」で、全部の文字が透明で自分の高さの分だけ下にずれている', async () => {
    await renderBrandName();

    const spans = letters();
    expect(spans).toHaveLength(BRAND_NAME.length);
    for (const span of spans) {
      expect(span.style.opacity).toBe('0');
      expect(span.style.transform).toBe('translateY(100%)');
    }
  });

  it('STATE-HOME-001 サーバーで描いた HTML も「隠れている」の形で届く', async () => {
    const html = renderToString(await Home());

    const heading = html.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? '';
    expect(heading.match(/opacity:0/g) ?? []).toHaveLength(BRAND_NAME.length);
    expect(heading).not.toContain('opacity:1');
    expect(heading).toContain('transform:translateY(100%)');
  });

  it('STATE-HOME-001 1割以上が画面に入った見張りの知らせで「見えている」へ移り、元の位置で不透明になる', async () => {
    await renderBrandName();

    expect(lastObserver().options).toEqual({ threshold: 0.1 });
    expect(lastObserver().observe).toHaveBeenCalledTimes(1);
    enterScreen();

    for (const span of letters()) {
      expect(span.style.opacity).toBe('1');
      expect(span.style.transform).toBe('translateY(0)');
    }
  });

  it('STATE-HOME-001 見張りが画面の外だと知らせている間は「隠れている」のままにする', async () => {
    await renderBrandName();
    leaveScreen();

    expect(letters().every((span) => span.style.opacity === '0')).toBe(true);
  });

  it('STATE-HOME-001 入った後は見張りをやめ、画面から出ても「見えている」のままにする', async () => {
    await renderBrandName();
    enterScreen();

    const observer = lastObserver();
    expect(observer.unobserve).toHaveBeenCalledTimes(1);
    leaveScreen();
    expect(letters().every((span) => span.style.opacity === '1')).toBe(true);
  });

  it('STATE-HOME-001 動きを減らす設定の時は、画面に入るのを待たず「見えている」で、移ろいが無い', async () => {
    installMatchMedia(true);
    await renderBrandName();

    for (const span of letters()) {
      expect(span.style.opacity).toBe('1');
      expect(span.style.transform).toBe('translateY(0)');
      expect(span.style.transition).toBe('none');
    }
  });

  it('STATE-HOME-001 動きを減らす設定が途中で変わると、それに合わせて「見えている」と移ろいの有無を変える', async () => {
    await renderBrandName();
    expect(letters().every((span) => span.style.opacity === '0')).toBe(true);
    expect(motionQuery.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    const onChange = motionQuery.addEventListener.mock.calls[0][1] as () => void;
    act(() => {
      motionQuery.matches = true;
      onChange();
    });
    expect(letters().every((span) => span.style.opacity === '1' && span.style.transition === 'none')).toBe(true);

    act(() => {
      motionQuery.matches = false;
      onChange();
    });
    expect(letters().every((span) => span.style.opacity === '0')).toBe(true);
  });

  it('STATE-HOME-001 どの状態でも読み上げには元の名前を渡し、1文字ずつの span は読み上げの木から外す', async () => {
    await renderBrandName();
    const heading = screen.getByRole('heading', { level: 1, name: BRAND_NAME });
    expect(heading).toHaveAttribute('aria-label', BRAND_NAME);
    expect(letters().every((span) => span.getAttribute('aria-hidden') === 'true')).toBe(true);

    enterScreen();
    expect(screen.getByRole('heading', { level: 1, name: BRAND_NAME })).toBe(heading);
    expect(letters().every((span) => span.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('STATE-HOME-001 部品が消える時に、見張りと動きの設定の購読をやめる', async () => {
    const { unmount } = await renderBrandName();
    const observer = lastObserver();

    unmount();

    expect(observer.disconnect).toHaveBeenCalled();
    expect(motionQuery.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

});
