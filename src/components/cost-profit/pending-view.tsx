"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { ACCOUNTING_TEXT } from "@/lib/accounting/accounting-types";
import type {
  PendingEvent,
  PendingEventsPage,
  PendingReason,
  PostingRunResult,
} from "@/lib/accounting/posting-types";
import {
  accountingUrl,
  dayLabel,
  eventKindLabel,
  getAccountingData,
  hasArray,
  jstDayLabel,
  labelClassName,
  noteClassName,
  NO_PERMISSIONS,
  Section,
  type ViewPermissions,
} from "./accounting-api";
import { DeferredRevenuePanel } from "./deferred-revenue-panel";
import { currency } from "./constants";
import {
  errorNotice,
  failureNotice,
  NoticeLine,
  sendAccountingJson,
  successNotice,
  type Notice,
} from "./period-form";

// 計上待ちのタブ（FREQ-569）。止まっている出来事を理由つきで出し、もう一度計上する、確認済みにするを行う。
// 理由の文はやさしい日本語。名前・メール・住所・生の例外の文は出さない（route の読み口が持たない）。
// 確認済みにできるのは before_cutover と no_revenue だけ。お金の動く理由の行は、仕訳が入るまで閉じられない。

const PAGE_SIZE = 50;
const MAX_NOTE = 500;
/** 確認済みにできる理由（route と DB も同じ2つだけ許す）。 */
const CLOSABLE: ReadonlySet<PendingReason> = new Set<PendingReason>(["before_cutover", "no_revenue"]);

export const POSTING_ERROR_TEXT =
  "この出来事を帳簿に入れる処理で失敗しました。元の記録や設定を確かめ、直してから『もう一度計上する』を押してください。他の出来事の計上は続けています。";

const DISPUTE_WITHDRAWAL_TEXT = {
  account: "確定した損失を、振り替え先の科目が決まっていない仮払金に置いています。設定のタブで科目を決め、「確定・科目の決定待ち」を振り替えると、計上が進みます。",
  earlier: "前の段の仕訳（カード会社に引かれた時や、確定の仕訳）がまだ入っていません。入ると自動で計上されます。",
  undecided: "カード会社からの支払いの取り消しの判断がまだ決着していません。決着すると、戻りの扱いを決めて計上します。",
} as const;

const REASON_TEXT: Readonly<Record<Exclude<PendingReason, "period_missing" | "dispute_withdrawal_missing">, string>> = {
  payment_journal_missing: "この出荷の注文の支払いが、まだ帳簿に入っていません。支払いが入ると自動で計上されます。",
  order_not_postable: "この注文は送料や合計が決まりの形と合わないため、自動で計上できません。内容を確かめてください。",
  amount_mismatch: "Stripe の取引の総額が、注文の支払額と違います。取引が同期し直されると、もう一度確かめます。",
  no_order: "Stripe に、注文と結び付かない支払いが届いています。注文以外の入金でないか、内容を確かめてください。",
  units_insufficient: "この発送票で送る着の数が、まだ送っていない着の数より多くなっています。この発送票を取り消すと、この行は閉じます。",
  shipment_date_mismatch: "発送ごとの出荷日と発送票の出荷日が食い違っています。日が直されると自動で計上されます。",
  deferred_revenue_short: "出荷の額が、この注文の前受金の残りより多くなっています。支払いや戻しが入ると自動で計上されます。",
  posting_error: POSTING_ERROR_TEXT,
  before_cutover: "新しい帳簿を始めた日より前の出来事です。確かめて、確認済みにしてください。",
  unknown_category: "Stripe の残高の取引に、まだ知らない種類のものがあります。種類の対応が足されると自動で計上されます。",
  payout_mismatch: "入金の中身の合計と額が合っていません。Stripe の精算のタブで照合が済むと、自動で計上されます。",
  dispute_refund_overlap: "カード会社からの支払いの取り消しがある注文に、成功した返金があります。二重に費用にしないため止めています。返金や返品の仕訳と合わせた後に計上されます。",
  dispute_return_refund_pending: "カード会社からの支払いの取り消しがある注文に、返品の返金待ちがあります。返金や返品の仕訳が入った後に計上されます。",
  dispute_shipment_pending: "引かれた時より前に確定した発送票で、出荷の仕訳がまだ入っていない物があります。出荷の仕訳が入ると自動で計上されます。",
  shipment_lines_mismatch: "発送票の明細と、発送ごとの明細の品ごとの数量が食い違っています。直ると自動で計上されます。",
  no_revenue: "仕訳にする額が0円です（交換の品だけの発送票など）。確かめて、確認済みにしてください。",
};

