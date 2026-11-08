"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { accountByCode } from "@/lib/finance/accounts";
import {
  accountingUrl,
  eventKindLabel,
  getAccountingData,
  hasArray,
  inputClassName,
  isRecord,
  labelClassName,
  noteClassName,
  Section,
  tableClassName,
  todayJst,
  type ViewPermissions,
  NO_PERMISSIONS,
} from "./accounting-api";
import { currency, signedCurrency } from "./constants";
import { YearEndShipmentsPanel } from "./year-end-shipments-panel";
import {
  errorNotice,
  failureNotice,
  NoticeLine,
  sendAccountingJson,
  successNotice,
  type Notice,
} from "./period-form";

// 照合のタブ（FREQ-566・571）。Stripe の残高の照合、手数料の月の照合、受注高と帳簿の2段の照らし合わせ。
// route は読み口の答えを組み替えずに返す（平らな snake_case）。説明のつかない差が0でなければ赤字にする。
// Stripe の手数料の2段目の符号は暫定（Ruling P2-T4-I3）なので、中立の言い方にする。

type Tone = "ok" | "alert";
const toneOf = (value: number): Tone => (value === 0 ? "ok" : "alert");
const toneClassName = (tone: Tone): string =>
  tone === "alert" ? "font-medium text-red-700" : "text-black";

function Line({ text }: { text: string }) {
  return <p className="font-acumin lk-text-4xs text-black tabular-nums">{text}</p>;
}

function Unexplained({
  testId,
  label,
  value,
}: {
  testId: string;
  label: string;
  value: number;
}) {
  const tone = toneOf(value);
  return (
    <p
      data-testid={testId}
      data-tone={tone}
      className={`font-acumin lk-text-4xs tabular-nums ${toneClassName(tone)}`}
    >
      {`${label} ${signedCurrency(value)}`}
    </p>
  );
}

/** 照合の種類ごとに、答えに必ずある配列の鍵（形の検査に使う）。 */
const SHAPE_KEY: Record<string, string> = {
  "stripe-balance": "unjournaled",
  "stripe-fee": "boundary_in",
  intake: "exceptions",
};

type ReadState<T> =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; data: T };

/** 照合の読み口を1回読む。押した直後の2回目は止め、古い答えで上書きしない。 */
function useReconciliation<T>() {
  const [state, setState] = useState<ReadState<T>>({ phase: "idle" });
  const ticket = useRef(0);
  const reset = useCallback(() => {
    ticket.current += 1;
    setState({ phase: "idle" });
  }, []);
  const run = useCallback(async (params: Record<string, string>) => {
    const mine = ++ticket.current;
    setState({ phase: "loading" });
    const result = await getAccountingData<T>("reconciliation", params, (data) => hasArray(data, SHAPE_KEY[params.kind]));
    if (mine !== ticket.current) return;
    setState(result.ok ? { phase: "ready", data: result.data } : { phase: "error", message: result.message });
  }, []);
  return [state, run, reset] as const;
}

function StateNotice<T>({ state }: { state: ReadState<T> }) {
  if (state.phase === "loading") {
    return (
      <p role="status" className={noteClassName}>
        読み込み中
      </p>
    );
  }
  if (state.phase === "error") {
    return (
      <p role="alert" className="font-acumin lk-text-3xs text-red-700">
        {state.message}
      </p>
    );
  }
  return null;
}

// ---- Stripe の残高の照合 ----

type BalanceReconciliation = {
  through: string;
  stripe_balance: number;
  ledger_1160: number;
  ledger_1130_stripe: number;
  difference: number;
  unjournaled: Array<{ kind: string; count: number; net_sum: number }>;
  payout_in_transit_1150: number;
};

const BALANCE_KIND_LABELS: Readonly<Record<string, string>> = {
  planned_p3: "返金の元本（返金の仕訳は別の段で入れます）",
  pending: "計上待ちの取引",
  unknown: "知らない種類の取引",
  payout_unposted: "入金の取引（仕訳がまだ）",
  manual_topup: "残高の補充（手で入れた分を除く）",
};

