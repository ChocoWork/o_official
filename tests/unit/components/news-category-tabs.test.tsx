import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { NewsCategoryTabs } from '@/app/news/NewsCategoryTabs';

const pushMock = jest.fn();
let mockQueryString = '';

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (...args: unknown[]) => pushMock(...args),
  }),
  useSearchParams: () => new URLSearchParams(mockQueryString),
}));

const CATEGORIES = ['ALL', 'COLLECTION', 'EVENT', 'COLLABORATION', 'SUSTAINABILITY', 'STORE', 'BLOG'];

beforeEach(() => {
  pushMock.mockClear();
  mockQueryString = '';
});

describe('NewsCategoryTabs', () => {
  it('DD-NEWS-005 7つの分類のタブを並べ activeCategory のタブを選ぶ', () => {
    render(<NewsCategoryTabs activeCategory="ALL" />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(CATEGORIES);
    expect(screen.getByRole('tab', { name: 'ALL' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'EVENT' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tablist')).toHaveAttribute('data-ui-tab-variant', 'segment-pill');
    expect(screen.getByRole('tablist')).toHaveAttribute('data-ui-size', 'md');
  });

  it('DD-NEWS-005 activeCategory が EVENT なら EVENT のタブだけを選ぶ', () => {
    render(<NewsCategoryTabs activeCategory="EVENT" />);

    expect(screen.getByRole('tab', { name: 'EVENT' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'ALL' })).toHaveAttribute('aria-selected', 'false');
  });

  it('DD-NEWS-005 ALL を選ぶと category を消して /news へ移る', async () => {
    const user = userEvent.setup();
    mockQueryString = 'category=EVENT';
    render(<NewsCategoryTabs activeCategory="EVENT" />);

    await user.click(screen.getByRole('tab', { name: 'ALL' }));

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/news');
  });

  it('DD-NEWS-005 個別の分類を選ぶと category に入れて移る', async () => {
    const user = userEvent.setup();
    render(<NewsCategoryTabs activeCategory="ALL" />);

    await user.click(screen.getByRole('tab', { name: 'EVENT' }));

    expect(pushMock).toHaveBeenCalledWith('/news?category=EVENT');
  });

  it('DD-NEWS-005 ALL を選んでもほかのクエリは残す', async () => {
    const user = userEvent.setup();
    mockQueryString = 'foo=1';
    render(<NewsCategoryTabs activeCategory="ALL" />);

    await user.click(screen.getByRole('tab', { name: 'ALL' }));

    expect(pushMock).toHaveBeenCalledWith('/news?foo=1');
  });

  it('DD-NEWS-005 個別の分類を選ぶと今の category を置き換えほかのクエリは残す', async () => {
    const user = userEvent.setup();
    mockQueryString = 'foo=1&category=EVENT';
    render(<NewsCategoryTabs activeCategory="EVENT" />);

    await user.click(screen.getByRole('tab', { name: 'BLOG' }));

    expect(pushMock).toHaveBeenCalledWith('/news?foo=1&category=BLOG');
  });
});
