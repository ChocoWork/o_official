'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Drawer } from '@/components/ui/Drawer/Drawer';
import { TabSegmentControl } from '@/components/ui/TabSegmentControl/TabSegmentControl';
import { clientFetch } from '@/lib/client-fetch';
import {
  PRODUCT_CATEGORIES,
  PRODUCT_COST_TYPES,
  PRODUCT_COST_TYPE_LABELS,
} from '@/lib/finance/product-costing';
import type {
  AllocationDraftLine,
  CostingExpense,
  ItemCostSummary,
  ProductCategory,
  ProductCostingResponse,
  ProductCostType,
} from '@/lib/finance/product-costing';

type SeasonOption = { key: string; label: string };
type ProductCostSectionProps = {
  seasonKey: string;
  seasonOptions: SeasonOption[];
  onSeasonChange: (seasonKey: string) => void;
};
type ProductCostView = 'overview' | 'allocations' | 'items';
type AllocationFilter = 'all' | 'unallocated' | 'allocated';
type DraftLine = AllocationDraftLine & { key: string };

const VIEW_TABS = [
  { key: 'overview', label: 'シーズン概要' },
  { key: 'allocations', label: '支出配賦' },
  { key: 'items', label: 'アイテム' },
];
const PANEL = 'rounded-xl border border-black/10 bg-white p-4 sm:p-5';
const INPUT = 'h-10 w-full rounded-md border border-black/20 bg-white px-3 font-acumin text-sm text-black outline-none focus:border-black';

function currency(value: number): string {
  return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(value);
}

function percent(value: number | null): string {
  return value === null ? '未入力' : `${value.toFixed(1)}%`;
}

function newDraftLine(amount: number): DraftLine {
  return {
    key: crypto.randomUUID(), targetType: 'item', itemId: null,
    costType: 'material', otherLabel: null, amount,
  };
}

async function parseMutation(response: Response): Promise<void> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(payload?.error ?? '保存に失敗しました。');
}

function Metric({ label, value, note, warning = false, positive = false }: {
  label: string; value: string; note: string; warning?: boolean; positive?: boolean;
}) {
  return (
    <div className={PANEL}>
      <p className="font-acumin text-[11px] tracking-wider text-[#707070]">{label}</p>
      <p className={`mt-2 font-acumin text-xl font-medium ${warning ? 'text-[#a16600]' : positive ? 'text-[#16844b]' : 'text-black'}`}>{value}</p>
      <p className="mt-1 font-acumin text-[10px] text-[#888888]">{note}</p>
    </div>
  );
}

