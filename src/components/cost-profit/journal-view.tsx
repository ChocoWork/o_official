import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { TabSegmentControl } from "@/components/ui/TabSegmentControl/TabSegmentControl";
import type { JournalCursor, ShipmentMeta } from "@/lib/accounting/accounting-types";
import type { SavedJournalEntry } from "@/lib/accounting/journal-types";
import {
  dayLabel,
  eventKindLabel,
  getAccountingData,
  hasArray,
  isRecord,
  jstDayLabel,
  noteClassName,
  Section,
  tableClassName,
} from "./accounting-api";
import { type LedgerTab, LEDGER_TABS } from "./constants";
import { LedgerView } from "./ledger-view";
import { AssetsView } from "./assets-view";
import { StatementsView } from "./statements-view";
import type { CostProfitModel } from "./use-cost-profit-model";

const entryNumber = (entryNo: number): string => `JE-${String(entryNo).padStart(6, "0")}`;

type JournalPage = {
  entries: SavedJournalEntry[];
  nextAfter: JournalCursor | null;
  shipmentMeta: ShipmentMeta[];
};

type Trace = {
  slip: { number: string; confirmed_at: string; shipment_date: string; stage: string };
  history: Array<{
    version: number;
    kind: string;
    previous_date: string;
    new_date: string;
    reason: string | null;
    actor_id: string;
    created_at: string;
  }>;
  entries: Array<{
    entry_id: string;
    entry_no: number;
    event_kind: string;
    entry_date: string;
    recorded_at: string;
    reverses_entry_id: string | null;
  }>;
};

type TraceState =
  | { phase: "loading"; slipId: string }
  | { phase: "error"; slipId: string; message: string }
  | { phase: "ready"; slipId: string; trace: Trace };

/** 出荷の跡（6-b）。直した理由・人・前後の日と、この出荷の仕訳の取り消しと正しい仕訳のつながり。 */
function ShipmentTrace({ state, onClose }: { state: TraceState; onClose: () => void }) {
  return (
    <Section title="出荷の跡">
      <div className="flex justify-end">
        <Button variant="outline" size="2xs" shape="rounded" className="font-acumin" onClick={onClose}>
          出荷の跡を閉じる
        </Button>
      </div>
      {state.phase === "loading" ? (
        <p role="status" className={noteClassName}>
          読み込み中
        </p>
      ) : null}
      {state.phase === "error" ? (
        <p role="alert" className="font-acumin lk-text-3xs text-red-700">
          {state.message}
        </p>
      ) : null}
      {state.phase === "ready" ? <TraceBody trace={state.trace} /> : null}
    </Section>
  );
}