/** 止めの理由を、やさしい文にする。固定のコードはそのまま出さない。 */
export function reasonText(event: PendingEvent): string {
  switch (event.reason) {
    case "period_missing":
      return event.detail.cause === "sole_ended_not_switched"
        ? "この日はやめた日より後です。やめた日が正しいか確かめ、正しければ事業の形を法人へ切り替えてください。設定・期間のタブで行えます。"
        : "この日を含む会計の期間がありません。設定・期間のタブで期間を作ると、自動で計上されます。";
    case "dispute_withdrawal_missing":
      if (event.detail.waiting_on === "dispute_account_unassigned") return DISPUTE_WITHDRAWAL_TEXT.account;
      // 判断の待ちは dispute_status が付く時だけ。ほかは、前の段の仕訳（引かれた時・確定・戻りより前の段）を待っている。
      if (typeof event.detail.dispute_status === "string") return DISPUTE_WITHDRAWAL_TEXT.undecided;
      return DISPUTE_WITHDRAWAL_TEXT.earlier;
    case "no_order":
      // 取り消しの出来事で、取り消しに結び付く注文が無い時は、支払いの文は合わない。
      return event.eventKind === "dispute_event"
        ? "カード会社からの支払いの取り消しに、結び付く注文が見つかりません。取り消しの内容を確かめてください。"
        : REASON_TEXT.no_order;
    default:
      return REASON_TEXT[event.reason];
  }
}

/** 理由ごとの補足（固定の鍵だけから作る）。無ければ null。 */
function detailHint(event: PendingEvent): string | null {
  const { detail } = event;
  if (event.reason === "order_not_postable") {
    if (detail.reason === "shipping") return "送料の欄が0ではありません。";
    if (detail.reason === "units_sum") return "注文の合計と1着ごとの支払額の合計が合いません。";
    if (detail.reason === "units_missing") return "1着ごとの支払額が見つかりません。";
  }
  if (event.reason === "amount_mismatch" && typeof detail.stripe_amount === "number" && typeof detail.order_total === "number") {
    return `Stripe の総額 ${currency(detail.stripe_amount)}、注文の支払額 ${currency(detail.order_total)}`;
  }
  if (event.reason === "deferred_revenue_short" && typeof detail.shortage === "number") {
    return `不足 ${currency(detail.shortage)}`;
  }
  if (event.reason === "payment_journal_missing" && typeof detail.order_count === "number" && detail.order_count > 1) {
    return `支払いの仕訳が無い注文が ${detail.order_count} 件あります。`;
  }
  return null;
}

/** 行の日。仕訳にしようとした日が分かる時はそれ、無ければ見つけた日。 */
function eventDay(event: PendingEvent): string {
  const entryDate = event.detail.entry_date;
  if (typeof entryDate === "string") return `出来事の日 ${dayLabel(entryDate)}`;
  return `見つけた日 ${jstDayLabel(event.firstDetectedAt)}`;
}

function runSummary(result: PostingRunResult): string {
  const total = result.payments + result.shipments + result.stripe + result.disputes;
  return `${total}件を計上しました（支払い${result.payments}件・出荷${result.shipments}件・Stripe${result.stripe}件・支払いの取り消し${result.disputes}件）。新しく止めた${result.parked}件、解決した${result.resolved}件。`;
}

