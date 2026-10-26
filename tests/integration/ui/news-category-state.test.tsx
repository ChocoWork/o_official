import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';
import type { PublicNewsArticle } from '@/features/news/types';

const pushMock = jest.fn();
let currentQuery = '';

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/navigation', () => ({
  usePathname: () => '/news',
  useRouter: () => ({ push: (...args: unknown[]) => pushMock(...args) }),
  useSearchParams: () => {
    const params = new URLSearchParams(currentQuery);
    return {
      get: (key: string) => params.get(key),
      toString: () => params.toString(),
    };
  },
}));

// 公開の取り出しは image_url を持たない（SEC-NEWS-005）。DB の形のまま型だけ合わせる
const ARTICLES = [
  { id: 'e1', title: 'Event one', published_date: '2026-10-03', category: 'EVENT', content: 'e' },
  { id: 's1', title: 'Store one', published_date: '2026-10-02', category: 'STORE', content: 's' },
  { id: 'c1', title: 'Collection one', published_date: '2026-10-01', category: 'COLLECTION', content: 'c' },
] as unknown as PublicNewsArticle[];

const CATEGORY_NAMES = ['ALL', 'COLLECTION', 'EVENT', 'COLLABORATION', 'SUSTAINABILITY', 'STORE', 'BLOG'];

function renderCatalog(query = '', initialCategory?: 'ALL' | 'EVENT') {
  currentQuery = query;
  return render(<PublicNewsGrid variant="catalog" articles={ARTICLES} initialCategory={initialCategory} />);
}

function checkedCategories(): string[] {
  const panel = within(screen.getByRole('complementary'));
  return CATEGORY_NAMES.filter((name) => (panel.getByRole('checkbox', { name }) as HTMLInputElement).checked);
}

function visibleTitles(): string[] {
  return screen.queryAllByRole('heading', { level: 2 }).map((node) => node.textContent ?? '');
}

async function toggle(name: string) {
  const user = userEvent.setup();
  await user.click(within(screen.getByRole('complementary')).getByRole('checkbox', { name }));
}

describe('STATE-NEWS-002 news category selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentQuery = '';
  });

  it('STATE-NEWS-002 URL に category が無い時は ALL だけを選び全部の記事を出す', () => {
    renderCatalog();

    expect(checkedCategories()).toEqual(['ALL']);
    expect(visibleTitles()).toEqual(['Event one', 'Store one', 'Collection one']);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('STATE-NEWS-002 URL の category はカンマで分け、大文字にし、正しい値だけを重複なく残す', () => {
    renderCatalog('category=event,%20store,EVENT,bogus');

    expect(checkedCategories()).toEqual(['EVENT', 'STORE']);
    expect(visibleTitles()).toEqual(['Event one', 'Store one']);
  });

  it('STATE-NEWS-002 URL の category が ALL を含む時は ALL だけにする', () => {
    renderCatalog('category=EVENT,all');

    expect(checkedCategories()).toEqual(['ALL']);
    expect(visibleTitles()).toHaveLength(3);
  });

  it('STATE-NEWS-002 URL の category に正しい値が1つも無い時は ALL にする', () => {
    renderCatalog('category=bogus,,');

    expect(checkedCategories()).toEqual(['ALL']);
  });

  it('STATE-NEWS-002 URL の category が空白だけの時は呼び元の初めの分類にする', () => {
    renderCatalog('category=%20', 'EVENT');

    expect(checkedCategories()).toEqual(['EVENT']);
    expect(visibleTitles()).toEqual(['Event one']);
  });

  it('STATE-NEWS-002 ALL から個別の分類を足すと ALL を外し、URL に書き戻す', async () => {
    renderCatalog('foo=1');

    await toggle('EVENT');

    expect(checkedCategories()).toEqual(['EVENT']);
    expect(visibleTitles()).toEqual(['Event one']);
    expect(pushMock).toHaveBeenLastCalledWith('/news?foo=1&category=EVENT', { scroll: false });
  });

  it('STATE-NEWS-002 個別の選択に分類を足すと両方を選び、URL にカンマでつないで書き戻す', async () => {
    renderCatalog('category=EVENT');

    await toggle('STORE');

    expect(checkedCategories()).toEqual(['EVENT', 'STORE']);
    expect(visibleTitles()).toEqual(['Event one', 'Store one']);
    expect(pushMock).toHaveBeenLastCalledWith('/news?category=EVENT%2CSTORE', { scroll: false });
  });

  it('STATE-NEWS-002 個別の選択から1つを外すと残りの個別の分類にする', async () => {
    renderCatalog('category=EVENT,STORE');

    await toggle('EVENT');

    expect(checkedCategories()).toEqual(['STORE']);
    expect(visibleTitles()).toEqual(['Store one']);
    expect(pushMock).toHaveBeenLastCalledWith('/news?category=STORE', { scroll: false });
  });

  it('STATE-NEWS-002 個別の選択に ALL を足すと ALL だけにし、URL から category を消す', async () => {
    renderCatalog('category=EVENT,STORE');

    await toggle('ALL');

    expect(checkedCategories()).toEqual(['ALL']);
    expect(visibleTitles()).toHaveLength(3);
    expect(pushMock).toHaveBeenLastCalledWith('/news', { scroll: false });
  });

  it('STATE-NEWS-002 個別の選択を全部外すと ALL に戻し、URL から category を消す', async () => {
    renderCatalog('category=EVENT');

    await toggle('EVENT');

    expect(checkedCategories()).toEqual(['ALL']);
    expect(visibleTitles()).toHaveLength(3);
    expect(pushMock).toHaveBeenLastCalledWith('/news', { scroll: false });
  });

  it('STATE-NEWS-002 ALL だけの時に ALL を外しても ALL のまま残す', async () => {
    renderCatalog();

    await toggle('ALL');

    expect(checkedCategories()).toEqual(['ALL']);
    expect(pushMock).toHaveBeenLastCalledWith('/news', { scroll: false });
  });

  it('STATE-NEWS-002 URL の category が変わると選択を URL に合わせ直す', () => {
    const view = renderCatalog('category=EVENT');
    expect(checkedCategories()).toEqual(['EVENT']);

    currentQuery = 'category=STORE';
    view.rerender(<PublicNewsGrid variant="catalog" articles={ARTICLES} />);

    expect(checkedCategories()).toEqual(['STORE']);
    expect(visibleTitles()).toEqual(['Store one']);

    currentQuery = '';
    view.rerender(<PublicNewsGrid variant="catalog" articles={ARTICLES} />);

    expect(checkedCategories()).toEqual(['ALL']);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('STATE-NEWS-002 ホームの区画は選択を持たず、URL の category でも絞らない', () => {
    currentQuery = 'category=EVENT';
    render(<PublicNewsGrid variant="home" articles={ARTICLES} />);

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'FILTER' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual([
      'Event one',
      'Store one',
      'Collection one',
    ]);
    expect(screen.getByRole('link', { name: /Event one/ })).toHaveAttribute('href', '/news/e1');
    expect(pushMock).not.toHaveBeenCalled();
  });
});
