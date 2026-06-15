import "./TabSegmentControl.css";
import type { TabSegmentControlProps } from './TabSegmentControl_type';
import { Button } from '@/components/ui/Button/Button';

export type { TabSegmentControlItem, TabSegmentControlProps } from './TabSegmentControl_type';

export function TabSegmentControl({
  items,
  activeKey,
  onChange,
  variant = 'segment',
  className,
  size = 'md',
  orientation = 'horizontal',
  itemStyle,
}: TabSegmentControlProps) {
  return (
    <div
      data-ui-tab-segment=""
      data-ui-tab-variant={variant}
      data-ui-tab-orientation={orientation}
      data-ui-size={size}
      role="tablist"
      className={className}
    >
      {items.map((item) => {
        const isActive = item.key === activeKey;
        return (
          <Button
            key={item.key}
            variant="text"
            data-ui-tab-item=""
            data-ui-tab-active={isActive ? 'true' : undefined}
            role="tab"
            aria-selected={isActive}
            style={itemStyle}
            onClick={() => onChange(item.key)}
          >
            {item.label}
          </Button>
        );
      })}
    </div>
  );
}
