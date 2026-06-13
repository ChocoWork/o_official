import '@/components/ui/Tooltip/Tooltip.css';
import { cn } from '@/lib/utils';
import type { TooltipProps } from '@/components/ui/Tooltip/Tooltip_type';

export function Tooltip({
  content,
  children,
  className,
  contentClassName,
  placement = 'top',
  shape = 'square',
  size = 'md',
}: TooltipProps) {
  const rootDataAttrs = {
    'data-ui-tooltip': 'true',
    'data-ui-tooltip-size': size,
    'data-ui-tooltip-placement': placement,
    'data-ui-tooltip-shape': shape,
    'data-ui-size': size,
  } as const;

  return (
    <span className={cn('tooltip', className)} {...rootDataAttrs}>
      <span className="tooltip__trigger">{children}</span>
      <span className={cn('tooltip__content', contentClassName)} role="tooltip">
        {content}
        <span className="tooltip__arrow" aria-hidden="true" />
      </span>
    </span>
  );
}