// 会計画面（CostProfitSection）の複数のサブタブで使う表示の部品。
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button/Button";
import { Panel } from "@/components/ui/Panel/Panel";
import type { CompositionItem } from "@/lib/finance/overview";
import {
  currency,
  signedCurrency,
  percent,
  statementCurrency,
  deltaCurrency,
  boxRadiusClassName,
  panelTitleClassName,
  statementTitleClassName,
} from "./constants";

export function MetricCard({
  label,
  value,
  note,
  positive,
  compact = false,
}: {
  label: string;
  value: string;
  note?: string;
  positive?: boolean;
  /** 密度の高いダッシュボード用。値を中央に寄せ、補足を省略できる。 */
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-md border border-[#d4d4d4] bg-white ${compact ? "px-3 py-3 text-center" : "p-4"}`}
    >
      <p
        className={`font-acumin lk-text-4xs tracking-wider text-[#474747] ${compact ? "leading-none" : ""}`}
      >
        {label}
      </p>
      <p
        className={`${compact ? "mt-3 lk-text-2xl" : "mt-2 lk-text-4xl"} font-acumin font-medium tracking-wide text-black tabular-nums`}
      >
        {value}
      </p>
      {note ? (
        <p
          className={`mt-2 font-acumin lk-text-4xs ${positive ? "text-[#16844b]" : "text-[#707070]"}`}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

export type StatementRow = {
  label: string;
  value: number;
  /** 構成比（%）。undefined の行は構成比欄を空ける。 */
  ratio?: number;
  /** 小計・利益行。上に区切り線を引いて太字にする。 */
  emphasis?: boolean;
  /** 増減として符号と色を付ける（C/F の各活動）。 */
  delta?: boolean;
};

/**
 * 財務3表の1枚。見出しの右に CSV 出力、本体は 科目 / 金額 /（任意で）構成比。
 * aside はグラフ、children は表の下の検算・バランス表示を差し込む枠。
 */
export function StatementTable({
  title,
  exportLabel,
  onExport,
  rows,
  showRatio,
  aside,
  children,
}: {
  title: string;
  exportLabel: string;
  onExport: () => void;
  rows: StatementRow[];
  showRatio?: boolean;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const columns = showRatio
    ? "grid-cols-[minmax(0,1fr)_auto_auto]"
    : "grid-cols-[minmax(0,1fr)_auto]";

  return (
    <Panel
      radius="rounded"
      className="min-w-0"
      aria-label={title}
      headingLevel={4}
      headerWrap={false}
      title={<span className={statementTitleClassName}>{title}</span>}
      actions={
        <Button
          variant="outline"
          size="3xs"
          shape="rounded"
          onClick={onExport}
          aria-label={exportLabel}
          className="font-acumin tracking-wider"
        >
          CSV
        </Button>
      }
    >
      <div className="flex items-stretch gap-3">
        <div className="min-w-0 flex-1">
          <div
            className={`grid ${columns} items-baseline gap-x-3 border-b border-[#d4d4d4] pb-1.5 font-acumin lk-text-6xs text-[#707070]`}
          >
            <span>（単位：円）</span>
            <span className="text-right">金額</span>
            {showRatio ? <span className="text-right">構成比</span> : null}
          </div>
          {rows.map((row) => (
            <div
              key={row.label}
              className={`grid ${columns} items-baseline gap-x-3 py-2 ${
                row.emphasis
                  ? "border-t border-[#d4d4d4]"
                  : "border-b border-[#ededed]"
              }`}
            >
              <span
                className={`min-w-0 truncate font-acumin lk-text-3xs ${row.emphasis ? "font-medium text-black" : "text-[#474747]"}`}
              >
                {row.label}
              </span>
              <span
                className={`whitespace-nowrap text-right font-acumin lk-text-3xs tabular-nums ${
                  row.delta && row.value > 0
                    ? "text-[#16844b]"
                    : row.value < 0
                      ? "text-red-700"
                      : "text-black"
                } ${row.emphasis ? "font-medium" : ""}`}
              >
                {row.delta
                  ? deltaCurrency(row.value)
                  : statementCurrency(row.value)}
              </span>
              {showRatio ? (
                <span className="whitespace-nowrap text-right font-acumin lk-text-3xs text-[#474747] tabular-nums">
                  {row.ratio === undefined ? "—" : percent(row.ratio)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
        {aside}
      </div>
      {children}
    </Panel>
  );
}

// 利益の残り方の帯。売上高100%から段階的に細くなる様子を濃さで示す。
export const PROFIT_LADDER_COLORS = ["#ffffff", "#dcdcdc", "#565656", "#111111"];

/** P/L 脇の縦帯。売上高100%のうち各段階でいくら残るかを高さで示す。 */
export function ProfitLadderBar({
  steps,
}: {
  steps: Array<{ label: string; ratio: number }>;
}) {
  const total = steps.reduce((sum, step) => sum + Math.max(step.ratio, 0), 0);
  if (total <= 0) return null;

  return (
    <div
      className={`hidden w-11 shrink-0 flex-col overflow-hidden border border-[#ededed] sm:flex ${boxRadiusClassName}`}
      role="img"
      aria-label={steps
        .map((step) => `${step.label} ${percent(step.ratio)}`)
        .join("、")}
    >
      {steps.map((step, index) => (
        <div
          key={step.label}
          className="flex items-center justify-center"
          style={{
            flexGrow: Math.max(step.ratio, 0),
            flexBasis: 0,
            minHeight: 22,
            backgroundColor:
              PROFIT_LADDER_COLORS[index % PROFIT_LADDER_COLORS.length],
            color: index >= 2 ? "#ffffff" : "#111111",
          }}
        >
          <span className="font-acumin lk-text-6xs tabular-nums">
            {percent(step.ratio)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** B/S の下の帯。資産と「負債＋純資産」を同じ尺度で並べ、差額を示す。 */
export function BalanceBars({
  assetTotal,
  liabilityAndEquityTotal,
  difference,
}: {
  assetTotal: number;
  liabilityAndEquityTotal: number;
  difference: number;
}) {
  const scale = Math.max(assetTotal, liabilityAndEquityTotal, 1);

  return (
    <div className="mt-4 border-t border-[#ededed] pt-3">
      <p className="font-acumin lk-text-4xs text-[#474747]">財政状態のバランス</p>
      <div className="mt-2 grid grid-cols-2 gap-3">
        {(
          [
            ["資産", assetTotal],
            ["負債＋純資産", liabilityAndEquityTotal],
          ] as const
        ).map(([label, amount]) => (
          <div key={label} className="min-w-0">
            <span className="block truncate font-acumin lk-text-6xs text-[#707070]">
              {label}
            </span>
            <span className="block font-acumin lk-text-4xs text-black tabular-nums">
              {statementCurrency(amount)}
            </span>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[#ededed]">
              <div
                className="h-full rounded-full bg-black"
                style={{
                  width: `${Math.min(100, (Math.max(amount, 0) / scale) * 100)}%`,
                }}
                aria-hidden="true"
              />
            </div>
          </div>
        ))}
      </div>
      <p
        className={`mt-2 text-center font-acumin lk-text-4xs tabular-nums ${difference === 0 ? "text-[#707070]" : "text-red-700"}`}
      >
        貸借差額 {statementCurrency(difference)}
      </p>
    </div>
  );
}

// 目盛りの刻み。1・2・2.5・5・10 の系列に丸めて読みやすい軸にする。
export function niceStep(raw: number): number {
  const exponent = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const multiple of [1, 2, 2.5, 5, 10]) {
    if (raw <= multiple * exponent) return multiple * exponent;
  }
  return 10 * exponent;
}

// 資金は赤字（マイナス残高）もあり得るので、0 起点に固定せず上下とも丸める。
export function niceAxis(min: number, max: number) {
  const lowest = Math.min(min, 0);
  const highest = Math.max(max, 0);
  const step = niceStep((highest - lowest || 1) / 4);
  const lo = Math.floor(lowest / step) * step;
  const hi = Math.ceil(highest / step) * step || step;
  const ticks: number[] = [];
  for (let value = lo; value <= hi + step / 2; value += step) {
    ticks.push(Math.round(value));
  }
  return { lo, hi: hi === lo ? lo + step : hi, ticks };
}

export const AXIS_FORMAT = new Intl.NumberFormat("ja-JP");

/**
 * 資金推移の折れ線。実績は実線、目標は破線、安全水準は薄いグリーンの帯。
 * 目標が無い（財務前提の売上見込み未入力）ときは破線を描かない。
 */
export function CashTrendChart({
  points,
  targets,
  safetyLevel,
  ariaLabel,
}: {
  points: Array<{ label: string; value: number }>;
  targets: number[] | null;
  safetyLevel: number;
  ariaLabel: string;
}) {
  const width = 660;
  const height = 240;
  const padL = 78;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const values = [
    ...points.map((point) => point.value),
    ...(targets ?? []),
    safetyLevel,
  ];
  const { lo, hi, ticks } = niceAxis(Math.min(...values), Math.max(...values));
  const xOf = (index: number) =>
    padL + (plotW * index) / Math.max(points.length - 1, 1);
  const yOf = (value: number) => padT + (1 - (value - lo) / (hi - lo)) * plotH;
  const line = (series: number[]) =>
    series
      .map(
        (value, index) => `${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`,
      )
      .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <text x={4} y={padT} fill="#888888" fontSize="9">
        （円）
      </text>
      {safetyLevel > 0 ? (
        <rect
          x={padL}
          y={yOf(safetyLevel)}
          width={plotW}
          height={Math.max(yOf(0) - yOf(safetyLevel), 0)}
          fill="#e8f1e9"
        />
      ) : null}
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={padL}
            x2={width - padR}
            y1={yOf(tick)}
            y2={yOf(tick)}
            stroke={tick === 0 ? "#d4d4d4" : "#ededed"}
            strokeWidth={1}
          />
          <text
            x={padL - 8}
            y={yOf(tick) + 3}
            textAnchor="end"
            fill="#888888"
            fontSize="9"
          >
            {AXIS_FORMAT.format(tick)}
          </text>
        </g>
      ))}
      {targets ? (
        <polyline
          fill="none"
          stroke="#707070"
          strokeWidth={1.5}
          strokeDasharray="6 4"
          points={line(targets)}
        />
      ) : null}
      <polyline
        fill="none"
        stroke="#111111"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={line(points.map((point) => point.value))}
      />
      {points.map((point, index) => (
        <circle
          key={`dot-${point.label}`}
          cx={xOf(index)}
          cy={yOf(point.value)}
          r={2.5}
          fill="#111111"
        />
      ))}
      {points.map((point, index) => (
        <text
          key={`x-${point.label}`}
          x={xOf(index)}
          y={height - 8}
          textAnchor="middle"
          fill="#888888"
          fontSize="9"
        >
          {point.label}
        </text>
      ))}
    </svg>
  );
}

// 構成比のグレースケール。色数を増やさず、濃さの順で大きい項目から並べる。
export const COMPOSITION_COLORS = [
  "#111111",
  "#565656",
  "#8a8a8a",
  "#b5b5b5",
  "#dcdcdc",
];

export function DonutChart({
  items,
  ariaLabel,
}: {
  items: CompositionItem[];
  ariaLabel: string;
}) {
  const radius = 42;
  const strokeWidth = 16;
  const circumference = 2 * Math.PI * radius;
  let consumed = 0;

  return (
    <svg
      viewBox="0 0 120 120"
      className="h-24 w-24 shrink-0"
      role="img"
      aria-label={ariaLabel}
    >
      <g transform="rotate(-90 60 60)">
        <circle
          cx={60}
          cy={60}
          r={radius}
          fill="none"
          stroke="#ededed"
          strokeWidth={strokeWidth}
        />
        {items.map((item, index) => {
          const length = (item.ratio / 100) * circumference;
          const offset = consumed;
          consumed += length;
          return (
            <circle
              key={item.label}
              cx={60}
              cy={60}
              r={radius}
              fill="none"
              stroke={COMPOSITION_COLORS[index % COMPOSITION_COLORS.length]}
              strokeWidth={strokeWidth}
              strokeDasharray={`${length.toFixed(2)} ${(circumference - length).toFixed(2)}`}
              strokeDashoffset={-offset}
            />
          );
        })}
      </g>
      <text
        x={60}
        y={65}
        textAnchor="middle"
        fill="#111111"
        fontSize="16"
        className="tabular-nums"
      >
        100%
      </text>
    </svg>
  );
}

/** 売上高・売上原価・販管費の構成比カード。ドーナツと項目名・金額・構成比。 */
export function CompositionCard({
  title,
  total,
  items,
  emptyMessage,
}: {
  title: string;
  total: number;
  items: CompositionItem[];
  emptyMessage: string;
}) {
  return (
    <Panel
      radius="rounded"
      className="min-w-0"
      aria-label={title}
      title={<span className={panelTitleClassName}>{title}</span>}
      actions={
        <span className="font-acumin lk-text-4xs text-[#707070] tabular-nums">
          合計 {currency(total)}
        </span>
      }
    >
      {items.length === 0 ? (
        <p className="font-acumin lk-text-3xs text-[#707070]">{emptyMessage}</p>
      ) : (
        <div className="flex items-center gap-4">
          <DonutChart items={items} ariaLabel={`${title}のドーナツグラフ`} />
          <ul className="min-w-0 flex-1 space-y-2">
            {items.map((item, index) => (
              <li key={item.label} className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        COMPOSITION_COLORS[index % COMPOSITION_COLORS.length],
                    }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate font-acumin lk-text-3xs text-black">
                    {item.label}
                  </span>
                  <span className="shrink-0 font-acumin lk-text-3xs text-black tabular-nums">
                    {percent(item.ratio)}
                  </span>
                </div>
                <span className="ml-4 block font-acumin lk-text-6xs text-[#707070] tabular-nums">
                  {currency(item.amount)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

/** 利益構造・キャッシュブリッジの1ブロック。項目名と金額を縦に並べる。 */
export function FlowBlock({
  label,
  value,
  emphasis,
  size = "md",
  display,
  positive,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
  size?: "sm" | "md";
  /** 既定の▲表記ではなく符号付きで見せたいときの上書き。 */
  display?: string;
  /** 増加を緑で示す（C/F の現金増減額）。 */
  positive?: boolean;
}) {
  return (
    <div
      className={`min-w-0 flex-1 border py-2.5 text-center ${
        size === "sm" ? "px-1.5" : "px-3"
      } ${boxRadiusClassName} bg-white ${
        emphasis ? "border-black" : "border-[#d4d4d4]"
      }`}
    >
      <p className="font-acumin lk-text-4xs leading-tight text-[#474747]">
        {label}
      </p>
      <p
        className={`mt-1 font-acumin font-medium tabular-nums ${
          size === "sm" ? "lk-text-sm" : "lk-text-2xl"
        } ${
          value < 0
            ? "text-red-700"
            : positive && value > 0
              ? "text-[#16844b]"
              : "text-black"
        }`}
      >
        {display ?? signedCurrency(value)}
      </p>
    </div>
  );
}

export function FlowOperator({ symbol }: { symbol: string }) {
  return (
    <span
      className="shrink-0 self-center text-center font-acumin lk-text-4xl text-[#474747]"
      aria-hidden="true"
    >
      {symbol}
    </span>
  );
}

export function EmptyIcon({ icon }: { icon: string }) {
  return (
    <i className={`${icon} lk-text-lg text-[#474747]`} aria-hidden="true" />
  );
}
