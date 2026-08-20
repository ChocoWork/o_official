// 税務レポートの5タブで共有する小さな部品と表示トークン。
// 面は Panel（--radius-md 8px）、内側の枠は一段小さい --radius-sm（6px）で
// 入れ子の階層を作る。財務概要タブと同じ組み方に揃える。

import type { ReactNode } from "react";
import { Graph } from "@/components/ui/Graph/Graph";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";

export const currency = (value: number) =>
  `¥${Math.round(value).toLocaleString("ja-JP")}`;

/** 増減は符号を明示する（前年比・調整額）。 */
export const signedCurrency = (value: number) =>
  value > 0
    ? `+¥${Math.round(value).toLocaleString("ja-JP")}`
    : value < 0
      ? `-¥${Math.round(-value).toLocaleString("ja-JP")}`
      : "¥0";

export const percent = (value: number) => `${value.toFixed(1)}%`;

export const panelTitleClassName =
  "font-acumin text-sm font-medium tracking-widest text-black";
export const boxRadiusClassName = "rounded-sm";

/** 税務レポート共通の色。状態は緑＝完了、橙＝要対応、灰＝未着手。 */
export const TAX_DONE_COLOR = "#16844b";
export const TAX_TODO_COLOR = "#d98324";
export const TAX_IDLE_COLOR = "#c4c4c4";
/** 推移グラフの色。課税売上＝緑、必要経費＝灰、所得＝黒。 */
export const TAX_SALES_COLOR = "#5aa678";
export const TAX_EXPENSE_COLOR = "#c9c9c9";
export const TAX_INCOME_COLOR = "#111111";
/** 調整の向き。加算＝橙、減算＝青。 */
export const TAX_ADD_COLOR = "#e07b28";
export const TAX_SUBTRACT_COLOR = "#3d8fe0";

/**
 * 上段の指標カード。左に意味を表すアイコン（または図）、右に指標と前年比。
 * 図を差し込むときは leading に Graph を渡す。
 */
export function TaxMetricCard({
  icon,
  leading,
  label,
  value,
  note,
  tone = "neutral",
}: {
  icon?: string;
  leading?: ReactNode;
  label: string;
  value: string;
  note?: ReactNode;
  tone?: "neutral" | "positive" | "warning";
}) {
  const noteColor =
    tone === "positive"
      ? "text-[#16844b]"
      : tone === "warning"
        ? "text-[#b45309]"
        : "text-[#707070]";

  return (
    <div
      className={`flex items-center gap-3 border border-[#d4d4d4] bg-white p-4 ${boxRadiusClassName}`}
    >
      {leading ?? (
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center border border-[#ededed] bg-[#fafafa] ${boxRadiusClassName}`}
          aria-hidden="true"
        >
          <i
            className={`${icon ?? "ri-file-list-3-line"} text-base text-black`}
          />
        </span>
      )}
      <div className="min-w-0">
        <p className="font-acumin text-2.75 tracking-wider text-[#474747]">
          {label}
        </p>
        {/* 桁の多い金額でも欠けないよう、字幅は詰めて折り返しを許す。 */}
        <p className="mt-1 font-acumin text-lg font-medium text-black tabular-nums">
          {value}
        </p>
        {note ? (
          <p className={`mt-1 font-acumin text-2.75 ${noteColor}`}>{note}</p>
        ) : null}
      </div>
    </div>
  );
}

/** 進捗リング。申告準備・ページ完成度のように「率」を1つだけ示すときに使う。 */
export function ProgressRing({
  value,
  size = 48,
  color = TAX_DONE_COLOR,
  label,
}: {
  /** 0〜100 */
  value: number;
  size?: number;
  color?: string;
  label?: ReactNode;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <Graph
      variant="donut"
      size={size}
      showLegend={false}
      centerLabel={label}
      data={[
        { label: "完了", value: clamped, color },
        { label: "残り", value: 100 - clamped, color: "#ededed" },
      ]}
    />
  );
}

/** 会計上の利益 →（調整）→ 課税所得 → 税額 の1ブロック。 */
export function FlowBlock({
  label,
  value,
  note,
  tone = "neutral",
  actions,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "neutral" | "add" | "subtract" | "result" | "tax";
  actions?: ReactNode;
}) {
  const toneClassName = {
    neutral: "border-[#d4d4d4] bg-[#fafafa]",
    add: "border-[#f0d3b6] bg-[#fdf6ef]",
    subtract: "border-[#c8ddf5] bg-[#f1f6fd]",
    result: "border-[#ecd9a8] bg-[#fdf8ec]",
    tax: "border-[#bcdcc9] bg-[#eff7f2]",
  }[tone];

  return (
    <div
      className={`min-w-0 flex-1 border px-3 py-2.5 ${toneClassName} ${boxRadiusClassName}`}
    >
      <p className="font-acumin text-2.75 tracking-wider text-[#474747]">
        {label}
      </p>
      <p className="mt-1 font-acumin text-sm font-medium text-black tabular-nums">
        {value}
      </p>
      <div className="mt-1 flex items-center gap-1.5">
        {note ? (
          <span className="font-acumin text-2.5 text-[#707070]">{note}</span>
        ) : null}
        {actions}
      </div>
    </div>
  );
}

/** ブロックの間の演算子。狭い画面では縦向きに畳む。 */
export function FlowOperator({ symbol }: { symbol: string }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center font-acumin text-sm text-[#707070]"
      aria-hidden="true"
    >
      {symbol}
    </span>
  );
}

/** 完了・要対応・未着手の3状態を同じ見た目で出す。 */
export function StateBadge({
  state,
  children,
}: {
  state: "done" | "todo" | "idle";
  children: ReactNode;
}) {
  const icon = {
    done: "ri-checkbox-circle-line",
    todo: "ri-error-warning-line",
    idle: "ri-subtract-line",
  }[state];

  return (
    <StatusBadge
      tone={
        state === "done" ? "positive" : state === "todo" ? "warning" : "neutral"
      }
      accent={state !== "idle"}
      shape="rounded"
      size="3xs"
      className="shrink-0 whitespace-nowrap font-acumin"
    >
      <span className="inline-flex items-center gap-1">
        <i className={icon} aria-hidden="true" />
        {children}
      </span>
    </StatusBadge>
  );
}

/** 件数付きの凡例（完了 3／要対応 2／未着手 0）。 */
export function CountLegend({
  items,
}: {
  items: ReadonlyArray<{ label: string; count: number; color: string }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((item) => (
        <span
          key={item.label}
          className="inline-flex items-center gap-1.5 font-acumin text-2.75 text-[#474747]"
        >
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: item.color }}
            aria-hidden="true"
          />
          {item.label}
          <span className="text-black tabular-nums">{item.count}</span>
        </span>
      ))}
    </div>
  );
}

/** 表の共通クラス。決算書系の表はどのページでも同じ罫線・字送りにする。 */
export const tableHeadClassName =
  "px-2 py-2 text-left font-acumin text-2.75 font-normal text-[#474747]";
export const tableCellClassName = "px-2 py-2 font-acumin text-xs text-black";
export const tableNumberClassName =
  "px-2 py-2 text-right font-acumin text-xs text-black tabular-nums";
export const tableRowClassName = "border-b border-[#ededed]";
export const tableTotalRowClassName = "border-t border-black";
