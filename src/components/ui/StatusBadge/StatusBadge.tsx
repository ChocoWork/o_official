import "./StatusBadge.css";
import type { StatusBadgeProps } from './StatusBadge_type';

export type { StatusBadgeTone, StatusBadgeVariant, StatusBadgeProps } from './StatusBadge_type';

export function StatusBadge({
  children,
  tone = 'neutral',
  variant = 'text',
  count,
  className,
  size = 'md',
}: StatusBadgeProps) {
  if (variant === 'dot') {
    return (
      <span
        data-ui-badge=""
        data-ui-badge-variant="dot"
        data-ui-size={size}
        className={className}
      />
    );
  }

  if (variant === 'count') {
    const isMulti = count !== undefined && String(count).length > 1;
    return (
      <span
        data-ui-badge=""
        data-ui-badge-variant="count"
        data-ui-badge-multi={isMulti ? 'true' : undefined}
        data-ui-size={size}
        className={className}
      >
        {count}
      </span>
    );
  }

  return (
    <span
      data-ui-badge=""
      data-ui-badge-variant="text"
      data-ui-badge-tone={tone}
      data-ui-size={size}
      className={className}
    >
      {children}
    </span>
  );
}
