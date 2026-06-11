// File: src/components/ui/Toolbar/Toolbar.tsx
import '@/components/ui/Toolbar/Toolbar.css';
import { cn } from '@/lib/utils';
import type { ToolbarItem, ToolbarProps } from '@/components/ui/Toolbar/Toolbar_type';

export function Toolbar({
  left,
  center,
  right,
  leftItems,
  rightItems,
  splitIndex,
  variant = 'default',
  className,
  size = 'md',
}: ToolbarProps) {
  const rootDataAttrs = {
    'data-ui-toolbar': 'true',
    'data-ui-toolbar-variant': variant,
    'data-ui-toolbar-size': size,
    'data-ui-size': size,
  } as const;

  const renderItem = (item: ToolbarItem) => (
    <button
      key={item.key}
      type="button"
      onClick={item.onClick}
      className="toolbar__item"
      data-ui-toolbar-item-has-label={item.label ? 'true' : undefined}
    >
      <span className="toolbar__item-icon" aria-hidden="true">
        <i className={item.iconClass} />
      </span>
      {item.label ? <span className="toolbar__item-label">{item.label}</span> : null}
    </button>
  );

  const builtLeft = leftItems
    ? leftItems.map((item, index) => (
        <div key={item.key} className="toolbar__item-wrap">
          {splitIndex !== undefined && index === splitIndex ? (
            <span className="toolbar__divider" aria-hidden="true" />
          ) : null}
          {renderItem(item)}
        </div>
      ))
    : left;

  const builtRight = rightItems ? rightItems.map((item) => renderItem(item)) : right;

  return (
    <header className={cn('toolbar', className)} {...rootDataAttrs} role="toolbar">
      <div className="toolbar__section toolbar__section--left">{builtLeft}</div>
      <div className="toolbar__section toolbar__section--center">{center}</div>
      <div className="toolbar__section toolbar__section--right">{builtRight}</div>
    </header>
  );
}