export function ProductCostSection({ seasonKey, seasonOptions, onSeasonChange }: ProductCostSectionProps) {
  const [data, setData] = useState<ProductCostingResponse['data'] | null>(null);
  const [view, setView] = useState<ProductCostView>('overview');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [allocationFilter, setAllocationFilter] = useState<AllocationFilter>('unallocated');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | ProductCategory>('ALL');
  const [selectedExpense, setSelectedExpense] = useState<CostingExpense | null>(null);
  const [allocationLines, setAllocationLines] = useState<DraftLine[]>([]);
  const [isAddItemOpen, setIsAddItemOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ItemCostSummary | null>(null);
  const [newItem, setNewItem] = useState<{ category: ProductCategory; provisionalName: string }>({
    category: 'TOPS', provisionalName: '',
  });
  const [itemForm, setItemForm] = useState({
    category: 'TOPS' as ProductCategory, provisionalName: '', plannedQuantity: 0,
    sellingPrice: 0, fabricMetersPerUnit: 0,
  });

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await clientFetch(`/api/admin/accounting/product-costs?season=${encodeURIComponent(seasonKey)}`, { cache: 'no-store' });
      const payload = (await response.json().catch(() => null)) as ProductCostingResponse | { error?: string } | null;
      if (!response.ok || !payload || !('data' in payload)) {
        throw new Error(payload && 'error' in payload ? payload.error : '商品原価データの取得に失敗しました。');
      }
      setData(payload.data);
      setMessage(null);
    } catch (error) {
      setData(null);
      setMessage({ text: error instanceof Error ? error.message : '商品原価データの取得に失敗しました。', error: true });
    } finally {
      setIsLoading(false);
    }
  }, [seasonKey]);

  useEffect(() => { void loadData(); }, [loadData]);

  const mutate = useCallback(async (body: Record<string, unknown>, success: string) => {
    setIsSaving(true);
    try {
      await parseMutation(await clientFetch('/api/admin/accounting/product-costs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }));
      await loadData();
      setMessage({ text: success, error: false });
      return true;
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : '保存に失敗しました。', error: true });
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [loadData]);

  const openExpense = (expense: CostingExpense) => {
    setSelectedExpense(expense);
    setAllocationLines(expense.allocations.length > 0
      ? expense.allocations.map((line) => ({
        key: String(line.id), targetType: line.targetType, itemId: line.itemId,
        costType: line.costType, otherLabel: line.otherLabel, amount: line.amount,
      }))
      : [newDraftLine(expense.amount)]);
  };
  const allocationTotal = allocationLines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const allocationDifference = (selectedExpense?.amount ?? 0) - allocationTotal;
  const allocationsValid = Boolean(selectedExpense && allocationDifference === 0 && allocationLines.length > 0
    && allocationLines.every((line) => line.amount > 0
      && (line.targetType === 'season_common' || line.itemId !== null)
      && (line.costType !== 'other' || Boolean(line.otherLabel?.trim()))));

  const updateLine = (key: string, values: Partial<DraftLine>) => {
    setAllocationLines((current) => current.map((line) => line.key === key ? { ...line, ...values } : line));
  };
  const filteredExpenses = useMemo(() => (data?.expenses ?? []).filter((expense) =>
    allocationFilter === 'all' || (allocationFilter === 'allocated' ? expense.allocated : !expense.allocated)), [data, allocationFilter]);
  const filteredItems = useMemo(() => (data?.items ?? []).filter((item) =>
    categoryFilter === 'ALL' || item.category === categoryFilter), [data, categoryFilter]);

  const createItem = async () => {
    if (!newItem.provisionalName.trim()) return;
    const saved = await mutate({ operation: 'item.create', item: {
      seasonKey, category: newItem.category, provisionalName: newItem.provisionalName,
      plannedQuantity: 0, sellingPrice: 0, fabricMetersPerUnit: 0,
    } }, '仮商品を追加しました。');
    if (!saved) return;
    setNewItem({ category: 'TOPS', provisionalName: '' });
    setIsAddItemOpen(false);
  };
  const openItem = (item: ItemCostSummary) => {
    setSelectedItem(item);
    setItemForm({ category: item.category, provisionalName: item.provisionalName,
      plannedQuantity: item.plannedQuantity, sellingPrice: item.sellingPrice,
      fabricMetersPerUnit: item.fabricMetersPerUnit });
  };
  const saveItem = async () => {
    if (!selectedItem) return;
    const saved = await mutate({ operation: 'item.update', item: {
      id: selectedItem.id, seasonKey, ...itemForm,
    } }, '商品情報を保存しました。');
    if (!saved) return;
    setSelectedItem(null);
  };

  if (isLoading) return <div className={PANEL}><p className="font-acumin text-sm text-[#707070]">商品原価を読み込み中...</p></div>;

  const summary = data?.summary;
  const maxChartValue = Math.max(1, summary?.projectedSales ?? 0, summary?.totalExpense ?? 0,
    ...(data?.items.map((item) => Math.max(item.projectedSales, item.directCost, Math.max(0, item.projectedProfit))) ?? [0]));

  return (
    <section className="space-y-5" aria-label="商品原価">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5" aria-label="シーズン選択">
          <span className="mr-1 font-acumin text-[11px] text-[#707070]">シーズン</span>
          {seasonOptions.map((season) => (
            <Button key={season.key} variant="outline" size="2xs" shape="rounded"
              selected={season.key === seasonKey} onClick={() => onSeasonChange(season.key)}
              className="font-acumin tracking-wider">{season.label}</Button>
          ))}
        </div>
        <Button variant="outline" size="2xs" shape="rounded" onClick={() => void loadData()} disabled={isLoading || isSaving}>
          <i className="ri-refresh-line mr-1" aria-hidden="true" />更新
        </Button>
      </div>
      {message ? <div role={message.error ? 'alert' : 'status'} className={`rounded-lg border px-4 py-3 font-acumin text-xs ${message.error ? 'border-red-300 text-red-700' : 'border-[#16844b]/30 text-[#16844b]'}`}>{message.text}</div> : null}
      <TabSegmentControl items={VIEW_TABS} activeKey={view} onChange={(key) => setView(key as ProductCostView)} variant="segment-pill" size="sm" />

      {view === 'overview' && summary ? (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="売上見込み" value={currency(summary.projectedSales)} note="全商品を予定数量販売" />
            <Metric label="商品直接原価" value={currency(summary.directCost)} note="商品へ確定配賦" />
            <Metric label="シーズン共通費" value={currency(summary.commonCost)} note="商品原価へは按分しません" />
            <Metric label="未配賦費用" value={currency(summary.unallocatedCost)} note="利益計算には含まれます" warning={summary.unallocatedCost > 0} />
            <Metric label="シーズン総費用" value={currency(summary.totalExpense)} note="タグ付き支出の全額" />
            <Metric label="商品粗利益" value={currency(summary.productGrossProfit)} note="売上見込み − 直接原価" positive={summary.productGrossProfit >= 0} warning={summary.productGrossProfit < 0} />
            <Metric label="シーズン利益見込み" value={currency(summary.seasonProfit)} note="管理会計上の見込み" positive={summary.seasonProfit >= 0} warning={summary.seasonProfit < 0} />
            <Metric label="シーズン利益率" value={percent(summary.seasonProfitMargin)} note="売上見込みに対する利益" positive={(summary.seasonProfitMargin ?? -1) >= 0} />
          </div>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div className={PANEL}>
              <h3 className="font-acumin text-sm font-medium tracking-widest">シーズン収支</h3>
              <div className="mt-5 space-y-4" role="img" aria-label="売上見込みから商品直接原価、共通費、未配賦費用を差し引いたシーズン利益">
                {[
                  ['売上見込み', summary.projectedSales, '#111111'], ['商品直接原価', summary.directCost, '#555555'],
                  ['シーズン共通費', summary.commonCost, '#888888'], ['未配賦費用', summary.unallocatedCost, '#a16600'],
                  ['シーズン利益見込み', summary.seasonProfit, summary.seasonProfit >= 0 ? '#16844b' : '#b42318'],
                ].map(([label, raw, color]) => {
                  const value = Number(raw);
                  return <div key={String(label)}><div className="flex justify-between font-acumin text-xs"><span>{label}</span><span>{currency(value)}</span></div>
                    <div className="mt-1 h-3 overflow-hidden rounded-full bg-[#ededed]"><div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.abs(value) / maxChartValue * 100)}%`, backgroundColor: String(color) }} /></div></div>;
                })}
              </div>
            </div>
            <div className={PANEL}>
              <h3 className="font-acumin text-sm font-medium tracking-widest">費用構成</h3>
              <div className="mt-5 grid grid-cols-[120px_1fr] items-center gap-5">
                <div className="h-28 w-28 rounded-full" role="img" aria-label="費用区分別の構成"
                  style={{ background: `conic-gradient(${PRODUCT_COST_TYPES.map((type, index) => {
                    const before = PRODUCT_COST_TYPES.slice(0, index).reduce((sum, key) => sum + summary.costBreakdown[key], 0);
                    const total = Math.max(1, summary.directCost + summary.commonCost);
                    return `hsl(0 0% ${12 + index * 6}%) ${before / total * 100}% ${(before + summary.costBreakdown[type]) / total * 100}%`;
                  }).join(',')})` }} />
                <div className="space-y-1.5">{PRODUCT_COST_TYPES.filter((type) => summary.costBreakdown[type] > 0).map((type) =>
                  <div key={type} className="flex justify-between gap-3 font-acumin text-[11px]"><span>{PRODUCT_COST_TYPE_LABELS[type]}</span><span>{currency(summary.costBreakdown[type])}</span></div>)}
                  {summary.directCost + summary.commonCost === 0 ? <p className="font-acumin text-xs text-[#707070]">配賦確定後に表示されます。</p> : null}</div>
              </div>
            </div>
          </div>
          <div className={PANEL}>
            <h3 className="font-acumin text-sm font-medium tracking-widest">アイテム別 売上・原価・利益</h3>
            <div className="mt-5 space-y-5">{data?.items.map((item) => <div key={item.id}>
              <div className="flex justify-between font-acumin text-xs"><span>{item.provisionalName}</span><span>利益 {currency(item.projectedProfit)}</span></div>
              <div className="mt-2 space-y-1" aria-label={`${item.provisionalName}の売上、原価、利益`}>
                {[['売上', item.projectedSales, '#111'], ['原価', item.directCost, '#777'], ['利益', Math.max(0, item.projectedProfit), item.projectedProfit >= 0 ? '#16844b' : '#b42318']].map(([label, raw, color]) =>
                  <div key={String(label)} className="grid grid-cols-[36px_1fr_90px] items-center gap-2 font-acumin text-[10px]"><span>{label}</span><div className="h-2 rounded-full bg-[#ededed]"><div className="h-full rounded-full" style={{ width: `${Number(raw) / maxChartValue * 100}%`, backgroundColor: String(color) }} /></div><span className="text-right">{currency(Number(raw))}</span></div>)}</div>
            </div>)}{data?.items.length === 0 ? <p className="font-acumin text-xs text-[#707070]">アイテムを登録すると比較できます。</p> : null}</div>
          </div>
        </div>
      ) : null}

      {view === 'allocations' ? <div className="space-y-4">
        <div className="flex flex-wrap gap-2">{(['unallocated', 'allocated', 'all'] as const).map((filter) =>
          <Button key={filter} variant="outline" size="2xs" shape="rounded" selected={allocationFilter === filter} onClick={() => setAllocationFilter(filter)}>
            {filter === 'unallocated' ? '未配賦' : filter === 'allocated' ? '配賦済み' : 'すべて'}
          </Button>)}</div>
        <div className={PANEL}><div className="overflow-x-auto"><table className="w-full min-w-[680px] border-collapse">
          <thead><tr className="border-b border-black/15">{['状態', '支出日', '取引先・摘要', '勘定科目', '支出金額', '操作'].map((label) => <th key={label} className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#707070]">{label}</th>)}</tr></thead>
          <tbody>{filteredExpenses.map((expense) => <tr key={expense.id} className="border-b border-black/5">
            <td className="px-2 py-3"><span className={`rounded-full px-2 py-1 font-acumin text-[10px] ${expense.allocated ? 'bg-[#e9f5ee] text-[#16844b]' : 'bg-[#fff4df] text-[#a16600]'}`}>{expense.allocated ? '配賦済み' : '未配賦'}</span></td>
            <td className="px-2 py-3 font-acumin text-xs">{expense.date}</td><td className="px-2 py-3"><p className="font-acumin text-xs">{expense.partner || '取引先なし'}</p><p className="font-acumin text-[10px] text-[#707070]">{expense.item}</p></td>
            <td className="px-2 py-3 font-acumin text-xs">{expense.category}</td><td className="px-2 py-3 text-right font-acumin text-xs">{currency(expense.amount)}</td>
            <td className="px-2 py-3 text-right"><Button variant="outline" size="2xs" shape="rounded" onClick={() => openExpense(expense)}>{expense.allocated ? '配賦を編集' : '配賦する'}</Button></td>
          </tr>)}</tbody></table>{filteredExpenses.length === 0 ? <p className="py-8 text-center font-acumin text-xs text-[#707070]">対象の支出はありません。</p> : null}</div></div>
      </div> : null}

      {view === 'items' ? <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2">{(['ALL', ...PRODUCT_CATEGORIES] as const).map((category) =>
          <Button key={category} variant="outline" size="2xs" shape="rounded" selected={categoryFilter === category} onClick={() => setCategoryFilter(category)}>{category}</Button>)}</div>
          <Button variant="primary" size="sm" shape="rounded" onClick={() => setIsAddItemOpen(true)}><i className="ri-add-line mr-1" aria-hidden="true" />商品を追加</Button></div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{filteredItems.map((item) => <button key={item.id} type="button" onClick={() => openItem(item)} className={`${PANEL} text-left transition-colors hover:border-black/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black`}>
          <div className="flex items-start justify-between"><div><p className="font-acumin text-[10px] tracking-widest text-[#707070]">{item.category}</p><h3 className="mt-1 font-acumin text-sm font-medium">{item.provisionalName}</h3></div><i className="ri-arrow-right-up-line text-[#707070]" aria-hidden="true" /></div>
          <dl className="mt-5 grid grid-cols-2 gap-3 font-acumin text-xs"><div><dt className="text-[10px] text-[#707070]">直接原価</dt><dd className="mt-1">{currency(item.directCost)}</dd></div><div><dt className="text-[10px] text-[#707070]">1着原価</dt><dd className="mt-1">{item.unitCost === null ? '数量未入力' : currency(item.unitCost)}</dd></div><div><dt className="text-[10px] text-[#707070]">利益見込み</dt><dd className={`mt-1 ${item.projectedProfit < 0 ? 'text-[#b42318]' : 'text-[#16844b]'}`}>{currency(item.projectedProfit)}</dd></div><div><dt className="text-[10px] text-[#707070]">必要生地</dt><dd className="mt-1">{item.requiredFabricMeters.toFixed(3)} m</dd></div></dl>
        </button>)}{filteredItems.length === 0 ? <div className={`${PANEL} md:col-span-2 xl:col-span-3 text-center`}><p className="font-acumin text-xs text-[#707070]">商品がありません。「商品を追加」から仮商品を登録してください。</p></div> : null}</div>
      </div> : null}

      <Drawer open={selectedExpense !== null} onClose={() => setSelectedExpense(null)} size="lg" shape="rounded" className="overflow-y-auto p-5 sm:p-6">
        {selectedExpense ? <div className="space-y-5"><div className="flex items-start justify-between"><div><p className="font-acumin text-[10px] tracking-widest text-[#707070]">支出配賦</p><h2 className="mt-1 font-acumin text-lg font-medium">{selectedExpense.item}</h2><p className="font-acumin text-xs text-[#707070]">{selectedExpense.date} / {selectedExpense.partner || '取引先なし'} / {currency(selectedExpense.amount)}</p></div><button type="button" aria-label="配賦画面を閉じる" onClick={() => setSelectedExpense(null)}><i className="ri-close-line text-xl" /></button></div>
          <div className="space-y-3">{allocationLines.map((line, index) => <div key={line.key} className="rounded-xl border border-black/10 p-3"><div className="mb-3 flex justify-between"><span className="font-acumin text-xs font-medium">配賦 {index + 1}</span><button type="button" aria-label={`配賦${index + 1}を削除`} onClick={() => setAllocationLines((current) => current.filter((item) => item.key !== line.key))}><i className="ri-delete-bin-line" /></button></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="font-acumin text-[11px] text-[#474747]">配賦先<select className={`${INPUT} mt-1`} value={line.targetType} onChange={(event) => updateLine(line.key, { targetType: event.target.value as DraftLine['targetType'], itemId: null })}><option value="item">個別アイテム</option><option value="season_common">シーズン共通費／商品原価対象外</option></select></label>
              {line.targetType === 'item' ? <label className="font-acumin text-[11px] text-[#474747]">商品<select className={`${INPUT} mt-1`} value={line.itemId ?? ''} onChange={(event) => updateLine(line.key, { itemId: event.target.value ? Number(event.target.value) : null })}><option value="">商品を選択</option>{data?.items.map((item) => <option key={item.id} value={item.id}>{item.provisionalName}</option>)}</select></label> : <div />}
              <label className="font-acumin text-[11px] text-[#474747]">費用区分<select className={`${INPUT} mt-1`} value={line.costType} onChange={(event) => updateLine(line.key, { costType: event.target.value as ProductCostType, otherLabel: null })}>{PRODUCT_COST_TYPES.map((type) => <option key={type} value={type}>{PRODUCT_COST_TYPE_LABELS[type]}</option>)}</select></label>
              <label className="font-acumin text-[11px] text-[#474747]">金額<input className={`${INPUT} mt-1 text-right`} type="number" min="1" value={line.amount} onChange={(event) => updateLine(line.key, { amount: Math.max(0, Number(event.target.value) || 0) })} /></label>
              {line.costType === 'other' ? <label className="font-acumin text-[11px] text-[#474747] sm:col-span-2">費用名<input className={`${INPUT} mt-1`} maxLength={80} value={line.otherLabel ?? ''} onChange={(event) => updateLine(line.key, { otherLabel: event.target.value })} /></label> : null}</div>
          </div>)}</div>
          <Button variant="outline" size="sm" shape="rounded" onClick={() => setAllocationLines((current) => [...current, newDraftLine(0)])}><i className="ri-add-line mr-1" />配賦行を追加</Button>
          <div className="sticky bottom-0 rounded-xl border border-black/10 bg-white p-4 shadow-[0_-8px_24px_rgba(0,0,0,0.06)]"><div className="grid grid-cols-3 gap-3 font-acumin text-xs"><div><span className="text-[10px] text-[#707070]">支出金額</span><p>{currency(selectedExpense.amount)}</p></div><div><span className="text-[10px] text-[#707070]">配賦合計</span><p>{currency(allocationTotal)}</p></div><div><span className="text-[10px] text-[#707070]">差額</span><p className={allocationDifference === 0 ? 'text-[#16844b]' : allocationDifference < 0 ? 'text-[#b42318]' : 'text-[#a16600]'}>{currency(allocationDifference)}</p></div></div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#ededed]"><div className={`h-full rounded-full ${allocationDifference === 0 ? 'bg-[#16844b]' : allocationDifference < 0 ? 'bg-[#b42318]' : 'bg-[#a16600]'}`} style={{ width: `${Math.min(100, selectedExpense.amount > 0 ? allocationTotal / selectedExpense.amount * 100 : 0)}%` }} /></div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">{selectedExpense.allocated ? <Button variant="outline" size="sm" shape="rounded" disabled={isSaving} onClick={() => void mutate({ operation: 'allocation.clear', expenseId: selectedExpense.id }, '配賦を解除しました。').then((saved) => { if (saved) setSelectedExpense(null); })}>配賦を解除</Button> : null}<Button variant="primary" size="sm" shape="rounded" disabled={!allocationsValid || isSaving} onClick={() => void mutate({ operation: 'allocation.replace', expenseId: selectedExpense.id, lines: allocationLines.map((line) => ({ targetType: line.targetType, itemId: line.itemId, costType: line.costType, otherLabel: line.otherLabel, amount: line.amount })) }, '原価配賦を確定しました。').then((saved) => { if (saved) setSelectedExpense(null); })}>{isSaving ? '保存中...' : '原価配賦を確定'}</Button></div>
          </div></div> : null}
      </Drawer>

      <Drawer open={isAddItemOpen} onClose={() => setIsAddItemOpen(false)} size="sm" shape="rounded" className="p-5 sm:p-6">
        <div className="space-y-5"><div className="flex justify-between"><h2 className="font-acumin text-lg font-medium">商品を追加</h2><button type="button" aria-label="商品追加を閉じる" onClick={() => setIsAddItemOpen(false)}><i className="ri-close-line text-xl" /></button></div>
          <label className="block font-acumin text-xs">カテゴリ<select className={`${INPUT} mt-1`} value={newItem.category} onChange={(event) => setNewItem((current) => ({ ...current, category: event.target.value as ProductCategory }))}>{PRODUCT_CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
          <label className="block font-acumin text-xs">仮の商品名<input className={`${INPUT} mt-1`} maxLength={160} value={newItem.provisionalName} onChange={(event) => setNewItem((current) => ({ ...current, provisionalName: event.target.value }))} /></label>
          <Button variant="primary" size="sm" shape="rounded" className="w-full" disabled={!newItem.provisionalName.trim() || isSaving} onClick={() => void createItem()}>{isSaving ? '保存中...' : '仮商品を保存'}</Button></div>
      </Drawer>

      <Drawer open={selectedItem !== null} onClose={() => setSelectedItem(null)} size="lg" shape="rounded" className="overflow-y-auto p-5 sm:p-6">
        {selectedItem ? <div className="space-y-5"><div className="flex justify-between"><div><p className="font-acumin text-[10px] tracking-widest text-[#707070]">{selectedItem.category}</p><h2 className="font-acumin text-lg font-medium">{selectedItem.provisionalName}</h2></div><button type="button" aria-label="商品詳細を閉じる" onClick={() => setSelectedItem(null)}><i className="ri-close-line text-xl" /></button></div>
          <p className="rounded-lg bg-[#f5f5f5] p-3 font-acumin text-[11px] text-[#474747]">商品別には共通費を含まない、直接配賦された原価を表示しています。</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="直接原価" value={currency(selectedItem.directCost)} note="共通費を除く" /><Metric label="1着原価" value={selectedItem.unitCost === null ? '未入力' : currency(selectedItem.unitCost)} note="原価 ÷ 数量" /><Metric label="1着利益" value={selectedItem.unitProfit === null ? '未入力' : currency(selectedItem.unitProfit)} note="売価 − 1着原価" positive={(selectedItem.unitProfit ?? -1) >= 0} warning={(selectedItem.unitProfit ?? 0) < 0} /><Metric label="全着販売時利益" value={currency(selectedItem.projectedProfit)} note="全数販売前提" positive={selectedItem.projectedProfit >= 0} warning={selectedItem.projectedProfit < 0} /></div>
          <div className={PANEL}><h3 className="font-acumin text-sm font-medium tracking-widest">原価内訳</h3><div className="mt-4 space-y-2">{PRODUCT_COST_TYPES.filter((type) => selectedItem.costBreakdown[type] > 0).map((type) => <div key={type} className="flex justify-between font-acumin text-xs"><span>{PRODUCT_COST_TYPE_LABELS[type]}</span><span>{currency(selectedItem.costBreakdown[type])}</span></div>)}{selectedItem.directCost === 0 ? <p className="font-acumin text-xs text-[#707070]">支出を配賦すると表示されます。</p> : null}</div></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="font-acumin text-xs">カテゴリ<select className={`${INPUT} mt-1`} value={itemForm.category} onChange={(event) => setItemForm((current) => ({ ...current, category: event.target.value as ProductCategory }))}>{PRODUCT_CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label><label className="font-acumin text-xs">仮の商品名<input className={`${INPUT} mt-1`} value={itemForm.provisionalName} maxLength={160} onChange={(event) => setItemForm((current) => ({ ...current, provisionalName: event.target.value }))} /></label>
            <label className="font-acumin text-xs">製造予定数<input className={`${INPUT} mt-1`} type="number" min="0" value={itemForm.plannedQuantity} onChange={(event) => setItemForm((current) => ({ ...current, plannedQuantity: Math.max(0, Math.round(Number(event.target.value) || 0)) }))} /></label><label className="font-acumin text-xs">1着の販売価格<input className={`${INPUT} mt-1`} type="number" min="0" value={itemForm.sellingPrice} onChange={(event) => setItemForm((current) => ({ ...current, sellingPrice: Math.max(0, Math.round(Number(event.target.value) || 0)) }))} /></label>
            <label className="font-acumin text-xs sm:col-span-2">1着当たり生地使用量（m）<input className={`${INPUT} mt-1`} type="number" min="0" step="0.001" value={itemForm.fabricMetersPerUnit} onChange={(event) => setItemForm((current) => ({ ...current, fabricMetersPerUnit: Math.max(0, Number(event.target.value) || 0) }))} /></label></div>
          <div className="rounded-xl bg-black p-4 text-white"><p className="font-acumin text-[10px] text-white/60">予定数量分の必要生地</p><p className="mt-1 font-acumin text-2xl">{(itemForm.fabricMetersPerUnit * itemForm.plannedQuantity).toFixed(3)} m</p></div>
          <Button variant="primary" size="sm" shape="rounded" className="w-full" disabled={!itemForm.provisionalName.trim() || isSaving} onClick={() => void saveItem()}>{isSaving ? '保存中...' : '商品情報を保存'}</Button></div> : null}
      </Drawer>
    </section>
  );
}
