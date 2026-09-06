import '@/components/ui/BottomNavigation/BottomNavigation.css';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { CSSProperties, ReactNode } from 'react';
import type {
  BottomNavigationItem,
  BottomNavigationProps,
} from '@/components/ui/BottomNavigation/BottomNavigation_types';

export function BottomNavigation({
  items,
  activeKey,
  onChange,
  fixed = true,
  appearance = 'filled',
  className,
  size = 'md',
}: BottomNavigationProps) {
  const rootDataAttrs = {
    'data-ui-bottom-nav': 'true',
    'data-ui-bottom-nav-appearance': appearance,
    'data-ui-bottom-nav-size': size,
    'data-ui-bottom-nav-fixed': fixed ? 'true' : 'false',
  } as const;

  // 項目数のみ動的（グリッド列数の算出に使用）。直値ではなくカスタムプロパティで受け渡す。
  const listStyle = {
    '--bottom-nav-count': Math.max(items.length, 1),
  } as CSSProperties;

  return (
    <nav className={cn('bottom-nav', className)} {...rootDataAttrs}>
      <ul className="bottom-nav__list" style={listStyle}>
        {items.map((item: BottomNavigationItem) => {
          const isActive = item.key === activeKey;
          const content = renderContent(item);

          // 遷移先が無い項目は操作対象から外す（リンクにもボタンにもしない）。
          if (item.disabled) {
            return (
              <li key={item.key} className="bottom-nav__item">
                <span
                  className="bottom-nav__button"
                  data-ui-bottom-nav-disabled="true"
                >
                  {content}
                </span>
              </li>
            );
          }

          // 遷移が目的の項目はリンクにする（新規タブで開く等の標準操作を残す）。
          if (item.href) {
            return (
              <li key={item.key} className="bottom-nav__item">
                <Link
                  href={item.href}
                  className="bottom-nav__button"
                  data-ui-bottom-nav-active={isActive ? 'true' : undefined}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {content}
                </Link>
              </li>
            );
          }

          return (
            <li key={item.key} className="bottom-nav__item">
              <button
                type="button"
                onClick={() => onChange?.(item.key)}
                className="bottom-nav__button"
                data-ui-bottom-nav-active={isActive ? 'true' : undefined}
                aria-current={isActive ? 'page' : undefined}
              >
                {content}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function renderContent(item: BottomNavigationItem): ReactNode {
  return (
    <>
      {item.icon ? (
        <span className="bottom-nav__icon" aria-hidden="true">
          {item.icon}
        </span>
      ) : item.iconClass ? (
        <span className="bottom-nav__icon" aria-hidden="true">
          <i className={cn('bottom-nav__icon-glyph', item.iconClass)} />
        </span>
      ) : null}
      <span className="bottom-nav__label">{item.label ?? item.key}</span>
    </>
  );
}