function PostingErrorGuide({ event }: { event: PendingEvent }) {
  const code = typeof event.detail.error_code === "string" ? event.detail.error_code : "unexpected_error";
  const sqlstate = typeof event.detail.error_sqlstate === "string" ? event.detail.error_sqlstate : "-";
  return (
    <div className="space-y-1 rounded-sm bg-[#f7f7f7] px-3 py-2">
      <p className="font-acumin lk-text-4xs text-black">{`理由のコード ${code}（SQLSTATE ${sqlstate}）`}</p>
      <p className={noteClassName}>
        処理の修正が必要な時は、運用の担当へ次のコードを伝えてください。生の例外の文はここには出しません。
      </p>
      <div className="flex flex-wrap gap-3 font-acumin lk-text-4xs">
        {event.orderId ? (
          <Link href={`/admin/orders/${event.orderId}`} className="underline underline-offset-4">
            元の注文を開く
          </Link>
        ) : null}
        {event.sourceTable === "shipment_slips" ? (
          <Link href={`/admin/shipment-slips/${event.sourceId}`} className="underline underline-offset-4">
            発送票を開く
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function PendingView(): React.JSX.Element {
  const [events, setEvents] = useState<PendingEvent[]>([]);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [next, setNext] = useState<{ at: string; id: string } | null>(null);
  const [permissions, setPermissions] = useState<ViewPermissions>(NO_PERMISSIONS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [running, setRunning] = useState(false);
  const runGuard = useRef(false);
  const [runNotice, setRunNotice] = useState<Notice | null>(null);
  const [runResult, setRunResult] = useState<PostingRunResult | null>(null);

  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [memo, setMemo] = useState("");
  const [sendingResolve, setSendingResolve] = useState(false);
  const resolveGuard = useRef(false);
  const [resolveNotice, setResolveNotice] = useState<Notice | null>(null);

  /** 先頭の1ページを読み直す（続きは捨てる）。 */
  const load = useCallback(async () => {
    const result = await getAccountingData<PendingEventsPage>("pending-events", {
      includeResolved: "false",
      limit: PAGE_SIZE,
    }, (data) => hasArray(data, "events"));
    if (!result.ok) {
      setLoadError(result.message);
      return;
    }
    setLoadError(null);
    setEvents(result.data.events);
    setOpenCount(result.data.openCount);
    setNext(
      result.data.nextAfterAt && result.data.nextAfterId
        ? { at: result.data.nextAfterAt, id: result.data.nextAfterId }
        : null,
    );
    setPermissions(result.permissions);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    const result = await getAccountingData<PendingEventsPage>("pending-events", {
      includeResolved: "false",
      limit: PAGE_SIZE,
      afterAt: next.at,
      afterId: next.id,
    }, (data) => hasArray(data, "events"));
    setLoadingMore(false);
    if (!result.ok) {
      setLoadError(result.message);
      return;
    }
    setEvents((current) => [...current, ...result.data.events]);
    setOpenCount(result.data.openCount);
    setNext(
      result.data.nextAfterAt && result.data.nextAfterId
        ? { at: result.data.nextAfterAt, id: result.data.nextAfterId }
        : null,
    );
  };

  const runPosting = async () => {
    if (runGuard.current) return;
    runGuard.current = true;
    setRunning(true);
    setRunNotice(null);
    setRunResult(null);
    const result = await sendAccountingJson(accountingUrl("posting/run"), "POST", {});
    if (result.ok) {
      const run = (result.data as { result?: PostingRunResult } | null)?.result;
      if (run) {
        setRunResult(run);
        setRunNotice(successNotice(runSummary(run)));
      } else {
        setRunNotice(errorNotice(ACCOUNTING_TEXT.failed));
      }
      await load();
    } else {
      setRunNotice(failureNotice(result));
    }
    runGuard.current = false;
    setRunning(false);
  };

  const openResolve = (id: string) => {
    setResolvingId(id);
    setMemo("");
    setResolveNotice(null);
  };

  const sendResolve = async (id: string) => {
    const note = memo.trim();
    if (note === "" || resolveGuard.current) return;
    resolveGuard.current = true;
    setSendingResolve(true);
    const result = await sendAccountingJson(accountingUrl(`pending-events/${id}/resolve`), "POST", {
      note,
      requestKey: crypto.randomUUID(),
    });
    if (result.ok) {
      setResolvingId(null);
      setMemo("");
      setResolveNotice(successNotice("確認済みにしました。"));
    } else {
      // すでに解決済み・今は閉じられない、の409も、穏やかな文を出して一覧を読み直す。
      setResolveNotice(failureNotice(result));
      if (result.code === "ACCOUNTING_PENDING_RESOLVED" || result.code === "ACCOUNTING_EVENT_NOT_POSTABLE") {
        setResolvingId(null);
      }
    }
    await load();
    resolveGuard.current = false;
    setSendingResolve(false);
  };

  return (
    <div className="space-y-5">
      <Section title="計上待ち">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-acumin lk-text-3xs text-black">
            {openCount === null ? "読み込み中" : `未解決 ${openCount}件`}
          </p>
          {permissions.manageFinance ? (
            <Button
              variant="outline"
              size="sm"
              shape="rounded"
              className="font-acumin"
              disabled={running}
              onClick={() => void runPosting()}
            >
              もう一度計上する
            </Button>
          ) : null}
        </div>
        <NoticeLine notice={runNotice} onReload={() => void load()} />
        {runResult?.hasMore ? (
          <p className={noteClassName}>まだ残りがあります。もう一度押してください。</p>
        ) : null}
        <NoticeLine notice={resolveNotice} onReload={() => void load()} />

        {loadError ? (
          <div className="space-y-2">
            <p role="alert" className="font-acumin lk-text-3xs text-red-700">
              {loadError}
            </p>
            <Button variant="outline" size="sm" shape="rounded" className="font-acumin" onClick={() => void load()}>
              もう一度読み込む
            </Button>
          </div>
        ) : null}

        {openCount !== null && events.length === 0 && !loadError ? (
          <p className="font-acumin lk-text-3xs text-[#474747]">計上待ちはありません</p>
        ) : null}

        {events.length > 0 ? (
          <ul aria-label="計上待ちの一覧" className="space-y-3">
            {events.map((event) => {
              const closable = CLOSABLE.has(event.reason);
              const hint = detailHint(event);
              return (
                <li key={event.id} className="space-y-2 rounded-sm border border-[#ededed] p-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-acumin lk-text-4xs text-[#474747]">
                    <span className="text-black">{eventKindLabel(event.eventKind)}</span>
                    <span className="tabular-nums">{eventDay(event)}</span>
                    <span>{`見つけた回数 ${event.detectionCount}回`}</span>
                  </div>
                  <p data-testid="pending-reason" className="font-acumin lk-text-3xs text-black">
                    {reasonText(event)}
                  </p>
                  {hint ? <p className={noteClassName}>{hint}</p> : null}
                  {event.reason === "posting_error" ? <PostingErrorGuide event={event} /> : null}
                  {closable ? (
                    permissions.correctEntries ? (
                      resolvingId === event.id ? (
                        <div className="space-y-2">
                          <label className="block">
                            <span className={labelClassName}>メモ（必須）</span>
                            <textarea
                              maxLength={MAX_NOTE}
                              className="h-20 w-full rounded-md border border-[#d4d4d4] bg-white px-3 py-2 font-acumin lk-text-sm text-black focus:border-black focus:outline-none"
                              value={memo}
                              onChange={(e) => setMemo(e.target.value)}
                            />
                          </label>
                          <p className={noteClassName}>{`何を確かめたかを${MAX_NOTE}文字までで書いてください。個人の名前やメールは書かないでください。`}</p>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="primary"
                              size="sm"
                              shape="rounded"
                              className="font-acumin"
                              disabled={memo.trim() === "" || sendingResolve}
                              onClick={() => void sendResolve(event.id)}
                            >
                              確認済みにして送る
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              shape="rounded"
                              className="font-acumin"
                              onClick={() => setResolvingId(null)}
                            >
                              やめる
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          shape="rounded"
                          className="font-acumin"
                          onClick={() => openResolve(event.id)}
                        >
                          確認済みにする
                        </Button>
                      )
                    ) : (
                      <p className={noteClassName}>確認済みにできるのは、権限のある人だけです</p>
                    )
                  ) : (
                    <p className={noteClassName}>仕訳が入るまで閉じられません</p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}

        {next ? (
          <Button
            variant="outline"
            size="sm"
            shape="rounded"
            className="font-acumin"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            さらに読み込む
          </Button>
        ) : null}
      </Section>

      <DeferredRevenuePanel />
    </div>
  );
}
