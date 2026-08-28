import "./StatusBadge.css";
import type { StatusBadgeProps } from './StatusBadge_type';

export type { StatusBadgeTone, StatusBadgeVariant, StatusBadgeShape, StatusBadgeHeight, StatusBadgeProps } from './StatusBadge_type';

export function StatusBadge({
  children,
  tone = 'neutral',
  variant = 'text',
  count,
  max = 99,
  className,
  size = 'md',
  shape = 'square',
  accent = false,
  height = 'auto',
  style,
}: StatusBadgeProps) {
  if (variant === 'dot') {
    return (
      <span
        data-ui-badge=""
        data-ui-badge-variant="dot"
        data-ui-badge-tone={tone}
        data-ui-badge-accent={accent ? 'true' : undefined}
        data-ui-size={size}
        className={className}
        style={style}
      />
    );
  }

  if (variant === 'count') {
    // 上限超過は "99+" に丸める。円は2桁まで内接するので、3文字以上だけ pill に開く。
    const label =
      count === undefined
        ? ''
        : typeof count === 'number' && count > max
          ? `${max}+`
          : String(count);
    const isMulti = label.length > 2;
    return (
      <span
        data-ui-badge=""
        data-ui-badge-variant="count"
        data-ui-badge-multi={isMulti ? 'true' : undefined}
        data-ui-size={size}
        className={className}
        style={style}
      >
        {label}
      </span>
    );
  }

  return (
    <span
      data-ui-badge=""
      data-ui-badge-variant="text"
      data-ui-badge-tone={tone}
      data-ui-badge-shape={shape}
      data-ui-badge-accent={accent ? 'true' : undefined}
      data-ui-badge-height={height}
      data-ui-size={size}
      className={className}
      style={style}
    >
      {children}
    </span>
  );
}
