import { useMemo } from "react";

type FunnelStage = {
  key: string;
  label: string;
  subLabel: string;
  kpiKeys: string[];
  rateLabel?: string;
  defaultRate?: number;
};

const FUNNEL_STAGES: FunnelStage[] = [
  {
    key: "awareness",
    label: "認知",
    subLabel: "まず知ってもらう",
    kpiKeys: ["reach", "cpm", "story_views", "cpc"],
    rateLabel: "関心率",
    defaultRate: 8,
  },
  {
    key: "interest",
    label: "関心・興味",
    subLabel: "もっと見たいと思う",
    kpiKeys: ["save_rate", "story_reach"],
    rateLabel: "欲求化率",
    defaultRate: 35,
  },
  {
    key: "desire",
    label: "欲求",
    subLabel: "商品を欲しいと思う",
    kpiKeys: ["exit_rate"],
    rateLabel: "確信化率",
    defaultRate: 45,
  },
  {
    key: "conviction",
    label: "確信・検討",
    subLabel: "買う理由を持つ",
    kpiKeys: ["cpa", "roas"],
    rateLabel: "購入率（CVR）",
    defaultRate: 3,
  },
  {
    key: "action",
    label: "行動・購入",
    subLabel: "注文し、売上につながる",
    kpiKeys: ["sales", "aov", "set_purchase_rate", "inventory_turnover"],
  },
  {
    key: "satisfaction",
    label: "満足・継続",
    subLabel: "また買いたいと思う",
    kpiKeys: ["repeat_rate", "return_rate", "ltv"],
  },
];

const TRANSITION_KPIS_BY_STAGE: Partial<Record<string, string[]>> = {
  awareness: ["profile_rate", "follow_rate"],
  desire: ["link_click"],
  conviction: ["cvr"],
};

export type FunnelCalculation = FunnelStage & {
  required: number;
  rate?: number;
};

export function calculateSalesFunnel(
  targetItems: number,
  itemsPerOrder: number,
  rates: number[],
): FunnelCalculation[] {
  const safeItems = Math.max(1, Math.round(targetItems));
  const safeItemsPerOrder = Math.max(1, itemsPerOrder);
  const orders = Math.ceil(safeItems / safeItemsPerOrder);
  const required = new Array<number>(FUNNEL_STAGES.length).fill(orders);

  for (let index = FUNNEL_STAGES.length - 3; index >= 0; index -= 1) {
    const rate = Math.min(
      100,
      Math.max(0.1, rates[index] ?? FUNNEL_STAGES[index].defaultRate ?? 1),
    );
    required[index] = Math.ceil(required[index + 1] / (rate / 100));
  }

  return FUNNEL_STAGES.map((stage, index) => ({
    ...stage,
    required: required[index],
    rate: rates[index],
  }));
}

export type FunnelKpiMetric = {
  key: string;
  label: string;
  valueText: string;
  targetText: string;
  percent: number | null;
  isSample: boolean;
  selectable?: boolean;
};

type KpiSalesFunnelProps = {
  metrics: FunnelKpiMetric[];
  selectedKey: string;
  onSelect: (key: string) => void;
  isOpen: boolean;
};

function progressLabel(percent: number | null) {
  if (percent === null) {
    return "達成率 未算出";
  }
  return `${percent >= 100 ? "達成" : "未達成"} ${percent.toFixed(1)}%`;
}

function statusColor(percent: number | null) {
  if (percent === null) {
    return "border-[#e8e8e8] bg-[#fafafa]";
  }
  return percent >= 100
    ? "border-[#b9d9f5] bg-[#eef7ff]"
    : "border-[#f1c4c4] bg-[#fff1f1]";
}

export function KpiSalesFunnel({
  metrics,
  selectedKey,
  onSelect,
  isOpen,
}: KpiSalesFunnelProps) {
  const metricByKey = useMemo(
    () => new Map(metrics.map((metric) => [metric.key, metric])),
    [metrics],
  );

  return (
    <section
      className="border-b border-[#ededed] pb-4"
      aria-label="購買ファネルとKPIの対応"
    >
      {isOpen ? (
        <div
          className="mx-auto flex max-w-180 flex-col items-center"
          aria-label="購買ファネルとKPIの対応"
        >
          {FUNNEL_STAGES.map((stage, index) => {
            const stageMetrics = stage.kpiKeys
              .map((key) => metricByKey.get(key))
              .filter((metric): metric is FunnelKpiMetric => Boolean(metric));
            const transitionMetrics = (
              TRANSITION_KPIS_BY_STAGE[stage.key] ?? []
            )
              .map((key) => metricByKey.get(key))
              .filter((metric): metric is FunnelKpiMetric => Boolean(metric));
            const width = `${100 - index * 9}%`;
            return (
              <div
                key={stage.key}
                className="relative"
                style={{ width }}
                data-funnel-stage={stage.key}
              >
                <div
                  className="overflow-hidden rounded-lg border border-[#d4d4d4] bg-white px-3 py-3"
                  data-funnel-stage-frame
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="font-acumin text-xs font-medium tracking-widest text-black">
                      {index + 1}. {stage.label}
                    </span>
                    <span className="font-acumin text-2.5 text-[#777777]">
                      {stage.subLabel}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-1.5 lg:grid-cols-2">
                    {stageMetrics.map((metric) => {
                      const isSelected = metric.key === selectedKey;
                      return (
                        <button
                          type="button"
                          key={metric.key}
                          aria-pressed={isSelected}
                          onClick={() => onSelect(metric.key)}
                          className={`min-h-11 rounded-md border px-2 py-1.5 text-left text-black transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black ${statusColor(metric.percent)} ${isSelected ? "border-2 border-black" : "hover:border-[#888888]"}`}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate font-acumin text-2.75">
                              {metric.label}
                            </span>
                            <span className="shrink-0 font-acumin text-[9px] text-[#666666]">
                              {metric.isSample
                                ? `参考値・${progressLabel(metric.percent)}`
                                : progressLabel(metric.percent)}
                            </span>
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-1 font-acumin text-2.5 text-[#555555] tabular-nums">
                            <span>現状 {metric.valueText}</span>
                            <span aria-hidden="true">→</span>
                            <span>目標 {metric.targetText}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {transitionMetrics.length > 0 ? (
                  <div
                    className="relative z-10 w-full py-1"
                    aria-label={`${stage.label}から次の段階への転換KPI`}
                    data-funnel-connector
                  >
                    <div className="mx-auto w-[82%]">
                      <div className="grid min-w-0 flex-6 grid-cols-1 gap-1.5">
                        {transitionMetrics.map((transitionMetric) => (
                          <button
                            type="button"
                            key={transitionMetric.key}
                            aria-pressed={transitionMetric.key === selectedKey}
                            disabled={transitionMetric.selectable === false}
                            onClick={() => onSelect(transitionMetric.key)}
                            className={`min-h-11 min-w-0 rounded-md border px-2 py-1.5 text-center text-black transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-default ${statusColor(transitionMetric.percent)} ${transitionMetric.key === selectedKey ? "border-2 border-black" : "enabled:hover:border-black"}`}
                          >
                            <span className="block truncate font-acumin text-2.75 font-medium">
                              {transitionMetric.label}
                            </span>
                            <span className="mt-0.5 block truncate font-acumin text-2.5 text-[#555555] tabular-nums">
                              {progressLabel(transitionMetric.percent)}・現状{" "}
                              {transitionMetric.valueText} → 目標{" "}
                              {transitionMetric.targetText}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
