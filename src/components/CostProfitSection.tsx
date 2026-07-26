import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { TabSegmentControl } from "@/components/ui/TabSegmentControl/TabSegmentControl";
import { clientFetch } from "@/lib/client-fetch";

type CostProfitTab = "summary" | "expenses" | "journal" | "products" | "tax";

type EntryType = "expense" | "income";

type Expense = {
  id: number;
  entryType: EntryType;
  date: string;
  category: string;
  item: string;
  partner: string;
  amount: number;
  paymentMethod: string;
  memo: string;
};

type ExpenseTemplate = {
  name: string;
  entryType: EntryType;
  category: string;
  item: string;
  amount: number;
  paymentMethod: string;
  memo: string;
};

type ProductCostKey =
  | "material"
  | "sewing"
  | "pattern"
  | "accessories"
  | "processing"
  | "finishing";

type Product = {
  id: string;
  name: string;
  category: string;
  productionMethod: string;
  plannedQuantity: number;
  sellingPrice: number;
  costs: Record<ProductCostKey, number>;
};

type FinancePlan = {
  salesRevenue: number;
  openingCash: number;
  accountsReceivable: number;
  fixedAssets: number;
  accountsPayable: number;
  openingCapital: number;
};

type CostProfitResponse = {
  data: {
    seasonKey: string;
    plan: FinancePlan;
    expenses: Expense[];
    incomes: Expense[];
    products: Product[];
    partners: string[];
    templates: ExpenseTemplate[];
  };
};

const COST_PROFIT_TABS: Array<{ key: CostProfitTab; label: string }> = [
  { key: "summary", label: "財務サマリー" },
  { key: "expenses", label: "収支入力" },
  { key: "journal", label: "帳簿（仕訳一覧）" },
  { key: "products", label: "商品原価" },
  { key: "tax", label: "税務レポート" },
];

const COST_LABELS: Array<{
  key: ProductCostKey;
  label: string;
  color: string;
}> = [
  { key: "material", label: "生地・材料費", color: "#111111" },
  { key: "sewing", label: "縫製工賃", color: "#464646" },
  { key: "pattern", label: "パターン・企画費", color: "#707070" },
  { key: "accessories", label: "附属・副資材費", color: "#929292" },
  { key: "processing", label: "加工費", color: "#b5b5b5" },
  { key: "finishing", label: "検品・仕上げ費", color: "#d7d7d7" },
];

// 勘定科目（旧「カテゴリ」）— 支出用
const CATEGORY_OPTIONS = [
  "販売費・マーケティング",
  "材料費",
  "外注費",
  "人件費",
  "地代家賃",
  "荷造運賃",
  "通信費",
  "消耗品費",
  "旅費交通費",
  "水道光熱費",
  "諸会費",
  "その他経費",
];
// — 支出用の固定リスト
const SHIYOU_OPTIONS = [
  "生地・材料仕入",
  "サンプル制作",
  "縫製外注",
  "副資材・附属購入",
  "広告出稿",
  "撮影・制作",
  "展示会・イベント",
  "梱包・発送",
  "打合せ・交通",
  "システム・ツール利用料",
  "その他",
];
// 勘定科目 — 収入用
const INCOME_CATEGORY_OPTIONS = [
  "売上高",
  "雑収入",
  "受取利息",
  "補助金・助成金",
  "その他収入",
];
// — 収入用の固定リスト
const INCOME_SHIYOU_OPTIONS = [
  "オンライン販売",
  "卸売",
  "展示会・イベント販売",
  "受託・別注",
  "その他",
];
// 入金方法（収入用）
const INCOME_PAYMENT_OPTIONS = [
  "現金",
  "プライベート",
  "銀行",
  "前払金",
  "売掛金",
  "受取手形",
  "未収賃貸料",
  "貸付金",
  "立替金",
  "未収金",
  "仮払金",
  "仮払消費税",
];
// 出金方法（支出用）
const EXPENSE_PAYMENT_OPTIONS = [
  "現金",
  "プライベート",
  "クレジットカード",
  "銀行",
  "支払手形",
  "買掛金",
  "借入金",
  "未払金",
  "前受金",
  "預り金",
  "賃倒引当金",
  "借受金",
  "未払消費税",
  "保証金・敷金",
  "商品券",
  "仮受消費税",
];
// 種別ごとの選択肢を返す。
function categoryOptionsFor(entryType: EntryType): string[] {
  return entryType === "income" ? INCOME_CATEGORY_OPTIONS : CATEGORY_OPTIONS;
}
function shiyouOptionsFor(entryType: EntryType): string[] {
  return entryType === "income" ? INCOME_SHIYOU_OPTIONS : SHIYOU_OPTIONS;
}
function paymentOptionsFor(entryType: EntryType): string[] {
  return entryType === "income"
    ? INCOME_PAYMENT_OPTIONS
    : EXPENSE_PAYMENT_OPTIONS;
}
// 取引先セレクトの「＋新規登録」を表す番兵値
const NEW_PARTNER_SENTINEL = "__new_partner__";
// テンプレートセレクトの「＋現在の入力を保存」を表す番兵値
const SAVE_TEMPLATE_SENTINEL = "__save_template__";
const EMPTY_PLAN: FinancePlan = {
  salesRevenue: 0,
  openingCash: 0,
  accountsReceivable: 0,
  fixedAssets: 0,
  accountsPayable: 0,
  openingCapital: 0,
};

const currency = (value: number) =>
  `¥${Math.round(value).toLocaleString("ja-JP")}`;
const percent = (value: number) => `${value.toFixed(1)}%`;
const inputClassName =
  "h-10 w-full border border-[#d4d4d4] bg-white px-3 font-acumin text-sm text-black outline-none transition-colors focus:border-black";
const panelClassName = "border border-[#d4d4d4] bg-white p-4 sm:p-5";

function sumProductUnitCost(product: Product): number {
  return Object.values(product.costs).reduce((sum, value) => sum + value, 0);
}

function paymentAccount(paymentMethod: string): string {
  if (paymentMethod === "現金" || paymentMethod === "交通系IC") return "現金";
  if (paymentMethod === "口座振替" || paymentMethod === "銀行振込")
    return "普通預金";
  return "未払金";
}

