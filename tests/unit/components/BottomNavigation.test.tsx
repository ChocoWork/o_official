import React from 'react';
import { render, screen } from '@testing-library/react';
import { BottomNavigation } from '@/components/ui/BottomNavigation/BottomNavigation';
import type { BottomNavigationItem } from '@/components/ui/BottomNavigation/BottomNavigation_types';

// BottomNavigation は CSS ファイル方式へ移行済み。アイコン寸法やラベルの文字サイズは
// CSS の責務なので、ここでは size / active / fixed の属性契約と操作を検証する。
const items: BottomNavigationItem[] = [
  { key: 'home', label: 'Home', iconClass: 'ri-home-line' },
  { key: 'search', label: 'Search', iconClass: 'ri-search-line' },
];

function renderNav(props: Partial<React.ComponentProps<typeof BottomNavigation>> = {}) {
  return render(
    <BottomNavigation
      items={items}
      activeKey="home"
      onChange={() => undefined}
      fixed={false}
      {...props}
    />,
  );
}

describe('BottomNavigation component', () => {
  test('項目を描画し、選択中に aria-current を付ける', () => {
    renderNav();

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(items.length);
    expect(buttons[0]).toHaveAttribute('aria-current', 'page');
    expect(buttons[1]).not.toHaveAttribute('aria-current');
  });

  test('選択中の項目に data-ui-bottom-nav-active が立つ', () => {
    renderNav({ activeKey: 'search' });

    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).not.toHaveAttribute('data-ui-bottom-nav-active');
    expect(buttons[1]).toHaveAttribute('data-ui-bottom-nav-active', 'true');
  });

  test('size は data-ui-bottom-nav-size に反映される', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = renderNav({ size });
      const nav = container.querySelector('[data-ui-bottom-nav]');
      expect(nav).toHaveAttribute('data-ui-bottom-nav-size', size);
    }
  });

  test('size を切り替えると属性が追従する', () => {
    const { container, rerender } = renderNav({ size: 'sm' });
    const nav = () => container.querySelector('[data-ui-bottom-nav]');
    expect(nav()).toHaveAttribute('data-ui-bottom-nav-size', 'sm');

    rerender(
      <BottomNavigation items={items} activeKey="home" onChange={() => undefined} fixed={false} size="lg" />,
    );
    expect(nav()).toHaveAttribute('data-ui-bottom-nav-size', 'lg');
  });

  test('fixed は属性で表す', () => {
    const { container } = renderNav({ fixed: true });
    expect(container.querySelector('[data-ui-bottom-nav]')).toHaveAttribute('data-ui-bottom-nav-fixed', 'true');
  });

  test('項目をクリックすると onChange が key を返す', () => {
    const onChange = jest.fn();
    renderNav({ onChange });

    screen.getAllByRole('button')[1].click();
    expect(onChange).toHaveBeenCalledWith('search');
  });

  // FREQ-343: LOOK 詳細のモバイル固定ナビで使うため、遷移が目的の項目は
  // button ではなくリンクとして描画し、遷移先が無い項目は非活性で置く。
  test('href を持つ項目はリンクとして描画される', () => {
    render(
      <BottomNavigation
        items={[
          { key: 'prev', label: 'PREV LOOK', href: '/look/1' },
          { key: 'list', label: 'LOOK LIST', href: '/look' },
        ]}
        activeKey=""
        fixed={false}
      />,
    );

    expect(screen.getByRole('link', { name: 'PREV LOOK' })).toHaveAttribute(
      'href',
      '/look/1',
    );
    expect(screen.getByRole('link', { name: 'LOOK LIST' })).toHaveAttribute(
      'href',
      '/look',
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  test('disabled の項目はリンクにもボタンにもならず非活性属性が立つ', () => {
    const { container } = render(
      <BottomNavigation
        items={[
          { key: 'prev', label: 'PREV LOOK', disabled: true },
          { key: 'list', label: 'LOOK LIST', href: '/look' },
        ]}
        activeKey=""
        fixed={false}
      />,
    );

    expect(screen.queryByRole('link', { name: 'PREV LOOK' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'PREV LOOK' })).toBeNull();
    expect(
      container.querySelector('[data-ui-bottom-nav-disabled="true"]'),
    ).toHaveTextContent('PREV LOOK');
  });

});
