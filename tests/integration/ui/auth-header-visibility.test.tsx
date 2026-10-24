import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import Header from '@/components/Header';

// 書く側（Header）を本物で描いて html の印を確かめる。印を読む側（CSS・他領域の部品）は
// ソースの字を読む確かめでは偽の合格が出るので、ここでは書かない。
jest.mock('next/navigation', () => ({
  usePathname: () => '/',
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

describe('ARC-AUTH-008 ヘッダーの出し隠しを html の印と変数で伝える', () => {
  beforeEach(() => {
    setScrollY(0);
    delete document.documentElement.dataset.headerVisible;
    document.documentElement.style.removeProperty('--site-header-offset');
  });

  it('ARC-AUTH-008 描いた直後に html の印へ true を書く', () => {
    render(<Header />);
    expect(document.documentElement.dataset.headerVisible).toBe('true');
    expect(document.documentElement.getAttribute('data-header-visible')).toBe('true');
  });

  it('ARC-AUTH-008 すでに下にいて描いた時は最初から false を書く', () => {
    setScrollY(120);
    render(<Header />);
    expect(document.documentElement.getAttribute('data-header-visible')).toBe('false');
  });

  it('ARC-AUTH-008 下へ動いて隠すと false、上へ動いて出すと true を html に書く', () => {
    render(<Header />);
    scrollTo(100);
    expect(document.documentElement.getAttribute('data-header-visible')).toBe('false');
    scrollTo(60);
    expect(document.documentElement.getAttribute('data-header-visible')).toBe('true');
  });

  it('ARC-AUTH-008 印には true か false の字だけを書く', () => {
    render(<Header />);
    const seen = new Set<string | null>();
    for (const position of [0, 100, 40, 200, 0]) {
      scrollTo(position);
      seen.add(document.documentElement.getAttribute('data-header-visible'));
    }
    expect([...seen].sort()).toEqual(['false', 'true']);
  });

  it.each([
    ['出ている', 0, 'true'],
    ['隠れている', 100, 'false'],
  ])('ARC-AUTH-008 ヘッダーが%s時の html は、読む側が使う data-header-visible の選択子に合う', (_state, position, value) => {
    render(<Header />);
    scrollTo(position);
    expect(document.documentElement.matches(`html[data-header-visible="${value}"]`)).toBe(true);
    expect(document.documentElement.matches(`html[data-header-visible="${value === 'true' ? 'false' : 'true'}"]`)).toBe(false);
  });

  it.todo('ARC-AUTH-008 CSS が印の true の時にヘッダーの高さを、false の時に 0 を --site-header-offset に入れる（計算後の CSS で確かめる手段が要る）');
  it.todo('ARC-AUTH-008 共有のレイアウトが html の初期値に data-header-visible="true" を持つ（レイアウトを描いて確かめる手段が要る）');
});
