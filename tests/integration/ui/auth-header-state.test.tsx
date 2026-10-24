import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import Header from '@/components/Header';

// 状態の遷移は Header 本物にスクロールの値を流して確かめる。外との境目だけ偽物にする。
let mockPathname = '/';

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: false, userRole: null }),
}));

jest.mock('@/contexts/CartContext', () => ({
  useCart: () => ({ cartCount: 0 }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

jest.mock('@/components/LoginModal', () => ({
  __esModule: true,
  default: () => null,
}));

function setScrollY(value: number) {
  Object.defineProperty(window, 'scrollY', { value, configurable: true, writable: true });
}

function scrollTo(value: number) {
  act(() => {
    setScrollY(value);
    fireEvent.scroll(window);
  });
}

function renderHeader(path = '/') {
  mockPathname = path;
  const view = render(<Header />);
  const header = view.container.querySelector('header') as HTMLElement;
  const background = view.container.querySelector('[data-site-header-background]') as HTMLElement | null;
  return { ...view, header, background };
}

function isShown(header: HTMLElement) {
  return header.className.includes('translate-y-0') && !header.className.includes('-translate-y-full');
}

function isHidden(header: HTMLElement) {
  return header.className.includes('-translate-y-full');
}

describe('STATE-AUTH-005 ヘッダーの出し隠し', () => {
  beforeEach(() => {
    setScrollY(0);
    delete document.documentElement.dataset.headerVisible;
  });

  it('STATE-AUTH-005 ページの先頭（位置 0）で描いた直後はいつも出している', () => {
    const { header } = renderHeader();
    expect(isShown(header)).toBe(true);
    expect(document.documentElement.dataset.headerVisible).toBe('true');
  });

  it('STATE-AUTH-005 描いた直後に1回位置を見て、すでに下にいれば隠して始まる', () => {
    setScrollY(100);
    const { header } = renderHeader();
    expect(isHidden(header)).toBe(true);
    expect(document.documentElement.dataset.headerVisible).toBe('false');
  });

  it('STATE-AUTH-005 出している時に 50px より下で下へ動くと隠す', () => {
    const { header } = renderHeader();
    scrollTo(60);
    expect(isHidden(header)).toBe(true);
    expect(document.documentElement.dataset.headerVisible).toBe('false');
  });

  it('STATE-AUTH-005 下へ動いても位置が 50px ちょうどまでなら隠さない', () => {
    const { header } = renderHeader();
    scrollTo(30);
    expect(isShown(header)).toBe(true);
    scrollTo(50);
    expect(isShown(header)).toBe(true);
    scrollTo(51);
    expect(isHidden(header)).toBe(true);
  });

  it('STATE-AUTH-005 隠している時に上へ動くとすぐ出す', () => {
    const { header } = renderHeader();
    scrollTo(200);
    expect(isHidden(header)).toBe(true);
    scrollTo(190);
    expect(isShown(header)).toBe(true);
    expect(document.documentElement.dataset.headerVisible).toBe('true');
  });

  it('STATE-AUTH-005 隠している時に位置が 0 以下になったら出す', () => {
    const { header } = renderHeader();
    scrollTo(200);
    expect(isHidden(header)).toBe(true);
    scrollTo(0);
    expect(isShown(header)).toBe(true);
    scrollTo(-10);
    expect(isShown(header)).toBe(true);
    expect(document.documentElement.dataset.headerVisible).toBe('true');
  });

  it('STATE-AUTH-005 位置が変わらないスクロールは今の状態を変えない', () => {
    const { header } = renderHeader();
    scrollTo(100);
    expect(isHidden(header)).toBe(true);
    scrollTo(100);
    expect(isHidden(header)).toBe(true);

    scrollTo(80);
    expect(isShown(header)).toBe(true);
    scrollTo(80);
    expect(isShown(header)).toBe(true);
  });

  it('STATE-AUTH-005 隠してから上へ動いて出し、また下へ動くと隠す往復ができる', () => {
    const { header } = renderHeader();
    const steps: Array<[number, boolean]> = [
      [60, true],
      [120, true],
      [100, false],
      [160, true],
      [159, false],
      [0, false],
      [70, true],
    ];
    for (const [position, hidden] of steps) {
      scrollTo(position);
      expect(isHidden(header)).toBe(hidden);
      expect(document.documentElement.dataset.headerVisible).toBe(hidden ? 'false' : 'true');
    }
  });

  it('STATE-AUTH-005 隠す時は 300 ミリ秒かけて上へずらす', () => {
    const { header } = renderHeader();
    expect(header.className).toContain('transition-transform');
    expect(header.className).toContain('duration-300');
    scrollTo(100);
    expect(header.className).toContain('-translate-y-full');
  });

  it('STATE-AUTH-005 管理画面の白い地の板もヘッダーと一緒に同じ動きで出し隠す', () => {
    const { header, background } = renderHeader('/admin');
    expect(background).not.toBeNull();
    const panel = background as HTMLElement;
    expect(panel.className).toContain('duration-300');
    expect(panel.className).toContain('translate-y-0');

    scrollTo(60);
    expect(panel.className).toContain('-translate-y-full');
    expect(isHidden(header)).toBe(true);

    scrollTo(10);
    expect(panel.className).not.toContain('-translate-y-full');
    expect(panel.className).toContain('translate-y-0');
    expect(isShown(header)).toBe(true);
  });

  it('STATE-AUTH-005 管理画面でも公開のページと同じ位置で隠し、同じ位置で出す', () => {
    const { header } = renderHeader('/admin/orders');
    scrollTo(50);
    expect(isShown(header)).toBe(true);
    scrollTo(51);
    expect(isHidden(header)).toBe(true);
    scrollTo(0);
    expect(isShown(header)).toBe(true);
  });

  it('STATE-AUTH-005 状態を html の印にも書く', () => {
    renderHeader();
    scrollTo(100);
    expect(document.documentElement.dataset.headerVisible).toBe('false');
    expect(document.documentElement.getAttribute('data-header-visible')).toBe('false');
    scrollTo(90);
    expect(document.documentElement.getAttribute('data-header-visible')).toBe('true');
  });

  it('STATE-AUTH-005 外すとスクロールの監視を解き、以後の動きで状態を変えない', () => {
    const addSpy = jest.spyOn(window, 'addEventListener');
    const removeSpy = jest.spyOn(window, 'removeEventListener');
    const { unmount } = renderHeader();
    const added = addSpy.mock.calls.find(([type]) => type === 'scroll');
    expect(added).toBeDefined();
    expect(added?.[2]).toEqual({ passive: true });

    document.documentElement.dataset.headerVisible = 'true';
    unmount();
    const removed = removeSpy.mock.calls.find(([type]) => type === 'scroll');
    expect(removed?.[1]).toBe(added?.[1]);

    scrollTo(300);
    expect(document.documentElement.dataset.headerVisible).toBe('true');
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
