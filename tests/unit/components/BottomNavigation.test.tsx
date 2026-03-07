import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BottomNavigation, BottomNavigationItem } from '@/app/components/ui/BottomNavigation';

const items: BottomNavigationItem[] = [
  { key: 'home', label: 'Home', iconClass: 'ri-home-line' },
  { key: 'search', label: 'Search', iconClass: 'ri-search-line' },
];

describe('BottomNavigation component', () => {
  test('renders items and highlights active key', () => {
    const onChange = jest.fn();
    render(
      <BottomNavigation
        items={items}
        activeKey="home"
        onChange={onChange}
        fixed={false}
      />
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(items.length);

    // first button should have aria-current page
    expect(buttons[0]).toHaveAttribute('aria-current', 'page');
  });

  test('size prop adjusts icon/container and label classes', () => {
    const { rerender, container } = render(
      <BottomNavigation
        items={items}
        activeKey="home"
        onChange={() => undefined}
        fixed={false}
        size="sm"
      />
    );

    // check small size classes
    let nav = container.querySelector('nav');
    expect(nav).toBeInTheDocument();
    let btns = nav!.querySelectorAll('button');
    btns.forEach((btn) => {
      const iconContainer = btn.querySelector('span');
      expect(iconContainer).toHaveClass('h-5');
      expect(iconContainer).toHaveClass('w-5');
      const icon = btn.querySelector('i');
      expect(icon).toHaveClass('text-lg');
      const label = btn.querySelector('span + span'); // second span
      expect(label).toHaveClass('text-[10px]');
    });

    // medium
    rerender(
      <BottomNavigation
        items={items}
        activeKey="home"
        onChange={() => undefined}
        fixed={false}
        size="md"
      />
    );
    btns = nav!.querySelectorAll('button');
    btns.forEach((btn) => {
      const iconContainer = btn.querySelector('span');
      expect(iconContainer).toHaveClass('h-6');
      expect(iconContainer).toHaveClass('w-6');
      const icon = btn.querySelector('i');
      expect(icon).toHaveClass('text-2xl');
      const label = btn.querySelector('span + span');
      expect(label).toHaveClass('text-xs');
    });

    // large
    rerender(
      <BottomNavigation
        items={items}
        activeKey="home"
        onChange={() => undefined}
        fixed={false}
        size="lg"
      />
    );
    btns = nav!.querySelectorAll('button');
    btns.forEach((btn) => {
      const iconContainer = btn.querySelector('span');
      expect(iconContainer).toHaveClass('h-8');
      expect(iconContainer).toHaveClass('w-8');
      const icon = btn.querySelector('i');
      expect(icon).toHaveClass('text-3xl');
      const label = btn.querySelector('span + span');
      expect(label).toHaveClass('text-sm');
    });
  });
});