function BalanceSection({ today }: { today: string }) {
  const [through, setThrough] = useState(today);
  const [state, run, reset] = useReconciliation<BalanceReconciliation>();
  return (
    <Section title="Stripeの残高の照合">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block max-w-xs">
          <span className={labelClassName}>照合する日</span>
          <input type="date" className={inputClassName} value={through} onChange={(e) => { setThrough(e.target.value); reset(); }} />
        </label>
        <Button
          variant="outline"
          size="sm"
          shape="rounded"
          className="font-acumin"
          disabled={!through || state.phase === "loading"}
          onClick={() => void run({ kind: "stripe-balance", through })}
        >
          Stripeの残高を照合する
        </Button>
      </div>
      <p className={noteClassName}>
        Stripe の残高と帳簿（1160 と 1130 の Stripe 分）の差が、仕訳になっていない取引の種類で説明できるかを見ます。
      </p>
      <StateNotice state={state} />
      {state.phase === "ready" ? (
        <BalanceResult data={state.data} />
      ) : null}
    </Section>
  );
}

function BalanceResult({ data }: { data: BalanceReconciliation }) {
  const book = data.ledger_1160 + data.ledger_1130_stripe;
  const explained = data.unjournaled.reduce((sum, row) => sum + row.net_sum, 0);
  const unexplained = data.difference - explained;
  const tone = toneOf(unexplained);
  return (
    <div className="space-y-2">
      <p className={labelClassName}>{`${slash(data.through)} 時点の照合`}</p>
      <Line text={`Stripeの残高 ${signedCurrency(data.stripe_balance)}`} />
      <Line text={`帳簿の残高 ${signedCurrency(book)}`} />
      <Line text={`差 ${signedCurrency(data.difference)}`} />
      <div className="overflow-x-auto">
        <table aria-label="仕訳になっていない取引の種類" className={`${tableClassName} min-w-[420px]`}>
          <thead>
            <tr className="border-b border-[#d4d4d4] text-left text-[#474747]">
              <th scope="col" className="py-2 pr-3 font-normal">種類</th>
              <th scope="col" className="py-2 pr-3 text-right font-normal">件数</th>
              <th scope="col" className="py-2 text-right font-normal">金額</th>
            </tr>
          </thead>
          <tbody>
            {data.unjournaled.map((row) => (
              <tr key={row.kind} className="border-b border-[#ededed] tabular-nums">
                <td className="py-2 pr-3">{BALANCE_KIND_LABELS[row.kind] ?? "その他の取引"}</td>
                <td className="py-2 pr-3 text-right">{`${row.count}件`}</td>
                <td className="py-2 text-right">{signedCurrency(row.net_sum)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p
        data-testid="balance-unexplained"
        data-tone={tone}
        className={`font-acumin lk-text-4xs tabular-nums ${toneClassName(tone)}`}
      >
        {`説明のつかない差 ${signedCurrency(unexplained)}`}
      </p>
      <Line text={`入金途上（1150） ${signedCurrency(data.payout_in_transit_1150)}`} />
    </div>
  );
}

// ---- 手数料の月の照合 ----

type FeeReconciliation = {
  jst_total: number;
  utc_total: number;
  invoice_total: number | null;
  boundary_in: Array<{ txn_id: string; jst_date: string; utc_date: string; fee: number }>;
  boundary_out: Array<{ txn_id: string; jst_date: string; utc_date: string; fee: number }>;
  next_month_adjustments: Array<{ txn_id: string; jst_date: string; amount: number }>;
  diff_jst_utc: number;
  explained_boundary: number;
  unexplained_jst_utc: number;
  diff_utc_invoice: number | null;
  explained_adjustments: number | null;
  unexplained_utc_invoice: number | null;
  journal_vs_txn_diff: number;
};

const slash = (date: string) => date.replaceAll("-", "/");

function BoundaryList({
  title,
  rows,
}: {
  title: string;
  rows: FeeReconciliation["boundary_in"];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className={labelClassName}>{title}</p>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.txn_id} className="font-acumin lk-text-4xs text-black tabular-nums">
            {`${row.txn_id}　日本時間 ${slash(row.jst_date)}・UTC ${slash(row.utc_date)}　${signedCurrency(row.fee)}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FeeResult({ data }: { data: FeeReconciliation }) {
  return (
    <div className="space-y-4">
      <div role="group" aria-label="1段目 日本時間とUTCの差" className="space-y-2 rounded-sm border border-[#ededed] p-3">
        <p className="font-acumin lk-text-4xs font-medium text-black">1段目 日本時間とUTCの差</p>
        <Line text={`日本時間の合計 ${signedCurrency(data.jst_total)}`} />
        <Line text={`UTCの合計 ${signedCurrency(data.utc_total)}`} />
        <Line text={`差 ${signedCurrency(data.diff_jst_utc)}`} />
        <Line text={`月またぎで説明できる差 ${signedCurrency(data.explained_boundary)}`} />
        <BoundaryList title="日本時間ではこの月、UTCでは前の月の取引" rows={data.boundary_in} />
        <BoundaryList title="UTCではこの月、日本時間では翌月の取引" rows={data.boundary_out} />
        <Unexplained testId="fee-unexplained-1" label="説明のつかない差" value={data.unexplained_jst_utc} />
      </div>
      <div role="group" aria-label="2段目 UTCと請求書の差" className="space-y-2 rounded-sm border border-[#ededed] p-3">
        <p className="font-acumin lk-text-4xs font-medium text-black">2段目 UTCと請求書の差</p>
        {data.invoice_total === null ? (
          <p className={noteClassName}>請求書の合計が未入力です。下の欄から入れてください。</p>
        ) : (
          <>
            <Line text={`請求書の合計 ${signedCurrency(data.invoice_total)}`} />
            <Line text={`差 ${signedCurrency(data.diff_utc_invoice ?? 0)}`} />
            <Line text={`翌月の調整で説明できる分 ${signedCurrency(data.explained_adjustments ?? 0)}`} />
            {data.next_month_adjustments.length > 0 ? (
              <ul className="space-y-1">
                {data.next_month_adjustments.map((row) => (
                  <li key={row.txn_id} className="font-acumin lk-text-4xs text-black tabular-nums">
                    {`${row.txn_id}　${slash(row.jst_date)}　${signedCurrency(row.amount)}`}
                  </li>
                ))}
              </ul>
            ) : null}
            <Unexplained testId="fee-unexplained-2" label="説明のつかない差" value={data.unexplained_utc_invoice ?? 0} />
            <p className={noteClassName}>
              請求書との差の符号の向きは確認中です。本物の請求書と調整で確かめるまで、金額の向きは暫定です。
            </p>
          </>
        )}
      </div>
      <Line text={`帳簿の手数料と取引の差 ${signedCurrency(data.journal_vs_txn_diff)}`} />
    </div>
  );
}

function previousMonth(today: string): string {
  const [year, month] = today.split("-").map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

function FeeSection({ today }: { today: string }) {
  const [month, setMonth] = useState(previousMonth(today));
  const [shownMonth, setShownMonth] = useState<string | null>(null);
  const [state, run, reset] = useReconciliation<FeeReconciliation>();
  const runFee = (target: string) => {
    setShownMonth(target);
    void run({ kind: "stripe-fee", month: target });
  };
  return (
    <Section title="手数料の月の照合">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block max-w-xs">
          <span className={labelClassName}>照合する月</span>
          <input type="month" className={inputClassName} value={month} onChange={(e) => { setMonth(e.target.value); setShownMonth(null); reset(); }} />
        </label>
        <Button
          variant="outline"
          size="sm"
          shape="rounded"
          className="font-acumin"
          disabled={!month || state.phase === "loading"}
          onClick={() => runFee(month)}
        >
          手数料を照合する
        </Button>
      </div>
      <p className={noteClassName}>
        1段目は日本時間とUTCの月のずれ、2段目はUTCの合計と Stripe の適格請求書の合計の差です。
      </p>
      <StateNotice state={state} />
      {state.phase === "ready" && shownMonth ? (
        <p className={labelClassName}>{`${monthTitle(shownMonth)}の照合`}</p>
      ) : null}
      {state.phase === "ready" ? <FeeResult data={state.data} /> : null}
      {state.phase === "ready" && shownMonth ? (
        <InvoiceRecordForm key={shownMonth} month={shownMonth} onSaved={() => runFee(shownMonth)} />
      ) : null}
    </Section>
  );
}

// ---- 適格請求書の記録 ----

type InvoiceRecord = {
  month: string;
  total: number;
  tax: number;
  documentRef: string | null;
  enteredAt: string;
  version: string;
};

const monthTitle = (month: string): string => {
  const [year, m] = month.split("-");
  return `${year}年${Number(m)}月`;
};

/** 月ごとの Stripe の適格請求書の合計を記録する。権限（admin.finance.manage）が無ければ読み取りだけ。 */
export function InvoiceRecordForm({
  month,
  onSaved,
}: {
  month: string;
  /** 保存できた後に呼ぶ（手数料の照合を引き直す）。 */
  onSaved?: () => void;
}): React.JSX.Element {
  const [record, setRecord] = useState<InvoiceRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [permissions, setPermissions] = useState<ViewPermissions>(NO_PERMISSIONS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [total, setTotal] = useState("");
  const [tax, setTax] = useState("");
  const [documentRef, setDocumentRef] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const guard = useRef(false);

  const load = useCallback(async () => {
    const result = await getAccountingData<{ record: InvoiceRecord | null }>(
      "stripe-invoices",
      { month },
      (data) => isRecord(data) && "record" in data,
    );
    if (!result.ok) {
      setLoadError(result.message);
      return;
    }
    setLoadError(null);
    setRecord(result.data.record);
    setPermissions(result.permissions);
    setTotal(result.data.record ? String(result.data.record.total) : "");
    setTax(result.data.record ? String(result.data.record.tax) : "");
    setDocumentRef(result.data.record?.documentRef ?? "");
    setLoaded(true);
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = () => {
    setNotice(null);
    void load();
  };

  const save = async () => {
    if (guard.current) return;
    const totalNumber = total.trim() === "" ? Number.NaN : Number(total);
    const taxNumber = tax.trim() === "" ? Number.NaN : Number(tax);
    if (
      !Number.isSafeInteger(totalNumber) || totalNumber < 0 ||
      !Number.isSafeInteger(taxNumber) || taxNumber < 0
    ) {
      setNotice(errorNotice("合計と消費税は0以上の整数で入れてください。"));
      return;
    }
    guard.current = true;
    setSaving(true);
    setNotice(null);
    const result = await sendAccountingJson(accountingUrl("stripe-invoices"), "PUT", {
      month,
      total: totalNumber,
      tax: taxNumber,
      documentRef: documentRef.trim() === "" ? null : documentRef.trim(),
      expectedVersion: record?.version ?? null,
      requestKey: crypto.randomUUID(),
    });
    if (result.ok) {
      const saved = (result.data as { record?: InvoiceRecord } | null)?.record ?? null;
      if (saved) setRecord(saved);
      setNotice(successNotice("保存しました。"));
      onSaved?.();
    } else {
      setNotice(failureNotice(result));
    }
    guard.current = false;
    setSaving(false);
  };

  return (
    <section aria-label={`適格請求書の記録（${monthTitle(month)}）`} className="space-y-3 border-t border-[#ededed] pt-3">
      <p className="font-acumin lk-text-4xs font-medium text-black">{`適格請求書の記録（${monthTitle(month)}）`}</p>
      {loadError ? (
        <div className="space-y-2">
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {loadError}
          </p>
          <Button variant="outline" size="2xs" shape="rounded" className="font-acumin" onClick={reload}>
            もう一度読み込む
          </Button>
        </div>
      ) : null}
      {loaded && record === null ? (
        <p className={noteClassName}>この月の請求書の合計はまだ入っていません</p>
      ) : null}
      {loaded && !permissions.manageFinance ? (
        record ? (
          <div className="space-y-1">
            <Line text={`請求書の合計 ${currency(record.total)}`} />
            <Line text={`うち消費税 ${currency(record.tax)}`} />
          </div>
        ) : null
      ) : null}
      {loaded && permissions.manageFinance ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block">
              <span className={labelClassName}>請求書の合計（税込）</span>
              <input type="number" inputMode="numeric" min={0} step={1} className={inputClassName} value={total} onChange={(e) => setTotal(e.target.value)} />
            </label>
            <label className="block">
              <span className={labelClassName}>うち消費税</span>
              <input type="number" inputMode="numeric" min={0} step={1} className={inputClassName} value={tax} onChange={(e) => setTax(e.target.value)} />
            </label>
            <label className="block">
              <span className={labelClassName}>書類の参照（任意）</span>
              <input type="text" maxLength={200} className={inputClassName} value={documentRef} onChange={(e) => setDocumentRef(e.target.value)} />
            </label>
          </div>
          <Button variant="primary" size="sm" shape="rounded" className="font-acumin" disabled={saving} onClick={() => void save()}>
            請求書の合計を保存
          </Button>
        </div>
      ) : null}
      <NoticeLine notice={notice} onReload={reload} />
    </section>
  );
}

// ---- 受注高と帳簿の照らし合わせ ----

type IntakeReconciliation = {
  opening_backlog: number;
  intake: number;
  sales_before_return: number;
  closing_backlog: number;
  exceptions: Array<{ kind: string; label_key: string; amount: number; event_kind?: string }>;
  unexplained: number;
  returns: number;
  booked_sales_net_orders: number;
  return_fee_revenue_4050: number;
  other_4010: number;
  other_4020: number;
  book_sales_total: number;
  unexplained2: number;
  dispute_confirmed_by_account: Array<{ account_code: string; sub_account: string | null; amount: number }>;
};

function exceptionLabel(row: IntakeReconciliation["exceptions"][number]): string {
  if (row.kind === "dispute_pending") return "カード会社の判断待ち";
  if (row.kind === "return_refund_2130") return "返品の返金待ち";
  return row.event_kind ? `その他（${eventKindLabel(row.event_kind)}）` : "その他";
}

function IntakeResult({ data }: { data: IntakeReconciliation }) {
  return (
    <div className="space-y-4">
      <div role="group" aria-label="1段目 受注残の動き" className="space-y-2 rounded-sm border border-[#ededed] p-3">
        <p className="font-acumin lk-text-4xs font-medium text-black">1段目 受注残の動き</p>
        <Line text={`期首の受注残 ${signedCurrency(data.opening_backlog)}`} />
        <Line text={`受注高 ${signedCurrency(data.intake)}`} />
        <Line text={`返品の前の売上 ${signedCurrency(data.sales_before_return)}`} />
        <Line text={`期末の受注残 ${signedCurrency(data.closing_backlog)}`} />
        {data.exceptions.length > 0 ? (
          <ul aria-label="例外の行" className="space-y-1">
            {data.exceptions.map((row) => (
              <li key={`${row.kind}:${row.event_kind ?? ""}`} className="font-acumin lk-text-4xs text-black tabular-nums">
                {`${exceptionLabel(row)}　${signedCurrency(row.amount)}`}
              </li>
            ))}
          </ul>
        ) : null}
        <Unexplained testId="intake-unexplained-1" label="説明のつかない差" value={data.unexplained} />
      </div>
      <div role="group" aria-label="2段目 売上の照らし合わせ" className="space-y-2 rounded-sm border border-[#ededed] p-3">
        <p className="font-acumin lk-text-4xs font-medium text-black">2段目 売上の照らし合わせ</p>
        <Line text={`返品の前の売上 ${signedCurrency(data.sales_before_return)}`} />
        <Line text={`返品 ${signedCurrency(data.returns)}`} />
        <Line text={`受注の売上（返品を引いた後） ${signedCurrency(data.booked_sales_net_orders)}`} />
        <Line text={`返品の手数料の売上（4050） ${signedCurrency(data.return_fee_revenue_4050)}`} />
        <Line text={`注文に結び付かない売上（4010） ${signedCurrency(data.other_4010)}`} />
        <Line text={`注文に結び付かない値引・返品（4020） ${signedCurrency(data.other_4020)}`} />
        <Line text={`帳簿の売上の合計 ${signedCurrency(data.book_sales_total)}`} />
        <Unexplained testId="intake-unexplained-2" label="説明のつかない差" value={data.unexplained2} />
        {data.dispute_confirmed_by_account.length > 0 ? (
          <div className="space-y-1">
            <p className={labelClassName}>確定した取り消しの勘定別</p>
            <ul aria-label="確定した取り消しの勘定別" className="space-y-1">
              {data.dispute_confirmed_by_account.map((row) => (
                <li key={`${row.account_code}:${row.sub_account ?? ""}`} className="font-acumin lk-text-4xs text-black tabular-nums">
                  {`${row.account_code} ${accountByCode(row.account_code)?.name ?? ""}${row.sub_account ? `（${row.sub_account}）` : ""}　${signedCurrency(row.amount)}`}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function IntakeSection({
  today,
  periodStart,
  periodEnd,
}: {
  today: string;
  periodStart?: string;
  periodEnd?: string;
}) {
  const [from, setFrom] = useState(periodStart ?? `${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(periodEnd ?? today);
  const [state, run, reset] = useReconciliation<IntakeReconciliation>();
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [shownRange, setShownRange] = useState<string | null>(null);
  // 選んでいる会計期間が替わったら、範囲もその期間に合わせ、前の期間の結果は消す。
  useEffect(() => {
    setFrom(periodStart ?? `${today.slice(0, 4)}-01-01`);
    setTo(periodEnd ?? today);
    setShownRange(null);
    setRangeError(null);
    reset();
  }, [periodStart, periodEnd, today, reset]);
  const check = () => {
    if (!from || !to || from > to) {
      setRangeError("開始日は終了日より前にしてください。");
      return;
    }
    setRangeError(null);
    setShownRange(`${slash(from)} 〜 ${slash(to)}`);
    void run({ kind: "intake", from, to });
  };
  return (
    <Section title="受注高と帳簿の照らし合わせ">
      <p className="font-acumin lk-text-4xs text-[#b45309]">受注高は帳簿の売上高ではありません。申告には使いません</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block max-w-xs">
          <span className={labelClassName}>開始日</span>
          <input type="date" className={inputClassName} value={from} onChange={(e) => { setFrom(e.target.value); setShownRange(null); reset(); }} />
        </label>
        <label className="block max-w-xs">
          <span className={labelClassName}>終了日</span>
          <input type="date" className={inputClassName} value={to} onChange={(e) => { setTo(e.target.value); setShownRange(null); reset(); }} />
        </label>
        <Button variant="outline" size="sm" shape="rounded" className="font-acumin" disabled={state.phase === "loading"} onClick={check}>
          受注高を照合する
        </Button>
      </div>
      {rangeError ? (
        <p role="alert" className="font-acumin lk-text-3xs text-red-700">
          {rangeError}
        </p>
      ) : null}
      <StateNotice state={state} />
      {state.phase === "ready" && shownRange ? <p className={labelClassName}>{`${shownRange} の照合`}</p> : null}
      {state.phase === "ready" ? <IntakeResult data={state.data} /> : null}
    </Section>
  );
}

export function ReconciliationView({
  today: todayProp,
  periodStart,
  periodEnd,
}: {
  /** 日本時間の今日（試験用）。 */
  today?: string;
  /** 選んでいる会計期間。受注高の照合の既定の範囲にする。 */
  periodStart?: string;
  periodEnd?: string;
}): React.JSX.Element {
  const today = todayProp ?? todayJst();
  return (
    <div className="space-y-5">
      <BalanceSection today={today} />
      <FeeSection today={today} />
      <IntakeSection today={today} periodStart={periodStart} periodEnd={periodEnd} />
      <YearEndShipmentsPanel today={today} />
    </div>
  );
}
