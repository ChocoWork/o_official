import "./Stats.css";
import type { StatsProps } from "./Stats_type";

export type { StatItem, StatsProps } from "./Stats_type";

export function Stats({
  items,
  className,
  cardClassName,
  valueClassName,
  labelClassName,
  size = 'md',
}: StatsProps) {
  return (
    <div data-ui-stats="" data-ui-size={size} className={className}>
      {items.map((item) => (
        <div key={item.label} data-ui-stats-card="" className={cardClassName}>
          {item.icon ? (
            <div data-ui-stats-icon="" aria-hidden="true">{item.icon}</div>
          ) : null}
          <p data-ui-stats-value="" className={valueClassName}>{item.value}</p>
          <p data-ui-stats-label="" className={labelClassName}>{item.label}</p>
        </div>
      ))}
    </div>
  );
}
