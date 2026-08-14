import "./Graph.css";
import type { CSSProperties } from "react";
import type {
  GraphDatum,
  GraphLegendEntry,
  GraphProps,
  GraphSeries,
} from "./Graph_types";

const FALLBACK_COLORS = ["#111111", "#474747", "#808080", "#b5b5b5"] as const;

/* ── 軸付きグラフの共通土台 ──────────────────────────────────────────────
   viewBox は固定の設計幅で描き、CSS 側で width:100% に伸ばす。
   余白・目盛り数は φ 由来のスケールに合わせた固定値（SVG 内は px 単位）。 */
const PLOT_WIDTH = 660;
const PLOT_PAD_LEFT = 78;
const PLOT_PAD_RIGHT = 14;
const PLOT_PAD_TOP = 24;
const PLOT_PAD_BOTTOM = 26;
const AXIS_TICK_COUNT = 4;
const AXIS_NUMBER = new Intl.NumberFormat("ja-JP");
const AXIS_GRID_COLOR = "#ededed";
const AXIS_ZERO_COLOR = "#d4d4d4";
const AXIS_TEXT_COLOR = "#888888";
/* plotPadLeft="auto" の見積り。目盛りラベルは fontSize 9 の等幅寄りの数字なので
   1文字あたり約 5.2px、ラベルと軸の間に 10px を空ける。 */
const AXIS_CHAR_WIDTH = 5.2;
const AXIS_LABEL_GAP = 10;
const WATERFALL_UP_COLOR = "#1e9e57";
const WATERFALL_DOWN_COLOR = "#d64545";
const WATERFALL_TOTAL_COLOR = "#2f6fdb";

/** 目盛りのきりのいい刻み。1 / 2 / 2.5 / 5 / 10 の系列に丸める。 */
function niceStep(raw: number): number {
  const exponent = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const multiple of [1, 2, 2.5, 5, 10]) {
    if (raw <= multiple * exponent) return multiple * exponent;
  }
  return 10 * exponent;
}

/** マイナスもあり得るので 0 起点に固定せず、上下とも刻みへ丸める。 */
function niceAxis(min: number, max: number) {
  const lowest = Math.min(min, 0);
  const highest = Math.max(max, 0);
  const step = niceStep((highest - lowest || 1) / AXIS_TICK_COUNT);
  const lo = Math.floor(lowest / step) * step;
  const hi = Math.ceil(highest / step) * step || step;
  const ticks: number[] = [];
  for (let value = lo; value <= hi + step / 2; value += step) {
    ticks.push(Math.round(value));
  }
  return { lo, hi: hi === lo ? lo + step : hi, ticks };
}

function seriesColor(series: GraphSeries, index: number): string {
  return series.color ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function numericSeriesValues(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null);
}

type IndexedLinePoint = {
  index: number;
  value: number;
};

function contiguousLineSegments(values: readonly (number | null)[]): IndexedLinePoint[][] {
  return values.reduce<IndexedLinePoint[][]>((segments, value, index) => {
    if (value === null) {
      return segments;
    }
    if (index === 0 || values[index - 1] === null) {
      segments.push([]);
    }
    segments[segments.length - 1].push({ index, value });
    return segments;
  }, []);
}

function datumColor(datum: GraphDatum): string {
  if (datum.color) return datum.color;
  if (datum.total) return WATERFALL_TOTAL_COLOR;
  return datum.value >= 0 ? WATERFALL_UP_COLOR : WATERFALL_DOWN_COLOR;
}