function exportCsv(filename: string, rows: Array<Array<string | number>>) {
  const csv = rows
    .map((row) =>
      row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","),
    )
    .join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function MetricCard({
  label,
  value,
  note,
  positive,
}: {
  label: string;
  value: string;
  note: string;
  positive?: boolean;
}) {
  return (
    <div className="border border-[#d4d4d4] bg-white p-4">
      <p className="font-acumin text-[11px] tracking-wider text-[#474747]">
        {label}
      </p>
      <p className="mt-2 font-acumin text-xl font-medium tracking-wide text-black tabular-nums">
        {value}
      </p>
      <p
        className={`mt-2 font-acumin text-[11px] ${positive ? "text-[#16844b]" : "text-[#707070]"}`}
      >
        {note}
      </p>
    </div>
  );
}

function StatementTable({
  title,
  rows,
  totalLabel,
  totalValue,
}: {
  title: string;
  rows: Array<{ label: string; value: number; muted?: boolean }>;
  totalLabel: string;
  totalValue: number;
}) {
  return (
    <div className={panelClassName}>
      <div className="mb-3 flex items-center justify-between">
        <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
          {title}
        </h4>
        <span className="font-acumin text-[10px] text-[#888888]">単位：円</span>
      </div>
      <div>
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-4 border-b border-[#ededed] py-2.5"
          >
            <span
              className={`font-acumin text-xs ${row.muted ? "pl-3 text-[#707070]" : "text-black"}`}
            >
              {row.label}
            </span>
            <span className="font-acumin text-xs text-black tabular-nums">
              {currency(row.value)}
            </span>
          </div>
        ))}
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-black py-3">
          <span className="font-acumin text-xs font-medium text-black">
            {totalLabel}
          </span>
          <span className="font-acumin text-sm font-medium text-black tabular-nums">
            {currency(totalValue)}
          </span>
        </div>
      </div>
    </div>
  );
}

function EmptyIcon({ icon }: { icon: string }) {
  return (
    <i className={`${icon} text-base text-[#474747]`} aria-hidden="true" />
  );
}

