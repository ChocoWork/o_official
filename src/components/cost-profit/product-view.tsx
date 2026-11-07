import { Button } from "@/components/ui/Button/Button";
import {
  COST_LABELS,
  currency,
  percent,
  inputClassName,
  panelClassName,
  sumProductUnitCost,
} from "./constants";
import { MetricCard } from "./shared-ui";
import type { CostProfitModel } from "./use-cost-profit-model";

export function ProductView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    seasonOptions,
    seasonKey,
    setSeasonKey,
    seasonLabel,
    products,
    selectedProductId,
    setSelectedProductId,
    isSaving,
    seasonForecast,
    selectedProduct,
    selectedUnitCost,
    selectedGrossProfit,
    selectedGrossMargin,
    updateProduct,
    handleSaveProduct,
  } = model;
  return (
    <div className="space-y-5">
      {/* 商品原価だけはコレクション単位（シーズン）で見る。会計期間とは独立した軸。 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 font-acumin lk-text-4xs text-[#707070]">
          シーズン
        </span>
        {seasonOptions.map((season) => (
          <Button
            key={season.key}
            variant="outline"
            size="2xs"
            shape="rounded"
            selected={season.key === seasonKey}
            onClick={() => setSeasonKey(season.key)}
            className="font-acumin tracking-wider"
          >
            {season.label}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard
          label="製造原価 合計"
          value={currency(seasonForecast.manufacturingCost)}
          note={seasonLabel}
        />
        <MetricCard
          label="平均原価（1点）"
          value={currency(
            seasonForecast.manufacturingCost /
              Math.max(
                1,
                products.reduce((sum, item) => sum + item.plannedQuantity, 0),
              ),
          )}
          note="予定数量で加重平均"
        />
        <MetricCard
          label="予定生産数"
          value={`${products.reduce((sum, item) => sum + item.plannedQuantity, 0)}点`}
          note={`${products.length}アイテム`}
        />
        <MetricCard
          label="原価率（平均）"
          value={percent(
            seasonForecast.sales > 0
              ? (seasonForecast.manufacturingCost / seasonForecast.sales) * 100
              : 0,
          )}
          note="売価シミュレーション連動"
        />
        <MetricCard
          label="粗利益（見込み）"
          value={currency(seasonForecast.grossProfit)}
          note="商品計画ベース"
          positive
        />
        <MetricCard
          label="粗利率（見込み）"
          value={percent(seasonForecast.grossMargin)}
          note="目安 55%以上"
          positive={seasonForecast.grossMargin >= 55}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className={`${panelClassName} min-w-0`}>
          <h4 className="mb-3 font-acumin lk-text-sm font-medium tracking-widest text-black">
            アイテム別 原価一覧
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full min-w-190 border-collapse">
              <thead>
                <tr className="border-b border-[#d4d4d4]">
                  {[
                    "アイテム",
                    "カテゴリ",
                    "生産方式",
                    "予定数",
                    "製造原価（合計）",
                    "原価（1点）",
                    "売価",
                    "原価率",
                    "粗利益（1点）",
                  ].map((heading) => (
                    <th
                      key={heading}
                      className="px-2 py-2 text-left font-acumin lk-text-4xs font-normal text-[#474747]"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {products.map((product) => {
                  const unitCost = sumProductUnitCost(product);
                  const isSelected = product.id === selectedProductId;
                  return (
                    <tr
                      key={product.id}
                      className={`cursor-pointer border-b border-[#ededed] ${isSelected ? "bg-[#f7f7f7]" : "hover:bg-[#fafafa]"}`}
                      onClick={() => setSelectedProductId(product.id)}
                    >
                      <td className="px-2 py-3">
                        <p className="font-acumin lk-text-3xs font-medium text-black">
                          {product.id}
                        </p>
                        <p className="mt-0.5 font-acumin lk-text-4xs text-[#707070]">
                          {product.name}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-acumin lk-text-3xs text-black">
                        {product.category}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-acumin lk-text-3xs text-black">
                        {product.productionMethod}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black">
                        {product.plannedQuantity}点
                      </td>
                      <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black">
                        {currency(unitCost * product.plannedQuantity)}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black">
                        {currency(unitCost)}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black">
                        {currency(product.sellingPrice)}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black">
                        {percent(
                          product.sellingPrice > 0
                            ? (unitCost / product.sellingPrice) * 100
                            : 0,
                        )}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black">
                        {currency(product.sellingPrice - unitCost)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <aside className={`${panelClassName} h-fit`}>
          <p className="font-acumin lk-text-4xs text-[#707070]">
            原価内訳（1点あたり）
          </p>
          <h4 className="mt-1 font-acumin lk-text-sm font-medium text-black">
            {selectedProduct.name}
          </h4>
          <p className="font-acumin lk-text-4xs text-[#707070]">
            {selectedProduct.id}
          </p>
          <div className="mt-4 grid grid-cols-[112px_1fr] items-center gap-5">
            <div
              className="relative h-28 w-28 rounded-full"
              style={{
                background: `conic-gradient(${COST_LABELS.map((item, index) => {
                  const before = COST_LABELS.slice(0, index).reduce(
                    (sum, line) => sum + selectedProduct.costs[line.key],
                    0,
                  );
                  const start =
                    selectedUnitCost > 0
                      ? (before / selectedUnitCost) * 100
                      : 0;
                  const end =
                    selectedUnitCost > 0
                      ? ((before + selectedProduct.costs[item.key]) /
                          selectedUnitCost) *
                        100
                      : 0;
                  return `${item.color} ${start}% ${end}%`;
                }).join(", ")})`,
              }}
              role="img"
              aria-label={`${selectedProduct.name}の原価構成`}
            >
              <div className="absolute inset-5.5 flex flex-col items-center justify-center rounded-full bg-white">
                <span className="font-acumin lk-text-3xs font-medium text-black">
                  {currency(selectedUnitCost)}
                </span>
                <span className="font-acumin lk-text-7xs text-[#707070]">
                  1点あたり
                </span>
              </div>
            </div>
            <div className="space-y-2">
              {COST_LABELS.map((item) => (
                <div
                  key={item.key}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="flex min-w-0 items-center gap-1.5 font-acumin lk-text-6xs text-[#474747]">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: item.color }}
                    />
                    <span className="truncate">{item.label}</span>
                  </span>
                  <span className="font-acumin lk-text-6xs text-black tabular-nums">
                    {percent(
                      selectedUnitCost > 0
                        ? (selectedProduct.costs[item.key] / selectedUnitCost) *
                            100
                        : 0,
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-5 space-y-2 border-t border-[#d4d4d4] pt-4">
            {COST_LABELS.map((item) => (
              <label
                key={item.key}
                className="grid grid-cols-[1fr_112px] items-center gap-3"
              >
                <span className="font-acumin lk-text-4xs text-[#474747]">
                  {item.label}
                </span>
                <span className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 font-acumin lk-text-3xs text-[#888888]">
                    ¥
                  </span>
                  <input
                    type="number"
                    min="0"
                    value={selectedProduct.costs[item.key]}
                    onChange={(event) =>
                      updateProduct(selectedProduct.id, (product) => ({
                        ...product,
                        costs: {
                          ...product.costs,
                          [item.key]: Math.max(
                            0,
                            Number(event.target.value) || 0,
                          ),
                        },
                      }))
                    }
                    className={`${inputClassName} h-8 pl-7 text-right lk-text-3xs`}
                    aria-label={`${selectedProduct.name} ${item.label}`}
                  />
                </span>
              </label>
            ))}
            <Button
              variant="primary"
              size="sm"
              className="mt-4 w-full font-acumin"
              onClick={() => void handleSaveProduct()}
              disabled={isSaving}
            >
              {isSaving ? "保存中..." : "保存"}
            </Button>
          </div>
        </aside>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
        <div className={panelClassName}>
          <h4 className="font-acumin lk-text-sm font-medium tracking-widest text-black">
            売価シミュレーション
          </h4>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label>
              <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
                売価（1点あたり）
              </span>
              <input
                type="number"
                min="0"
                step="100"
                value={selectedProduct.sellingPrice}
                onChange={(event) =>
                  updateProduct(selectedProduct.id, (product) => ({
                    ...product,
                    sellingPrice: Math.max(0, Number(event.target.value) || 0),
                  }))
                }
                className={inputClassName}
                aria-label="売価（1点あたり）"
              />
            </label>
            <label>
              <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
                予定生産数
              </span>
              <input
                type="number"
                min="0"
                value={selectedProduct.plannedQuantity}
                onChange={(event) =>
                  updateProduct(selectedProduct.id, (product) => ({
                    ...product,
                    plannedQuantity: Math.max(
                      0,
                      Math.round(Number(event.target.value) || 0),
                    ),
                  }))
                }
                className={inputClassName}
                aria-label="予定生産数"
              />
            </label>
            <div>
              <span className="block font-acumin lk-text-4xs text-[#474747]">
                粗利益（1点あたり）
              </span>
              <p className="mt-2 font-acumin lk-text-4xl font-medium text-black">
                {currency(selectedGrossProfit)}
              </p>
            </div>
            <div>
              <span className="block font-acumin lk-text-4xs text-[#474747]">
                粗利率
              </span>
              <p
                className={`mt-2 font-acumin lk-text-4xl font-medium ${selectedGrossMargin >= 55 ? "text-[#16844b]" : "text-[#a16600]"}`}
              >
                {percent(selectedGrossMargin)}
              </p>
            </div>
          </div>
          <p className="mt-4 font-acumin lk-text-4xs text-[#707070]">
            売価・数量・原価内訳を変更すると、上部の一覧とシーズン全体の見込みが即時更新されます。
          </p>
        </div>
        <div className={panelClassName}>
          <h4 className="font-acumin lk-text-sm font-medium tracking-widest text-black">
            選択商品の見込み
          </h4>
          {[
            [
              "売上",
              selectedProduct.sellingPrice * selectedProduct.plannedQuantity,
            ],
            ["製造原価", selectedUnitCost * selectedProduct.plannedQuantity],
            ["粗利益", selectedGrossProfit * selectedProduct.plannedQuantity],
          ].map(([label, value], index) => (
            <div
              key={String(label)}
              className={`flex items-center justify-between py-3 ${index < 2 ? "border-b border-[#ededed]" : "border-t border-black"}`}
            >
              <span className="font-acumin lk-text-3xs text-black">{label}</span>
              <span
                className={`font-acumin lk-text-sm font-medium ${index === 2 ? "text-[#16844b]" : "text-black"}`}
              >
                {currency(Number(value))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