/** 凡例。折れ線は線、棒は矩形（ハッチは斜線）、強調点は円で描き分ける。 */
function AxisLegend({
  entries,
  className,
}: {
  entries: readonly GraphLegendEntry[];
  className?: string;
}) {
  return (
    <div data-graph-legend="" className={className}>
      {entries.map((entry) => (
        <div key={entry.label} data-graph-legend-item="">
          {entry.kind === "dot" ? (
            <svg
              data-graph-legend-swatch=""
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              <circle cx="6" cy="6" r="5" fill={entry.color} />
            </svg>
          ) : entry.kind === "line" ? (
            <svg
              data-graph-legend-line=""
              viewBox="0 0 24 12"
              aria-hidden="true"
            >
              <line
                x1="0"
                y1="6"
                x2="24"
                y2="6"
                stroke={entry.color}
                strokeWidth="2"
                strokeDasharray={entry.dashed ? "5 3" : undefined}
              />
            </svg>
          ) : (
            <svg
              data-graph-legend-swatch=""
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              <rect
                width="12"
                height="12"
                fill={entry.hatched ? "#ffffff" : entry.color}
                stroke={entry.color}
                strokeWidth="1"
              />
              {entry.hatched ? (
                <path
                  d="M0 12 L12 0 M-4 8 L8 -4 M4 16 L16 4"
                  stroke={entry.color}
                  strokeWidth="1"
                />
              ) : null}
            </svg>
          )}
          <span data-graph-legend-text="">{entry.label}</span>
        </div>
      ))}
    </div>
  );
}

export type {
  GraphProps,
  GraphVariant,
  GraphLayout,
  GraphDatum,
  GraphSeries,
  GraphMarker,
  GraphReferenceLine,
  GraphLegendEntry,
  GraphRightAxis,
} from "./Graph_types";