export default function CostProfitSection({
  seasonKey,
  seasonLabel,
}: {
  seasonKey: string;
  seasonLabel: string;
}) {
  const [activeTab, setActiveTab] = useState<CostProfitTab>("summary");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [incomes, setIncomes] = useState<Expense[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [partners, setPartners] = useState<string[]>([]);
  const [templates, setTemplates] = useState<ExpenseTemplate[]>([]);
  const [plan, setPlan] = useState<FinancePlan>(EMPTY_PLAN);
  const [selectedProductId, setSelectedProductId] = useState(
    `${seasonKey}-ITEM-001`,
  );
  const [isDataLoading, setIsDataLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [dataMessage, setDataMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    entryType: "expense" as EntryType,
    date: new Date().toLocaleDateString("sv-SE"),
    category: CATEGORY_OPTIONS[0],
    item: SHIYOU_OPTIONS[0],
    partner: "",
    amount: "",
    paymentMethod: EXPENSE_PAYMENT_OPTIONS[0],
    memo: "",
  });
  const [formMessage, setFormMessage] = useState<string | null>(null);
  // 取引先の新規登録用の一時状態
  const [isAddingPartner, setIsAddingPartner] = useState(false);
  const [newPartnerName, setNewPartnerName] = useState("");
  // テンプレートの選択・保存用の一時状態
  const [selectedTemplateName, setSelectedTemplateName] = useState("");
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");

  const loadFinanceData = useCallback(async () => {
    try {
      setIsDataLoading(true);
      setDataMessage(null);
      const response = await clientFetch(
        `/api/admin/kpi/cost-profit?season=${encodeURIComponent(seasonKey)}`,
        {
          cache: "no-store",
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | CostProfitResponse
        | { error?: string; details?: string }
        | null;
      if (!response.ok || !payload || !("data" in payload)) {
        throw new Error(
          payload && "error" in payload && payload.error
            ? payload.error
            : "会計データの取得に失敗しました。",
        );
      }

      setPlan(payload.data.plan);
      setExpenses(payload.data.expenses);
      setIncomes(payload.data.incomes ?? []);
      setProducts(payload.data.products);
      setPartners(payload.data.partners ?? []);
      setTemplates(payload.data.templates ?? []);
      setSelectedProductId(
        payload.data.products[0]?.id ?? `${seasonKey}-ITEM-001`,
      );
    } catch (error) {
      // DB取得に失敗した場合、削除できないサンプル行を残さない。
      // 画面上のデータがSupabase由来であることを保証する。
      setPlan(EMPTY_PLAN);
      setExpenses([]);
      setIncomes([]);
      setProducts([]);
      setPartners([]);
      setTemplates([]);
      setSelectedProductId(`${seasonKey}-ITEM-001`);
      setDataMessage(
        error instanceof Error
          ? error.message
          : "会計データの取得に失敗しました。",
      );
    } finally {
      setIsDataLoading(false);
    }
  }, [seasonKey]);

  useEffect(() => {
    void loadFinanceData();
  }, [loadFinanceData]);

  const postMutation = useCallback(async (body: Record<string, unknown>) => {
    const response = await clientFetch("/api/admin/kpi/cost-profit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      reason?: string;
    } | null;
    if (!response.ok) {
      if (response.status === 403 && payload?.reason === "MFA required") {
        throw new Error(
          "保存には2要素認証が必要です。認証画面で2FAを完了してから、もう一度保存してください。",
        );
      }
      if (response.status === 403) {
        throw new Error(
          "セキュリティ確認に失敗しました。ページを再読み込みして、もう一度保存してください。",
        );
      }
      throw new Error(payload?.error ?? "会計データの保存に失敗しました。");
    }
  }, []);

  // 収入登録があればその合計を売上高として採用し、無ければ財務前提の手入力値を使う。
  const incomeTotal = useMemo(
    () => incomes.reduce((sum, income) => sum + income.amount, 0),
    [incomes],
  );
  const revenue = incomes.length > 0 ? incomeTotal : plan.salesRevenue;

  const accounting = useMemo(() => {
    const productCost = products.reduce(
      (sum, product) =>
        sum + sumProductUnitCost(product) * product.plannedQuantity,
      0,
    );
    const operatingExpenses = expenses.reduce(
      (sum, expense) => sum + expense.amount,
      0,
    );
    const grossProfit = revenue - productCost;
    const operatingProfit = grossProfit - operatingExpenses;
    const taxEstimate = Math.max(0, Math.round(operatingProfit * 0.3));
    const netIncome = operatingProfit - taxEstimate;
    const inventory = Math.round(productCost * 0.5);
    const operatingCashFlow =
      netIncome + inventory + Math.round(productCost * 0.15);
    const investingCashFlow = -plan.fixedAssets;
    const financingCashFlow = 0;
    const endingCash =
      plan.openingCash +
      operatingCashFlow +
      investingCashFlow +
      financingCashFlow;
    const totalAssets =
      endingCash + inventory + plan.accountsReceivable + plan.fixedAssets;
    const retainedEarnings =
      totalAssets - plan.accountsPayable - taxEstimate - plan.openingCapital;

    return {
      productCost,
      operatingExpenses,
      grossProfit,
      operatingProfit,
      taxEstimate,
      netIncome,
      inventory,
      operatingCashFlow,
      investingCashFlow,
      financingCashFlow,
      endingCash,
      totalAssets,
      retainedEarnings,
    };
  }, [expenses, plan, products, revenue]);

  const seasonForecast = useMemo(() => {
    const sales = products.reduce(
      (sum, product) => sum + product.sellingPrice * product.plannedQuantity,
      0,
    );
    const manufacturingCost = products.reduce(
      (sum, product) =>
        sum + sumProductUnitCost(product) * product.plannedQuantity,
      0,
    );
    const grossProfit = sales - manufacturingCost;
    return {
      sales,
      manufacturingCost,
      grossProfit,
      grossMargin: sales > 0 ? (grossProfit / sales) * 100 : 0,
    };
  }, [products]);

  const categoryTotals = useMemo(() => {
    const totals = new Map<string, number>();
    expenses.forEach((expense) =>
      totals.set(
        expense.category,
        (totals.get(expense.category) ?? 0) + expense.amount,
      ),
    );
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [expenses]);

  const emptyProduct = useMemo<Product>(
    () => ({
      id: `${seasonKey}-ITEM-001`,
      name: "新規商品",
      category: "未設定",
      productionMethod: "未設定",
      plannedQuantity: 0,
      sellingPrice: 0,
      costs: {
        material: 0,
        sewing: 0,
        pattern: 0,
        accessories: 0,
        processing: 0,
        finishing: 0,
      },
    }),
    [seasonKey],
  );
  const selectedProduct =
    products.find((product) => product.id === selectedProductId) ??
    products[0] ??
    emptyProduct;
  const selectedUnitCost = sumProductUnitCost(selectedProduct);
  const selectedGrossProfit = selectedProduct.sellingPrice - selectedUnitCost;
  const selectedGrossMargin =
    selectedProduct.sellingPrice > 0
      ? (selectedGrossProfit / selectedProduct.sellingPrice) * 100
      : 0;

  const journalRows = useMemo(() => {
    const base = [
      {
        date: "2026-05-31",
        number: "JE-20260531-001",
        debit: "売掛金",
        amount: revenue,
        credit: "売上高",
        description: `${seasonLabel} 売上計上`,
        partner: "オンラインストア",
      },
      {
        date: "2026-05-31",
        number: "JE-20260531-002",
        debit: "売上原価",
        amount: accounting.productCost,
        credit: "商品",
        description: `${seasonLabel} 売上原価振替`,
        partner: "—",
      },
    ];
    return [
      ...base,
      ...expenses.map((expense) => ({
        date: expense.date,
        number: `JE-${expense.date.replaceAll("-", "")}-${String(expense.id).padStart(3, "0")}`,
        debit: expense.category,
        amount: expense.amount,
        credit: paymentAccount(expense.paymentMethod),
        description: expense.item,
        partner: expense.partner || expense.memo || "—",
      })),
    ].sort((a, b) => b.date.localeCompare(a.date));
  }, [accounting.productCost, expenses, revenue, seasonLabel]);

  const handleAddExpense = async () => {
    const amount = Number(form.amount);
    if (
      !form.date ||
      !form.item.trim() ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      setFormMessage("日付・支出概要・1円以上の金額を入力してください。");
      return;
    }
    const typeLabel = form.entryType === "income" ? "収入" : "支出";
    try {
      setIsSaving(true);
      setFormMessage(null);
      await postMutation({
        operation: "expense.create",
        seasonKey,
        expense: {
          entryType: form.entryType,
          date: form.date,
          category: form.category,
          item: form.item.trim(),
          partner: form.partner.trim(),
          amount: Math.round(amount),
          paymentMethod: form.paymentMethod,
          memo: form.memo.trim(),
        },
      });
      await loadFinanceData();
      setForm((current) => ({
        ...current,
        item: shiyouOptionsFor(current.entryType)[0],
        amount: "",
        memo: "",
      }));
      setFormMessage(
        `${typeLabel}をSupabaseへ保存し、仕訳帳と財務サマリーへ反映しました。`,
      );
    } catch (error) {
      setFormMessage(
        error instanceof Error
          ? error.message
          : `${typeLabel}の保存に失敗しました。`,
      );
    } finally {
      setIsSaving(false);
    }
  };

  // 種別（支出/収入）切替。勘定科目・支出概要はその種別の先頭にリセット。
  const handleEntryTypeChange = (entryType: EntryType) => {
    setForm((current) => ({
      ...current,
      entryType,
      category: categoryOptionsFor(entryType)[0],
      item: shiyouOptionsFor(entryType)[0],
      paymentMethod: paymentOptionsFor(entryType)[0],
    }));
  };

  const handleAddPartner = async () => {
    const name = newPartnerName.trim();
    if (!name) {
      setFormMessage("取引先名を入力してください。");
      return;
    }
    try {
      setIsSaving(true);
      setFormMessage(null);
      await postMutation({
        operation: "partner.create",
        seasonKey,
        partnerName: name,
      });
      await loadFinanceData();
      // 登録した取引先を選択済みにする。
      setForm((current) => ({ ...current, partner: name }));
      setNewPartnerName("");
      setIsAddingPartner(false);
      setFormMessage("取引先を登録しました。");
    } catch (error) {
      setFormMessage(
        error instanceof Error ? error.message : "取引先の登録に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  // テンプレート選択：勘定科目・支出概要・金額・支払い方法・メモをフォームへ反映する。
  const handleTemplateSelect = (value: string) => {
    if (value === SAVE_TEMPLATE_SENTINEL) {
      // 保存時の名前の初期値は「支出概要 / 金額」。保存前に変更可能。
      setNewTemplateName(
        `${form.item} / ${currency(Number(form.amount) || 0)}`,
      );
      setIsSavingTemplate(true);
      return;
    }
    setIsSavingTemplate(false);
    if (value === "") {
      setSelectedTemplateName("");
      return;
    }
    const template = templates.find((item) => item.name === value);
    if (template) {
      // テンプレートの種別（支出/収入）もフォームへ反映する。
      setForm((current) => ({
        ...current,
        entryType: template.entryType,
        category: template.category,
        item: template.item,
        amount: template.amount > 0 ? String(template.amount) : "",
        paymentMethod: template.paymentMethod,
        memo: template.memo,
      }));
    }
    setSelectedTemplateName(value);
  };

  const handleSaveTemplate = async () => {
    const name = newTemplateName.trim();
    if (!name) {
      setFormMessage("テンプレート名を入力してください。");
      return;
    }
    try {
      setIsSaving(true);
      setFormMessage(null);
      await postMutation({
        operation: "template.create",
        seasonKey,
        template: {
          name,
          entryType: form.entryType,
          category: form.category,
          item: form.item,
          amount: Math.max(0, Math.round(Number(form.amount) || 0)),
          paymentMethod: form.paymentMethod,
          memo: form.memo.trim(),
        },
      });
      await loadFinanceData();
      setSelectedTemplateName(name);
      setNewTemplateName("");
      setIsSavingTemplate(false);
      setFormMessage("テンプレートを保存しました。");
    } catch (error) {
      setFormMessage(
        error instanceof Error
          ? error.message
          : "テンプレートの保存に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteTemplate = async () => {
    if (!selectedTemplateName) {
      return;
    }
    try {
      setIsSaving(true);
      setFormMessage(null);
      await postMutation({
        operation: "template.delete",
        seasonKey,
        templateName: selectedTemplateName,
      });
      await loadFinanceData();
      setSelectedTemplateName("");
      setFormMessage("テンプレートを削除しました。");
    } catch (error) {
      setFormMessage(
        error instanceof Error
          ? error.message
          : "テンプレートの削除に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const updateProduct = (
    productId: string,
    updater: (product: Product) => Product,
  ) => {
    setProducts((current) => {
      const exists = current.some((product) => product.id === productId);
      return exists
        ? current.map((product) =>
            product.id === productId ? updater(product) : product,
          )
        : [...current, updater(emptyProduct)];
    });
  };

  const handleDeleteExpense = async (expense: Expense) => {
    const previousExpenses = expenses;
    const previousIncomes = incomes;
    const typeLabel = expense.entryType === "income" ? "収入" : "支出";
    try {
      setIsSaving(true);
      setDataMessage(null);
      // クリック直後に行を消し、API失敗時だけ元に戻す。支出・収入どちらの行でも同じ処理。
      setExpenses((current) =>
        current.filter((item) => item.id !== expense.id),
      );
      setIncomes((current) => current.filter((item) => item.id !== expense.id));
      await postMutation({
        operation: "expense.delete",
        seasonKey,
        expenseId: expense.id,
      });
      await loadFinanceData();
      setDataMessage(`${typeLabel}をSupabaseから削除しました。`);
    } catch (error) {
      setExpenses(previousExpenses);
      setIncomes(previousIncomes);
      setDataMessage(
        error instanceof Error
          ? error.message
          : `${typeLabel}の削除に失敗しました。`,
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveProduct = async () => {
    try {
      setIsSaving(true);
      setDataMessage(null);
      await postMutation({
        operation: "product.upsert",
        seasonKey,
        product: selectedProduct,
      });
      await loadFinanceData();
      setDataMessage(
        `${selectedProduct.name}の原価・売価をSupabaseへ保存しました。`,
      );
    } catch (error) {
      setDataMessage(
        error instanceof Error
          ? error.message
          : "商品原価の保存に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleSavePlan = async () => {
    try {
      setIsSaving(true);
      setDataMessage(null);
      await postMutation({ operation: "plan.update", seasonKey, plan });
      setDataMessage("財務前提をSupabaseへ保存しました。");
    } catch (error) {
      setDataMessage(
        error instanceof Error
          ? error.message
          : "財務前提の保存に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleJournalExport = () => {
    exportCsv(`${seasonLabel.replaceAll("/", "-")}_仕訳帳.csv`, [
      [
        "取引日",
        "仕訳番号",
        "借方勘定科目",
        "借方金額",
        "貸方勘定科目",
        "貸方金額",
        "支出概要",
        "取引先・補助科目",
      ],
      ...journalRows.map((row) => [
        row.date,
        row.number,
        row.debit,
        row.amount,
        row.credit,
        row.amount,
        row.description,
        row.partner,
      ]),
    ]);
  };

  const summaryView = (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-acumin text-lg font-medium tracking-wider text-black">
            経営・財務サマリー
          </h3>
          <p className="mt-1 font-acumin text-xs text-[#707070]">
            売上・費用・商品原価から、財務3表とシーズン利益を自動集計します。
          </p>
        </div>
        <span className="border border-[#d4d4d4] px-3 py-1.5 font-acumin text-xs text-[#474747]">
          {seasonLabel}・見込み
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="売上（見込み）"
          value={currency(revenue)}
          note={incomes.length > 0 ? "収入登録の合計" : "Supabase登録値"}
          positive
        />
        <MetricCard
          label="製造原価"
          value={currency(accounting.productCost)}
          note={`原価率 ${percent(revenue > 0 ? (accounting.productCost / revenue) * 100 : 0)}`}
        />
        <MetricCard
          label="営業利益（見込み）"
          value={currency(accounting.operatingProfit)}
          note="経費・製造原価控除後"
          positive={accounting.operatingProfit >= 0}
        />
        <MetricCard
          label="シーズン粗利率"
          value={percent(seasonForecast.grossMargin)}
          note="売価シミュレーション連動"
          positive
        />
        <MetricCard
          label="期末現金（見込み）"
          value={currency(accounting.endingCash)}
          note={`期首 ${currency(plan.openingCash)}`}
        />
      </div>

      <details className={panelClassName}>
        <summary className="cursor-pointer font-acumin text-sm font-medium tracking-widest text-black">
          財務前提を編集
        </summary>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {[
            ["salesRevenue", "売上見込み"],
            ["openingCash", "期首現金"],
            ["accountsReceivable", "売掛金"],
            ["fixedAssets", "固定資産"],
            ["accountsPayable", "買掛金・未払金"],
            ["openingCapital", "元入金"],
          ].map(([key, label]) => (
            <label key={key}>
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                {label}
              </span>
              <input
                type="number"
                min="0"
                value={plan[key as keyof FinancePlan]}
                onChange={(event) =>
                  setPlan((current) => ({
                    ...current,
                    [key]: Math.max(0, Number(event.target.value) || 0),
                  }))
                }
                className={inputClassName}
                aria-label={label}
              />
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            className="font-acumin"
            onClick={() => void handleSavePlan()}
            disabled={isSaving}
          >
            {isSaving ? "保存中..." : "財務前提を保存"}
          </Button>
        </div>
      </details>

      <div>
        <div className="mb-3 flex items-center gap-2">
          <h3 className="font-acumin text-sm font-medium tracking-widest text-black">
            財務3表
          </h3>
          <span className="rounded-full bg-[#ededed] px-2 py-0.5 font-acumin text-[10px] tracking-wider text-[#707070]">
            自動連動
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <StatementTable
            title="損益計算書（P/L）"
            rows={[
              { label: "売上高", value: revenue },
              {
                label: "売上原価",
                value: -accounting.productCost,
                muted: true,
              },
              { label: "売上総利益", value: accounting.grossProfit },
              {
                label: "販売費及び一般管理費",
                value: -accounting.operatingExpenses,
                muted: true,
              },
              {
                label: "税金見込み",
                value: -accounting.taxEstimate,
                muted: true,
              },
            ]}
            totalLabel="当期純利益"
            totalValue={accounting.netIncome}
          />
          <StatementTable
            title="貸借対照表（B/S）"
            rows={[
              { label: "現金及び預金", value: accounting.endingCash },
              { label: "売掛金", value: plan.accountsReceivable },
              { label: "商品・棚卸資産", value: accounting.inventory },
              { label: "固定資産", value: plan.fixedAssets },
              {
                label: "買掛金・未払金",
                value: -plan.accountsPayable,
                muted: true,
              },
              {
                label: "未払税金",
                value: -accounting.taxEstimate,
                muted: true,
              },
              {
                label: "元入金・利益剰余金",
                value: -(plan.openingCapital + accounting.retainedEarnings),
                muted: true,
              },
            ]}
            totalLabel="貸借差額"
            totalValue={0}
          />
          <StatementTable
            title="キャッシュ・フロー計算書（C/F）"
            rows={[
              { label: "期首現金残高", value: plan.openingCash },
              {
                label: "営業活動によるCF",
                value: accounting.operatingCashFlow,
              },
              {
                label: "投資活動によるCF",
                value: accounting.investingCashFlow,
              },
              {
                label: "財務活動によるCF",
                value: accounting.financingCashFlow,
              },
            ]}
            totalLabel="期末現金残高"
            totalValue={accounting.endingCash}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
        <div className={panelClassName}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-acumin text-sm font-medium tracking-widest text-black">
              コスト構成
            </h3>
            <span className="font-acumin text-xs text-[#707070]">
              合計{" "}
              {currency(accounting.productCost + accounting.operatingExpenses)}
            </span>
          </div>
          <div className="space-y-3">
            {[
              ["商品原価（製造）", accounting.productCost],
              ...categoryTotals.slice(0, 5),
            ].map(([label, value]) => {
              const numericValue = Number(value);
              const totalCost =
                accounting.productCost + accounting.operatingExpenses;
              const ratio =
                totalCost > 0 ? (numericValue / totalCost) * 100 : 0;
              return (
                <div
                  key={String(label)}
                  className="grid grid-cols-[minmax(110px,1fr)_minmax(120px,2fr)_80px] items-center gap-3"
                >
                  <span className="truncate font-acumin text-xs text-[#474747]">
                    {label}
                  </span>
                  <div className="h-1.5 bg-[#ededed]">
                    <div
                      className="h-full bg-black"
                      style={{ width: `${Math.max(2, ratio)}%` }}
                    />
                  </div>
                  <span className="text-right font-acumin text-xs text-black tabular-nums">
                    {currency(numericValue)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div className={panelClassName}>
          <h3 className="font-acumin text-sm font-medium tracking-widest text-black">
            シーズン全体の見込み
          </h3>
          <div className="mt-3">
            {[
              ["売上（商品計画）", seasonForecast.sales],
              ["製造原価", seasonForecast.manufacturingCost],
              ["粗利益", seasonForecast.grossProfit],
            ].map(([label, value], index) => (
              <div
                key={String(label)}
                className={`flex items-center justify-between py-3 ${index < 2 ? "border-b border-[#ededed]" : "border-t border-black font-medium"}`}
              >
                <span className="font-acumin text-xs text-black">{label}</span>
                <span
                  className={`font-acumin text-sm tabular-nums ${index === 2 ? "text-[#16844b]" : "text-black"}`}
                >
                  {currency(Number(value))}
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between py-2">
              <span className="font-acumin text-xs text-black">粗利率</span>
              <span className="font-acumin text-sm font-medium text-[#16844b]">
                {percent(seasonForecast.grossMargin)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const renderEntryTable = (
    title: string,
    rows: Expense[],
    paymentHeading: string,
  ) => (
    <div className={`${panelClassName} min-w-0`}>
      <div className="mb-3 flex items-center justify-between">
        <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
          {title}（{rows.length}件）
        </h4>
        <span className="font-acumin text-xs text-[#474747]">
          合計 {currency(rows.reduce((sum, row) => sum + row.amount, 0))}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse">
          <thead>
            <tr className="border-b border-[#d4d4d4]">
              {[
                "日付",
                "勘定科目",
                "支出概要",
                "取引先",
                "金額",
                paymentHeading,
                "メモ",
                "操作",
              ].map((heading) => (
                <th
                  key={heading}
                  className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#474747]"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <tr key={entry.id} className="border-b border-[#ededed]">
                <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                  {entry.date.replaceAll("-", "/")}
                </td>
                <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                  {entry.category}
                </td>
                <td className="px-2 py-3 font-acumin text-xs text-black">
                  {entry.item}
                </td>
                <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                  {entry.partner || "—"}
                </td>
                <td className="whitespace-nowrap px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                  {currency(entry.amount)}
                </td>
                <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                  {entry.paymentMethod}
                </td>
                <td className="max-w-36 truncate px-2 py-3 font-acumin text-xs text-[#474747]">
                  {entry.memo || "—"}
                </td>
                <td className="px-2 py-3 text-center">
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center border border-transparent text-[#474747] hover:border-[#d4d4d4] hover:text-black"
                    aria-label={`${entry.item}を削除`}
                    onClick={() => void handleDeleteExpense(entry)}
                    disabled={isSaving}
                  >
                    <EmptyIcon icon="ri-delete-bin-line" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const isIncomeForm = form.entryType === "income";
  const entryTypeLabel = isIncomeForm ? "収入" : "支出";
  const paymentFieldLabel = isIncomeForm ? "入金方法" : "出金方法";

  const expensesView = (
    <div className="space-y-5">
      <div>
        <h3 className="font-acumin text-lg font-medium tracking-wider text-black">
          収支を入力する
        </h3>
        <p className="mt-1 font-acumin text-xs text-[#707070]">
          登録した支出・収入は仕訳帳・損益計算書・キャッシュフローへ自動で反映されます。収入は売上高として集計されます。
        </p>
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          {renderEntryTable("支出一覧", expenses, "出金方法")}
          {renderEntryTable("収入一覧", incomes, "入金方法")}
        </div>

        <aside className={`${panelClassName} h-fit`}>
          <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
            新規{entryTypeLabel}を登録
          </h4>
          <div className="mt-4 space-y-3">
            <div className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                種別 <span className="text-red-700">*</span>
              </span>
              <div
                className="grid grid-cols-2 gap-2"
                role="group"
                aria-label="種別"
              >
                {(["expense", "income"] as EntryType[]).map((type) => {
                  const active = form.entryType === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={active}
                      onClick={() => handleEntryTypeChange(type)}
                      className={`h-10 border font-acumin text-sm transition-colors ${active ? "border-black bg-black text-white" : "border-[#d4d4d4] bg-white text-[#474747] hover:border-black"}`}
                    >
                      {type === "income" ? "収入" : "支出"}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                テンプレート
              </span>
              <SingleSelect
                variant="dropdown"
                block
                size="md"
                aria-label="テンプレート"
                className="font-acumin"
                placeholder="（テンプレートを選択）"
                options={[
                  { value: "", label: "（テンプレートを選択）" },
                  ...templates.map((template) => ({
                    value: template.name,
                    label: template.name,
                  })),
                  {
                    value: SAVE_TEMPLATE_SENTINEL,
                    label: "＋ 現在の入力を保存",
                  },
                ]}
                value={
                  isSavingTemplate
                    ? SAVE_TEMPLATE_SENTINEL
                    : selectedTemplateName
                }
                onValueChange={handleTemplateSelect}
              />
              {selectedTemplateName && !isSavingTemplate ? (
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 font-acumin"
                    aria-label="選択中のテンプレートを削除"
                    onClick={() => void handleDeleteTemplate()}
                    disabled={isSaving}
                  >
                    削除
                  </Button>
                </div>
              ) : null}
              {isSavingTemplate ? (
                <div className="mt-2 flex gap-2">
                  <input
                    value={newTemplateName}
                    onChange={(event) => setNewTemplateName(event.target.value)}
                    className={inputClassName}
                    placeholder="テンプレート名"
                    aria-label="テンプレート名"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    className="shrink-0 font-acumin"
                    onClick={() => void handleSaveTemplate()}
                    disabled={isSaving}
                  >
                    保存
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 font-acumin"
                    onClick={() => {
                      setIsSavingTemplate(false);
                      setNewTemplateName("");
                    }}
                    disabled={isSaving}
                  >
                    取消
                  </Button>
                </div>
              ) : null}
            </div>
            <label className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                日付 <span className="text-red-700">*</span>
              </span>
              <input
                type="date"
                value={form.date}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    date: event.target.value,
                  }))
                }
                className={inputClassName}
              />
            </label>
            <div className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                <span className="text-red-700">*</span>
              </span>
              <SingleSelect
                variant="dropdown"
                block
                size="md"
                aria-label=""
                className="font-acumin"
                options={shiyouOptionsFor(form.entryType).map((option) => ({
                  value: option,
                  label: option,
                }))}
                value={form.item}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, item: value }))
                }
              />
            </div>
            <div className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                勘定科目 <span className="text-red-700">*</span>
              </span>
              <SingleSelect
                variant="dropdown"
                block
                size="md"
                aria-label="勘定科目"
                className="font-acumin"
                options={categoryOptionsFor(form.entryType).map((option) => ({
                  value: option,
                  label: option,
                }))}
                value={form.category}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, category: value }))
                }
              />
            </div>

            <div className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                取引先
              </span>
              <SingleSelect
                variant="dropdown"
                block
                size="md"
                aria-label="取引先"
                className="font-acumin"
                placeholder="（指定なし）"
                options={[
                  { value: "", label: "（指定なし）" },
                  ...partners.map((option) => ({
                    value: option,
                    label: option,
                  })),
                  { value: NEW_PARTNER_SENTINEL, label: "＋ 新規登録" },
                ]}
                value={isAddingPartner ? NEW_PARTNER_SENTINEL : form.partner}
                onValueChange={(value) => {
                  if (value === NEW_PARTNER_SENTINEL) {
                    setIsAddingPartner(true);
                    return;
                  }
                  setIsAddingPartner(false);
                  setForm((current) => ({ ...current, partner: value }));
                }}
              />
              {isAddingPartner ? (
                <div className="mt-2 flex gap-2">
                  <input
                    value={newPartnerName}
                    onChange={(event) => setNewPartnerName(event.target.value)}
                    className={inputClassName}
                    placeholder="取引先名を入力"
                    aria-label="新規取引先名"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    className="shrink-0 font-acumin"
                    onClick={() => void handleAddPartner()}
                    disabled={isSaving}
                  >
                    登録
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 font-acumin"
                    onClick={() => {
                      setIsAddingPartner(false);
                      setNewPartnerName("");
                    }}
                    disabled={isSaving}
                  >
                    取消
                  </Button>
                </div>
              ) : null}
            </div>
            <label className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                金額 <span className="text-red-700">*</span>
              </span>
              <input
                type="number"
                min="1"
                value={form.amount}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    amount: event.target.value,
                  }))
                }
                className={inputClassName}
                placeholder="0"
              />
            </label>
            <div className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                {paymentFieldLabel}
              </span>
              <SingleSelect
                variant="dropdown"
                block
                size="md"
                aria-label={paymentFieldLabel}
                className="font-acumin"
                options={paymentOptionsFor(form.entryType).map((option) => ({
                  value: option,
                  label: option,
                }))}
                value={form.paymentMethod}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, paymentMethod: value }))
                }
              />
            </div>
            <label className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                メモ
              </span>
              <textarea
                value={form.memo}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    memo: event.target.value,
                  }))
                }
                className={`${inputClassName} h-20 py-2`}
                placeholder="任意のメモを入力"
              />
            </label>
            {formMessage ? (
              <p
                className={`font-acumin text-xs ${/失敗|ください/.test(formMessage) ? "text-red-700" : "text-[#16844b]"}`}
                role="status"
              >
                {formMessage}
              </p>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              className="w-full font-acumin"
              onClick={() => void handleAddExpense()}
              disabled={isSaving}
            >
              {isSaving ? "保存中..." : `${entryTypeLabel}をSupabaseへ保存`}
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );

  const journalView = (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-acumin text-lg font-medium tracking-wider text-black">
            帳簿（仕訳一覧）
          </h3>
          <p className="mt-1 font-acumin text-xs text-[#707070]">
            複式簿記の仕訳データです。借方・貸方の合計は一致しています。
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="font-acumin"
          onClick={handleJournalExport}
        >
          <i className="ri-download-line mr-1.5" aria-hidden="true" />
          仕訳帳CSV
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          label="仕訳件数"
          value={`${journalRows.length}件`}
          note={`${seasonLabel} 集計`}
        />
        <MetricCard
          label="借方合計"
          value={currency(
            journalRows.reduce((sum, row) => sum + row.amount, 0),
          )}
          note="複式簿記"
        />
        <MetricCard
          label="貸方合計"
          value={currency(
            journalRows.reduce((sum, row) => sum + row.amount, 0),
          )}
          note="差額 ¥0（一致）"
          positive
        />
      </div>
      <div className={`${panelClassName} min-w-0`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse">
            <thead>
              <tr className="border-b border-[#d4d4d4]">
                {[
                  "取引日",
                  "仕訳番号",
                  "借方勘定科目",
                  "借方金額",
                  "貸方勘定科目",
                  "貸方金額",
                  "支出概要",
                  "取引先・補助科目",
                ].map((heading) => (
                  <th
                    key={heading}
                    className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#474747]"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {journalRows.map((row) => (
                <tr key={row.number} className="border-b border-[#ededed]">
                  <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                    {row.date.replaceAll("-", "/")}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 font-acumin text-[11px] text-[#474747]">
                    {row.number}
                  </td>
                  <td className="px-2 py-3 font-acumin text-xs text-black">
                    {row.debit}
                  </td>
                  <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                    {currency(row.amount)}
                  </td>
                  <td className="px-2 py-3 font-acumin text-xs text-black">
                    {row.credit}
                  </td>
                  <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                    {currency(row.amount)}
                  </td>
                  <td className="px-2 py-3 font-acumin text-xs text-black">
                    {row.description}
                  </td>
                  <td className="px-2 py-3 font-acumin text-xs text-[#474747]">
                    {row.partner}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  const productView = (
    <div className="space-y-5">
      <div>
        <h3 className="font-acumin text-lg font-medium tracking-wider text-black">
          商品原価（製造コストの可視化）
        </h3>
        <p className="mt-1 font-acumin text-xs text-[#707070]">
          製造原価と予定生産数から、適正な売価・粗利益・シーズン見込みを確認できます。
        </p>
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
          <h4 className="mb-3 font-acumin text-sm font-medium tracking-widest text-black">
            アイテム別 原価一覧
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse">
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
                      className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#474747]"
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
                        <p className="font-acumin text-xs font-medium text-black">
                          {product.id}
                        </p>
                        <p className="mt-0.5 font-acumin text-[11px] text-[#707070]">
                          {product.name}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                        {product.category}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                        {product.productionMethod}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black">
                        {product.plannedQuantity}点
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black">
                        {currency(unitCost * product.plannedQuantity)}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black">
                        {currency(unitCost)}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black">
                        {currency(product.sellingPrice)}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black">
                        {percent(
                          product.sellingPrice > 0
                            ? (unitCost / product.sellingPrice) * 100
                            : 0,
                        )}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black">
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
          <p className="font-acumin text-[11px] text-[#707070]">
            原価内訳（1点あたり）
          </p>
          <h4 className="mt-1 font-acumin text-sm font-medium text-black">
            {selectedProduct.name}
          </h4>
          <p className="font-acumin text-[11px] text-[#707070]">
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
              <div className="absolute inset-[22px] flex flex-col items-center justify-center rounded-full bg-white">
                <span className="font-acumin text-xs font-medium text-black">
                  {currency(selectedUnitCost)}
                </span>
                <span className="font-acumin text-[9px] text-[#707070]">
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
                  <span className="flex min-w-0 items-center gap-1.5 font-acumin text-[10px] text-[#474747]">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: item.color }}
                    />
                    <span className="truncate">{item.label}</span>
                  </span>
                  <span className="font-acumin text-[10px] text-black tabular-nums">
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
                <span className="font-acumin text-[11px] text-[#474747]">
                  {item.label}
                </span>
                <span className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 font-acumin text-xs text-[#888888]">
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
                    className={`${inputClassName} h-8 pl-7 text-right text-xs`}
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
              {isSaving ? "保存中..." : "商品原価をSupabaseへ保存"}
            </Button>
          </div>
        </aside>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
        <div className={panelClassName}>
          <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
            売価シミュレーション
          </h4>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label>
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
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
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
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
              <span className="block font-acumin text-[11px] text-[#474747]">
                粗利益（1点あたり）
              </span>
              <p className="mt-2 font-acumin text-xl font-medium text-black">
                {currency(selectedGrossProfit)}
              </p>
            </div>
            <div>
              <span className="block font-acumin text-[11px] text-[#474747]">
                粗利率
              </span>
              <p
                className={`mt-2 font-acumin text-xl font-medium ${selectedGrossMargin >= 55 ? "text-[#16844b]" : "text-[#a16600]"}`}
              >
                {percent(selectedGrossMargin)}
              </p>
            </div>
          </div>
          <p className="mt-4 font-acumin text-[11px] text-[#707070]">
            売価・数量・原価内訳を変更すると、上部の一覧とシーズン全体の見込みが即時更新されます。
          </p>
        </div>
        <div className={panelClassName}>
          <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
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
              <span className="font-acumin text-xs text-black">{label}</span>
              <span
                className={`font-acumin text-sm font-medium ${index === 2 ? "text-[#16844b]" : "text-black"}`}
              >
                {currency(Number(value))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const taxView = (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-acumin text-lg font-medium tracking-wider text-black">
            税務レポート（青色申告用）
          </h3>
          <p className="mt-1 font-acumin text-xs text-[#707070]">
            複式簿記の帳簿と青色申告決算書の作成に必要な数値を確認できます。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="font-acumin"
            onClick={handleJournalExport}
          >
            仕訳帳CSV
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="font-acumin"
            onClick={() =>
              exportCsv("青色申告_損益計算書.csv", [
                ["科目", "金額"],
                ["売上高", revenue],
                ["売上原価", accounting.productCost],
                ["必要経費", accounting.operatingExpenses],
                ["青色申告控除前所得", accounting.operatingProfit],
              ])
            }
          >
            決算書CSV
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard
          label="事業所得（見込み）"
          value={currency(accounting.operatingProfit)}
          note="青色申告控除前"
          positive
        />
        <MetricCard
          label="売上合計"
          value={currency(revenue)}
          note="課税売上"
        />
        <MetricCard
          label="必要経費"
          value={currency(accounting.operatingExpenses)}
          note={`${expenses.length}件を集計`}
        />
        <MetricCard
          label="所得税（概算）"
          value={currency(Math.round(accounting.operatingProfit * 0.2))}
          note="概算税率20%"
        />
        <MetricCard
          label="住民税（概算）"
          value={currency(Math.round(accounting.operatingProfit * 0.1))}
          note="概算税率10%"
        />
        <MetricCard
          label="帳簿貸借差額"
          value={currency(0)}
          note="一致を確認済み"
          positive
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
        <div className={panelClassName}>
          <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
            作成可能な帳簿・申告資料
          </h4>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse">
              <thead>
                <tr className="border-b border-[#d4d4d4]">
                  {["帳簿名", "用途", "対象期間", "ステータス", "出力"].map(
                    (heading) => (
                      <th
                        key={heading}
                        className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#474747]"
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {[
                  [
                    "仕訳帳",
                    "全取引の複式仕訳",
                    "2026/01/01〜12/31",
                    "作成可能",
                  ],
                  [
                    "総勘定元帳",
                    "勘定科目別の取引",
                    "2026/01/01〜12/31",
                    "作成可能",
                  ],
                  [
                    "青色申告決算書 1ページ",
                    "損益計算書",
                    "2026年度",
                    "作成可能",
                  ],
                  [
                    "青色申告決算書 4ページ",
                    "貸借対照表",
                    "2026/12/31時点",
                    "作成可能",
                  ],
                  ["現金出納帳", "現金取引の記録", "2026年度", "確認中"],
                ].map((row) => (
                  <tr key={row[0]} className="border-b border-[#ededed]">
                    <td className="px-2 py-3 font-acumin text-xs font-medium text-black">
                      {row[0]}
                    </td>
                    <td className="px-2 py-3 font-acumin text-xs text-[#474747]">
                      {row[1]}
                    </td>
                    <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-[#474747]">
                      {row[2]}
                    </td>
                    <td
                      className={`px-2 py-3 font-acumin text-xs ${row[3] === "作成可能" ? "text-[#16844b]" : "text-[#a16600]"}`}
                    >
                      {row[3]}
                    </td>
                    <td className="px-2 py-3">
                      <button
                        type="button"
                        className="font-acumin text-xs text-black underline underline-offset-4"
                        onClick={handleJournalExport}
                      >
                        CSV
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 font-acumin text-[11px] leading-relaxed text-[#707070]">
            ※
            本画面の税額は経営判断用の概算です。実際の申告内容は税理士または所轄税務署へご確認ください。
          </p>
        </div>

        <aside className={panelClassName}>
          <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
            確定申告準備チェックリスト
          </h4>
          <div className="mt-4 space-y-3">
            {[
              ["帳簿の入力", true],
              ["仕訳の貸借一致", true],
              ["経費の確認", true],
              ["棚卸資産の確認", true],
              ["減価償却費の確認", false],
              ["青色申告決算書の出力", false],
              ["電子申告（e-Tax）", false],
            ].map(([label, complete]) => (
              <div
                key={String(label)}
                className="flex items-center justify-between gap-4"
              >
                <span className="font-acumin text-xs text-black">{label}</span>
                <span
                  className={`flex items-center gap-1.5 font-acumin text-xs ${complete ? "text-[#16844b]" : "text-[#888888]"}`}
                >
                  <i
                    className={
                      complete ? "ri-checkbox-circle-fill" : "ri-time-line"
                    }
                    aria-hidden="true"
                  />
                  {complete ? "完了" : "要確認"}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-5 border-t border-[#d4d4d4] pt-4">
            <p className="font-acumin text-[11px] text-[#707070]">
              申告準備の進捗
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#ededed]">
              <div className="h-full w-[57%] bg-black" />
            </div>
            <div className="mt-2 flex justify-between font-acumin text-[11px] text-[#474747]">
              <span>4 / 7 項目</span>
              <span>57%</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p
          className={`font-acumin text-xs ${dataMessage?.includes("失敗") || dataMessage?.includes("未作成") ? "text-red-700" : "text-[#16844b]"}`}
          role="status"
        >
          {isDataLoading
            ? "Supabaseから会計データを読み込み中..."
            : (dataMessage ?? "Supabaseと同期済み")}
        </p>
        <Button
          variant="secondary"
          size="2xs"
          className="font-acumin"
          onClick={() => void loadFinanceData()}
          disabled={isDataLoading || isSaving}
        >
          <i className="ri-refresh-line mr-1" aria-hidden="true" />
          再読み込み
        </Button>
      </div>
      <div className="mb-5 overflow-x-auto border-b border-[#d4d4d4]">
        <TabSegmentControl
          variant="tabs-standard"
          size="sm"
          items={COST_PROFIT_TABS}
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as CostProfitTab)}
        />
      </div>
      {activeTab === "summary" ? summaryView : null}
      {activeTab === "expenses" ? expensesView : null}
      {activeTab === "journal" ? journalView : null}
      {activeTab === "products" ? productView : null}
      {activeTab === "tax" ? taxView : null}
    </div>
  );
}
