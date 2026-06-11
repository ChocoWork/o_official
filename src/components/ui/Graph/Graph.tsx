import "./Graph.css";
import type { CSSProperties } from "react";
import type { GraphProps } from "./Graph_types";

const FALLBACK_COLORS = ["#111111", "#474747", "#808080", "#b5b5b5"] as const;

export function Graph({
  data,
  maxValue,
  variant = "progress",
  className,
  legendClassName,
  size = "md",
}: GraphProps) {
  if (data.length === 0) return null;

  const max = maxValue ?? Math.max(...data.map((d) => d.value), 1);

  const dataAttrs = {
    "data-ui-graph": "true",
    "data-ui-graph-variant": variant,
    ...(typeof size === "string"
      ? { "data-ui-graph-size": size, "data-ui-size": size }
      : {}),
  } as const;

  const rootStyle =
    typeof size === "number"
      ? ({ "--graph-height": `${size}px` } as CSSProperties)
      : undefined;

  if (variant === "bars") {
    return (
      <div {...dataAttrs} className={className} style={rootStyle}>
        {data.map((item) => (
          <div key={item.label} data-graph-bar-col="">
            <div
              data-graph-bar=""
              style={{ height: `${Math.min(100, (item.value / max) * 100)}%` }}
            />
            <span data-graph-label="">{item.label}</span>
          </div>
        ))}
      </div>
    );
  }

  if (variant === "donut") {
    const total = Math.max(1, data.reduce((sum, d) => sum + d.value, 0));
    const radius = 40;
    const circumference = 2 * Math.PI * radius;
    let accumulated = 0;

    return (
      <div {...dataAttrs} className={className} style={rootStyle}>
        <div data-graph-donut-wrap="">
          <div data-graph-donut-svg-wrap="">
            <svg viewBox="0 0 100 100">
              <g transform="rotate(-90 50 50)">
                {data.map((item, i) => {
                  const color =
                    item.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];
                  const segment = (item.value / total) * circumference;
                  const offset = -accumulated;
                  accumulated += segment;
                  return (
                    <circle
                      key={item.label}
                      cx="50"
                      cy="50"
                      r={radius}
                      fill="none"
                      stroke={color}
                      strokeWidth="20"
                      strokeDasharray={`${segment} ${circumference}`}
                      strokeDashoffset={`${offset}`}
                    />
                  );
                })}
              </g>
            </svg>
          </div>
        </div>
        <div data-graph-legend="" className={legendClassName}>
          {data.map((item, i) => {
            const color =
              item.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];
            return (
              <div key={item.label} data-graph-legend-item="">
                <svg
                  data-graph-legend-swatch=""
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                >
                  <rect width="12" height="12" fill={color} />
                </svg>
                <span data-graph-legend-text="">
                  {item.label} {Math.round((item.value / total) * 100)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div {...dataAttrs} className={className} style={rootStyle}>
      {data.map((item) => (
        <div key={item.label} data-graph-row="">
          <div data-graph-row-header="">
            <span data-graph-label="">{item.label}</span>
            <span data-graph-value="">{item.value}</span>
          </div>
          <div data-graph-track="">
            <div
              data-graph-fill=""
              style={{ width: `${Math.min(100, (item.value / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