export function Graph({
  data,
  maxValue,
  variant = "progress",
  className,
  legendClassName,
  size = "md",
  showLegend = true,
  centerLabel,
  layout = "stacked",
  categories = [],
  series = [],
  unitLabel,
  markers = [],
  referenceLine,
  forecastFrom,
  forecastLabels,
  forecastSeriesLabels = { actual: "実績", forecast: "予測" },
  extraLegend = [],
  groupBars = false,
  rightAxis,
  formatAxisValue,
  formatValueLabel,
  plotHeight,
  plotWidth,
  plotPadLeft,
  ariaLabel,
  ariaDescribedBy,
}: GraphProps) {
  const dataAttrs = {
    "data-ui-graph": "true",
    "data-ui-graph-variant": variant,
    "data-ui-graph-layout": layout,
    ...(typeof size === "string"
      ? { "data-ui-graph-size": size, "data-ui-size": size }
      : {}),
  } as const;

  const rootStyle =
    typeof size === "number"
      ? ({ "--graph-height": `${size}px` } as CSSProperties)
      : undefined;

  const axisFormat = formatAxisValue ?? ((value: number) => AXIS_NUMBER.format(value));

  /* ── 軸付きの折れ線・積み上げ棒 ─────────────────────────────────── */
  if (variant === "line" || variant === "stacked-bars") {
    if (series.length === 0 || categories.length === 0) return null;

    const height = plotHeight ?? 240;
    const width = plotWidth ?? PLOT_WIDTH;
    const isStacked = variant === "stacked-bars";
    // 右軸を出すときだけ右の余白を広げる。出さないときの見た目は変えない。
    const rightIndexes = isStacked ? [] : (rightAxis?.seriesIndexes ?? []);
    const hasRightAxis = rightIndexes.length > 0;
    const padRight = hasRightAxis ? PLOT_PAD_RIGHT + 56 : PLOT_PAD_RIGHT;
    const plotH = height - PLOT_PAD_TOP - PLOT_PAD_BOTTOM;

    const onRightAxis = (item: GraphSeries) =>
      rightIndexes.includes(series.indexOf(item));

    // 積み上げは各カテゴリの合計、折れ線は各系列の生値が軸の範囲を決める。
    const stackTotals = categories.map((_, index) =>
      series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0),
    );
    const rawValues = isStacked
      ? stackTotals
      : series
          .filter((item) => !onRightAxis(item))
          .flatMap((item) => numericSeriesValues(item.values));
    const bounded = [
      ...(rawValues.length > 0 ? rawValues : [0]),
      ...(referenceLine ? [referenceLine.value] : []),
    ];
    const { lo, hi, ticks } = niceAxis(
      Math.min(...bounded),
      Math.max(maxValue ?? Math.max(...bounded), ...bounded),
    );

    // auto は実際の目盛りラベルの長さから左余白を決める（短い単位のとき作図領域を広く使う）。
    const padLeft =
      plotPadLeft === "auto"
        ? Math.ceil(
            Math.max(...ticks.map((tick) => axisFormat(tick).length)) * AXIS_CHAR_WIDTH,
          ) + AXIS_LABEL_GAP
        : (plotPadLeft ?? PLOT_PAD_LEFT);
    const plotW = width - padLeft - padRight;

    // 右軸は自分の系列だけでスケールを決める。目盛りの本数は左軸と揃える。
    const rightValues = series
      .filter((item) => onRightAxis(item))
      .flatMap((item) => numericSeriesValues(item.values));
    const rightScale = hasRightAxis
      ? niceAxis(
          Math.min(...(rightValues.length > 0 ? rightValues : [0])),
          Math.max(...(rightValues.length > 0 ? rightValues : [0])),
        )
      : null;
    const rightAxisFormat =
      rightAxis?.formatAxisValue ?? axisFormat;

    const slotW = plotW / Math.max(categories.length, 1);
    // 点・棒はどちらもスロットの中央に置く。棒と折れ線を重ねても軸がずれない。
    const xOfPoint = (index: number) => padLeft + slotW * (index + 0.5);
    const yOf = (value: number) =>
      PLOT_PAD_TOP + (1 - (value - lo) / (hi - lo)) * plotH;
    const yOfRight = (value: number) =>
      rightScale === null
        ? yOf(value)
        : PLOT_PAD_TOP
          + (1 - (value - rightScale.lo) / (rightScale.hi - rightScale.lo))
            * plotH;
    const yOfSeries = (item: GraphSeries) =>
      onRightAxis(item) ? yOfRight : yOf;
    const barW = Math.max(6, slotW / (1 + 1 / 1.618));

    // 積み上げ棒では全系列が棒。kind の指定なしを折れ線に落とさない。
    const lineSeries = isStacked
      ? []
      : series.filter((item) => item.kind !== "bar");
    const barSeries = isStacked
      ? []
      : series.filter((item) => item.kind === "bar");
    // 横並びのときはスロット幅を棒の本数で割り、中央揃えでずらす。
    const groupCount = groupBars ? Math.max(barSeries.length, 1) : 1;
    const singleBarW = barW / groupCount;
    const barOffsetOf = (item: GraphSeries) =>
      groupCount === 1
        ? 0
        : (barSeries.indexOf(item) - (groupCount - 1) / 2) * singleBarW;
    const dividerX =
      forecastFrom === undefined
        ? null
        : padLeft + slotW * forecastFrom;

    // 予測の境界があるときは、系列ごとに（実績）（予測）の2項目へ分ける。
    const legendEntries: GraphLegendEntry[] = [
      ...series.flatMap((item, index): GraphLegendEntry[] => {
        const kind: "line" | "bar" = item.kind === "bar" ? "bar" : "line";
        const color = seriesColor(item, index);
        if (forecastFrom === undefined) {
          return [
            {
              label: item.label,
              color,
              kind,
              dashed: item.dashed,
              hatched: item.hatched,
            },
          ];
        }
        return [
          {
            label: `${item.label}（${forecastSeriesLabels.actual}）`,
            color,
            kind,
          },
          {
            label: `${item.label}（${forecastSeriesLabels.forecast}）`,
            color,
            kind,
            dashed: kind === "line",
            hatched: kind === "bar",
          },
        ];
      }),
      ...extraLegend,
    ];

    return (
      <div {...dataAttrs} className={className} style={rootStyle}>
        {showLegend ? (
          <AxisLegend entries={legendEntries} className={legendClassName} />
        ) : null}
        <div data-graph-plot="">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
          >
            <defs>
              {series.map((item, index) =>
                item.hatched || (item.kind === "bar" && forecastFrom !== undefined) ? (
                  <pattern
                    key={`hatch-${item.label}`}
                    id={`graph-hatch-${index}`}
                    width="6"
                    height="6"
                    patternUnits="userSpaceOnUse"
                    patternTransform="rotate(45)"
                  >
                    <rect width="6" height="6" fill="#ffffff" />
                    <line
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="6"
                      stroke={seriesColor(item, index)}
                      strokeWidth="2"
                    />
                  </pattern>
                ) : null,
              )}
            </defs>

            {unitLabel ? (
              <text x={4} y={10} fill={AXIS_TEXT_COLOR} fontSize="9">
                {unitLabel}
              </text>
            ) : null}

            {hasRightAxis && rightAxis?.unitLabel ? (
              <text
                x={width - padRight + 8}
                y={10}
                fill={AXIS_TEXT_COLOR}
                fontSize="9"
              >
                {rightAxis.unitLabel}
              </text>
            ) : null}

            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={padLeft}
                  x2={width - padRight}
                  y1={yOf(tick)}
                  y2={yOf(tick)}
                  stroke={tick === 0 ? AXIS_ZERO_COLOR : AXIS_GRID_COLOR}
                  strokeWidth={1}
                />
                <text
                  x={padLeft - 8}
                  y={yOf(tick) + 3}
                  textAnchor="end"
                  fill={AXIS_TEXT_COLOR}
                  fontSize="9"
                >
                  {axisFormat(tick)}
                </text>
              </g>
            ))}

            {/* 右軸の目盛りラベル。格子は左軸のものを共有する。 */}
            {rightScale?.ticks.map((tick) => (
              <text
                key={`right-${tick}`}
                x={width - padRight + 8}
                y={yOfRight(tick) + 3}
                textAnchor="start"
                fill={AXIS_TEXT_COLOR}
                fontSize="9"
              >
                {rightAxisFormat(tick)}
              </text>
            ))}

            {referenceLine ? (
              <line
                x1={padLeft}
                x2={width - padRight}
                y1={yOf(referenceLine.value)}
                y2={yOf(referenceLine.value)}
                stroke={referenceLine.color ?? "#909090"}
                strokeWidth={1.5}
                strokeDasharray={
                  referenceLine.dashed === false ? undefined : "6 4"
                }
              />
            ) : null}

            {/* 積み上げ棒。系列の順に下から積む。 */}
            {isStacked
              ? categories.map((category, index) => {
                  let base = 0;
                  return (
                    <g key={`stack-${category}`}>
                      {series.map((item, seriesIndex) => {
                        const value = item.values[index] ?? 0;
                        const y = yOf(base + value);
                        const bottom = yOf(base);
                        base += value;
                        return (
                          <rect
                            key={`${category}-${item.label}`}
                            x={xOfPoint(index) - barW / 2}
                            y={Math.min(y, bottom)}
                            width={barW}
                            height={Math.max(Math.abs(bottom - y), 0)}
                            fill={seriesColor(item, seriesIndex)}
                          />
                        );
                      })}
                    </g>
                  );
                })
              : barSeries.map((item) => {
                  const seriesIndex = series.indexOf(item);
                  const y = yOfSeries(item);
                  const offset = barOffsetOf(item);
                  return (
                    <g key={`bars-${item.label}`}>
                      {item.values.map((value, index) => value === null ? null : (
                        <rect
                          key={`${item.label}-${categories[index] ?? index}`}
                          x={xOfPoint(index) + offset - singleBarW / 2}
                          y={Math.min(y(value), y(0))}
                          width={singleBarW}
                          height={Math.max(Math.abs(y(0) - y(value)), 0)}
                          fill={
                            item.hatched
                            || (forecastFrom !== undefined && index >= forecastFrom)
                              ? `url(#graph-hatch-${seriesIndex})`
                              : seriesColor(item, seriesIndex)
                          }
                        />
                      ))}
                      {/* 値ラベルは棒の上。渡されたときだけ描く。 */}
                      {formatValueLabel
                        ? item.values.map((value, index) => value === null ? null : (
                            <text
                              key={`${item.label}-label-${categories[index] ?? index}`}
                              x={xOfPoint(index) + offset}
                              y={Math.min(y(value), y(0)) - 4}
                              textAnchor="middle"
                              fill={AXIS_TEXT_COLOR}
                              fontSize="8"
                            >
                              {formatValueLabel(value)}
                            </text>
                          ))
                        : null}
                    </g>
                  );
                })}

            {/* 実績と予測の境界。 */}
            {dividerX !== null ? (
              <g>
                <line
                  x1={dividerX}
                  x2={dividerX}
                  y1={PLOT_PAD_TOP}
                  y2={PLOT_PAD_TOP + plotH}
                  stroke="#909090"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
                {forecastLabels ? (
                  <>
                    <text
                      x={dividerX - 8}
                      y={PLOT_PAD_TOP + 8}
                      textAnchor="end"
                      fill="#707070"
                      fontSize="9"
                    >
                      {forecastLabels.past}
                    </text>
                    <text
                      x={dividerX + 8}
                      y={PLOT_PAD_TOP + 8}
                      textAnchor="start"
                      fill="#707070"
                      fontSize="9"
                    >
                      {forecastLabels.future}
                    </text>
                  </>
                ) : null}
              </g>
            ) : null}

            {/* 折れ線と点。 */}
            {lineSeries.map((item) => {
              const seriesIndex = series.indexOf(item);
              const color = seriesColor(item, seriesIndex);
              const y = yOfSeries(item);
              const pointsOf = (points: readonly IndexedLinePoint[]) =>
                points
                  .map(({ index, value }) =>
                    `${xOfPoint(index).toFixed(1)},${y(value).toFixed(1)}`,
                  )
                  .join(" ");
              const segments = contiguousLineSegments(item.values).flatMap((points) => {
                if (forecastFrom === undefined || forecastFrom <= 0) {
                  return [{ points, dashed: item.dashed }];
                }
                const past = points.filter((point) => point.index < forecastFrom);
                const future = points.filter((point) => point.index >= forecastFrom - 1);
                return [
                  ...(past.length > 0 ? [{ points: past, dashed: item.dashed }] : []),
                  ...(future.length > 0 ? [{ points: future, dashed: true }] : []),
                ];
              });
              return (
                <g key={`line-${item.label}`}>
                  {segments.map((segment, segmentIndex) => (
                    <polyline
                      key={`${item.label}-${segmentIndex}-${segment.dashed ? "dashed" : "solid"}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      strokeDasharray={segment.dashed ? "6 4" : undefined}
                      points={pointsOf(segment.points)}
                    />
                  ))}
                  {item.hideDots
                    ? null
                    : item.values.map((value, index) => value === null ? null : (
                        <circle
                          key={`${item.label}-dot-${categories[index] ?? index}`}
                          cx={xOfPoint(index)}
                          cy={y(value)}
                          r={2.5}
                          fill={color}
                        />
                      ))}
                </g>
              );
            })}

            {/* 異常値などの強調点。折れ線より前面に置く。 */}
            {markers.map((marker) => {
              const target = series[marker.seriesIndex];
              const value = target?.values[marker.index];
              if (target === undefined || value === undefined || value === null) return null;
              return (
                <circle
                  key={`marker-${marker.seriesIndex}-${marker.index}`}
                  cx={xOfPoint(marker.index)}
                  cy={yOfSeries(target)(value)}
                  r={5}
                  fill={marker.color ?? "#e9a23b"}
                />
              );
            })}

            {categories.map((category, index) => (
              <text
                key={`x-${category}`}
                x={xOfPoint(index)}
                y={height - 8}
                textAnchor="middle"
                fill={AXIS_TEXT_COLOR}
                fontSize="9"
              >
                {category}
              </text>
            ))}
          </svg>
        </div>
      </div>
    );
  }

  /* ── 滝グラフ（増減要因の内訳）───────────────────────────────────── */
  if (variant === "waterfall") {
    if (!data || data.length === 0) return null;

    const height = plotHeight ?? 240;
    const width = plotWidth ?? PLOT_WIDTH;
    const plotW = width - PLOT_PAD_LEFT - PLOT_PAD_RIGHT;
    const plotH = height - PLOT_PAD_TOP - PLOT_PAD_BOTTOM;
    const labelFormat =
      formatValueLabel ?? ((value: number) => AXIS_NUMBER.format(value));

    // 各ブロックの起点と終点。total は 0 起点、それ以外は直前の積み上げから。
    let running = 0;
    const blocks = data.map((datum) => {
      const start = datum.total ? 0 : running;
      const end = datum.total ? datum.value : running + datum.value;
      running = end;
      return { datum, start, end };
    });

    const edges = blocks.flatMap((block) => [block.start, block.end]);
    const { lo, hi, ticks } = niceAxis(Math.min(...edges), Math.max(...edges));

    const slotW = plotW / Math.max(blocks.length, 1);
    const barW = Math.max(8, slotW / 1.618);
    const yOf = (value: number) =>
      PLOT_PAD_TOP + (1 - (value - lo) / (hi - lo)) * plotH;

    return (
      <div {...dataAttrs} className={className} style={rootStyle}>
        <div data-graph-plot="">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={ariaLabel}
          >
            {unitLabel ? (
              <text
                x={width - PLOT_PAD_RIGHT}
                y={10}
                textAnchor="end"
                fill={AXIS_TEXT_COLOR}
                fontSize="9"
              >
                {unitLabel}
              </text>
            ) : null}

            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={PLOT_PAD_LEFT}
                  x2={width - PLOT_PAD_RIGHT}
                  y1={yOf(tick)}
                  y2={yOf(tick)}
                  stroke={tick === 0 ? AXIS_ZERO_COLOR : AXIS_GRID_COLOR}
                  strokeWidth={1}
                />
                <text
                  x={PLOT_PAD_LEFT - 8}
                  y={yOf(tick) + 3}
                  textAnchor="end"
                  fill={AXIS_TEXT_COLOR}
                  fontSize="9"
                >
                  {axisFormat(tick)}
                </text>
              </g>
            ))}

            {blocks.map((block, index) => {
              const centerX = PLOT_PAD_LEFT + slotW * (index + 0.5);
              const top = Math.min(yOf(block.start), yOf(block.end));
              const barH = Math.max(Math.abs(yOf(block.start) - yOf(block.end)), 1);
              const color = datumColor(block.datum);
              const next = blocks[index + 1];
              return (
                <g key={block.datum.label}>
                  <rect
                    x={centerX - barW / 2}
                    y={top}
                    width={barW}
                    height={barH}
                    fill={color}
                  />
                  {/* 連結線。次のブロックの起点へ水平につなぐ。 */}
                  {next && !next.datum.total ? (
                    <line
                      x1={centerX - barW / 2}
                      x2={PLOT_PAD_LEFT + slotW * (index + 1.5) + barW / 2}
                      y1={yOf(block.end)}
                      y2={yOf(block.end)}
                      stroke="#c4c4c4"
                      strokeWidth={1}
                    />
                  ) : null}
                  <text
                    x={centerX}
                    y={height - 16}
                    textAnchor="middle"
                    fill="#474747"
                    fontSize="9"
                  >
                    {block.datum.label}
                  </text>
                  <text
                    x={centerX}
                    y={height - 5}
                    textAnchor="middle"
                    fill={color}
                    fontSize="9"
                  >
                    {block.datum.formattedValue ??
                      labelFormat(block.datum.total ? block.end : block.datum.value)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    );
  }

  if (!data || data.length === 0) return null;

  const magnitudeOf = (datum: GraphDatum) =>
    Math.abs(datum.magnitude ?? datum.value);
  const max = maxValue ?? Math.max(...data.map(magnitudeOf), 1);

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
            {centerLabel !== undefined ? (
              <div data-graph-donut-center="">{centerLabel}</div>
            ) : null}
          </div>
        </div>
        {!showLegend ? null : (
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
        )}
      </div>
    );
  }

  return (
    <div {...dataAttrs} className={className} style={rootStyle}>
      {data.map((item) => {
        const track = (
          <div data-graph-track="">
            <div
              data-graph-fill=""
              style={{
                width: `${Math.min(100, (magnitudeOf(item) / max) * 100)}%`,
                ...(item.color ? { background: item.color } : {}),
              }}
            />
          </div>
        );
        const label = <span data-graph-label="">{item.label}</span>;
        const value = (
          <span data-graph-value="">{item.formattedValue ?? item.value}</span>
        );

        // inline は「ラベル｜track｜値」を1行に並べる（近接：1指標を1行に束ねる）。
        if (layout === "inline") {
          return (
            <div key={item.label} data-graph-row="">
              {label}
              {track}
              {value}
            </div>
          );
        }

        return (
          <div key={item.label} data-graph-row="">
            <div data-graph-row-header="">
              {label}
              {value}
            </div>
            {track}
          </div>
        );
      })}
    </div>
  );
}