function TraceBody({ trace }: { trace: Trace }) {
  const reversedBy = new Map(
    trace.entries.filter((e) => e.reverses_entry_id).map((e) => [e.reverses_entry_id as string, e]),
  );
  const byId = new Map(trace.entries.map((e) => [e.entry_id, e]));
  return (
    <div className="space-y-4">
      <p className="font-acumin lk-text-3xs text-black">{trace.slip.number}</p>
      <p className="font-acumin lk-text-4xs text-black">{`今の出荷日 ${dayLabel(trace.slip.shipment_date)}`}</p>
      <div className="space-y-1">
        <p className="font-acumin lk-text-4xs font-medium text-black">出荷日の直した跡</p>
        <ul aria-label="出荷日の直した跡" className="space-y-1">
          {trace.history.map((row) => (
            <li key={row.version} className="font-acumin lk-text-4xs text-black tabular-nums">
              {row.kind === "correction"
                ? `${dayLabel(row.previous_date)} から ${dayLabel(row.new_date)} へ直しました。理由 ${row.reason ?? "-"}。担当 ${row.actor_id.slice(0, 8)}。直した日 ${jstDayLabel(row.created_at)}`
                : `最初の出荷日 ${dayLabel(row.new_date)}`}
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-1">
        <p className="font-acumin lk-text-4xs font-medium text-black">この出荷の仕訳</p>
        <ul aria-label="この出荷の仕訳" className="space-y-1">
          {trace.entries.map((entry) => {
            const target = entry.reverses_entry_id ? byId.get(entry.reverses_entry_id) : undefined;
            const reverser = reversedBy.get(entry.entry_id);
            const relation = entry.reverses_entry_id
              ? `${target ? entryNumber(target.entry_no) : "元の仕訳"}を取り消す`
              : reverser
                ? `取り消されました（${entryNumber(reverser.entry_no)}）`
                : "今の正しい仕訳";
            return (
              <li key={entry.entry_id} className="font-acumin lk-text-4xs text-black tabular-nums">
                {`${entryNumber(entry.entry_no)}　${eventKindLabel(entry.event_kind)}　${dayLabel(entry.entry_date)}　${relation}`}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

const PAGE_SIZE = 100;

/**
 * 保存した仕訳の一覧に、出荷の仕訳だけ「出荷した日」（発送票の出荷日）と「登録した日」（発送票を確定した日。日本時間）を並べる
 * （FREQ-564-AC-04）。ほかの仕訳は空。出荷の仕訳から「出荷の跡」（AC-03）を開く。
 */
export function JournalShipmentPanel({ periodId }: { periodId: string | null }) {
  const [entries, setEntries] = useState<SavedJournalEntry[]>([]);
  const [meta, setMeta] = useState<Record<string, ShipmentMeta>>({});
  const [next, setNext] = useState<JournalCursor | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [trace, setTrace] = useState<TraceState | null>(null);

  const read = useCallback(
    async (cursor: JournalCursor | null) => {
      if (!periodId) return null;
      return getAccountingData<JournalPage>("journal", {
        periodId,
        limit: PAGE_SIZE,
        afterEntryDate: cursor?.entryDate,
        afterEntryNo: cursor?.entryNo,
      }, (data) => hasArray(data, "entries") && hasArray(data, "shipmentMeta"));
    },
    [periodId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setEntries([]);
    setMeta({});
    setNext(null);
    setTrace(null);
    void (async () => {
      const result = await read(null);
      if (cancelled || result === null) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setError(null);
      setEntries(result.data.entries);
      setMeta(Object.fromEntries(result.data.shipmentMeta.map((m) => [m.entryId, m])));
      setNext(result.data.nextAfter);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [read]);

  const loadMore = async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    const result = await read(next);
    setLoadingMore(false);
    if (result === null) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setEntries((current) => [...current, ...result.data.entries]);
    setMeta((current) => ({
      ...current,
      ...Object.fromEntries(result.data.shipmentMeta.map((m) => [m.entryId, m])),
    }));
    setNext(result.data.nextAfter);
  };

  const openTrace = async (slipId: string) => {
    setTrace({ phase: "loading", slipId });
    const result = await getAccountingData<Trace>(
      "shipment-trace",
      { slipId },
      (data) => hasArray(data, "history") && hasArray(data, "entries") && isRecord((data as Record<string, unknown>).slip),
    );
    setTrace(
      result.ok
        ? { phase: "ready", slipId, trace: result.data }
        : { phase: "error", slipId, message: result.message },
    );
  };

  return (
    <div className="space-y-4">
      <Section title="出荷の仕訳の日付">
        <p className={noteClassName}>
          出荷の仕訳には、発送票の出荷日を「出荷した日」、発送票を確定した日を「登録した日」として並べます。ほかの仕訳は空です。
        </p>
        {!periodId ? <p className={noteClassName}>期間を選ぶと、出荷の仕訳の日付を出します</p> : null}
        {error ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {error}
          </p>
        ) : null}
        {periodId && loaded && entries.length === 0 ? (
          <p className={noteClassName}>この期間に保存した仕訳はありません</p>
        ) : null}
        {entries.length > 0 ? (
          <div className="overflow-x-auto">
            <table aria-label="保存した仕訳" className={`${tableClassName} min-w-[640px]`}>
              <thead>
                <tr className="border-b border-[#d4d4d4] text-left text-[#474747]">
                  <th scope="col" className="py-2 pr-3 font-normal">伝票No.</th>
                  <th scope="col" className="py-2 pr-3 font-normal">日付</th>
                  <th scope="col" className="py-2 pr-3 font-normal">摘要</th>
                  <th scope="col" className="py-2 pr-3 font-normal">出荷した日</th>
                  <th scope="col" className="py-2 pr-3 font-normal">登録した日</th>
                  <th scope="col" className="py-2 font-normal">出荷の跡</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const shipment = meta[entry.id];
                  const number = entryNumber(entry.entryNo);
                  return (
                    <tr key={entry.id} className="border-b border-[#ededed] tabular-nums">
                      <td className="py-2 pr-3">{number}</td>
                      <td className="py-2 pr-3">{dayLabel(entry.entryDate)}</td>
                      <td className="py-2 pr-3">{entry.description}</td>
                      <td className="py-2 pr-3">{shipment ? dayLabel(shipment.shipmentDate) : ""}</td>
                      <td className="py-2 pr-3">{shipment ? jstDayLabel(shipment.confirmedAt) : ""}</td>
                      <td className="py-2">
                        {shipment && entry.sourceId ? (
                          <Button
                            variant="outline"
                            size="2xs"
                            shape="rounded"
                            className="font-acumin"
                            aria-label={`${number}の出荷の跡を開く`}
                            onClick={() => void openTrace(entry.sourceId as string)}
                          >
                            出荷の跡
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {next ? (
          <Button variant="outline" size="sm" shape="rounded" className="font-acumin" disabled={loadingMore} onClick={() => void loadMore()}>
            さらに読み込む
          </Button>
        ) : null}
      </Section>
      {trace ? <ShipmentTrace state={trace} onClose={() => setTrace(null)} /> : null}
    </div>
  );
}

export function JournalView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    ledgerTab,
    setLedgerTab,
    period,
  } = model;
  const [shipmentOpen, setShipmentOpen] = useState(false);
  const ledgerView = <LedgerView model={model} />;
  const assetsView = <AssetsView model={model} />;
  const statementsView = <StatementsView model={model} />;
  return (
    <div className="space-y-4">
      {/* 主要簿（仕訳・元帳）／固定資産／決算・試算表。入力は取引管理に一本化する。 */}
      <div className="overflow-x-auto">
        <TabSegmentControl
          variant="segment-pill"
          size="sm"
          items={LEDGER_TABS}
          activeKey={ledgerTab}
          onChange={(key) => setLedgerTab(key as LedgerTab)}
        />
      </div>

      {ledgerTab === "ledger" ? ledgerView : null}
      {ledgerTab === "ledger" ? (
        <div className="space-y-3">
          <Button
            variant="outline"
            size="sm"
            shape="rounded"
            className="font-acumin"
            aria-expanded={shipmentOpen}
            onClick={() => setShipmentOpen((open) => !open)}
          >
            出荷した日と登録した日を見る
          </Button>
          {shipmentOpen ? <JournalShipmentPanel periodId={period?.id ?? null} /> : null}
        </div>
      ) : null}
      {ledgerTab === "assets" ? assetsView : null}
      {ledgerTab === "closing" ? statementsView : null}
    </div>
  );
}
