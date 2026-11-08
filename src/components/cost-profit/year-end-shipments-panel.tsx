"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { SHIPPING_CARRIERS } from "@/lib/orders/shipping-carriers";
import type { ShippingCarrierId } from "@/lib/orders/shipping-carriers";
import {
  accountingUrl,
  dayLabel,
  getAccountingData,
  hasArray,
  inputClassName,
  isRecord,
  labelClassName,
  LIST_RESTART_CODE,
  noteClassName,
  NO_PERMISSIONS,
  Section,
  tableClassName,
  todayJst,
  jstDayLabel,
  type ViewPermissions,
} from "./accounting-api";
import {
  failureNotice,
  NoticeLine,
  sendAccountingJson,
  successNotice,
  type Notice,
} from "./period-form";

// 年末の出荷の一覧（FREQ-574）。12月25日〜翌年1月10日に出荷した発送票を、運送会社・追跡番号・出荷した日つきで出し、
// 人が確かめた印を付ける。運送会社の受付日との照らし合わせは設定のオプション（既定オフ）で、オンの時だけずれの一覧が出る。
// 答えは SQL の snake_case のまま。範囲は最大60日。

type YearEndSlip = {
  slip_id: string;
  number: string;
  shipment_date: string;
  confirmed_at: string;
  stage: string;
  shipping_carrier: string | null;
  tracking_number: string | null;
  checked_at: string | null;
  checked_by: string | null;
  check_stale: boolean;
};

type ShippingOptions = {
  carrier_date_check_enabled: boolean;
  changed_at: string | null;
  changed_by: string | null;
  version: string;
};

type CarrierGaps = {
  enabled: boolean;
  slips: Array<{ slip_id: string; number: string; shipment_date: string; carrier_accepted_date: string; gap_days: number }>;
  has_more: boolean;
};

type YearEndData = {
  slips: YearEndSlip[];
  next_after_date: string | null;
  next_after_slip: string | null;
  options: ShippingOptions;
  carrier_gaps: CarrierGaps;
};

const PAGE_LIMIT = 100;
/** route と同じ上限（from から to までの日数の差が59日以内 = 60日）。 */
const MAX_RANGE_DAYS = 59;

/** 年末の一覧の答えの形（slips・options・carrier_gaps）。 */
const isYearEndData = (data: unknown): boolean =>
  hasArray(data, "slips") &&
  isRecord((data as Record<string, unknown>).options) &&
  isRecord((data as Record<string, unknown>).carrier_gaps);

const daysBetween = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

/** 範囲の既定。年末（12月25日）〜翌年1月10日。上半期（6月まで）の間は前の年の年末を指す。 */
export function defaultYearEndRange(today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const base = month <= 6 ? year - 1 : year;
  return { from: `${base}-12-25`, to: `${base + 1}-01-10` };
}

function carrierLabel(id: string | null): string {
  if (!id) return "-";
  return (SHIPPING_CARRIERS as Record<string, { label: string }>)[id as ShippingCarrierId]?.label ?? "その他の運送会社";
}

const STAGE_LABELS: Readonly<Record<string, string>> = { confirmed: "確定", cancelled: "取り消し" };

export const STALE_CHECK_TEXT = "確かめた後で日付か追跡が変わりました";

export function YearEndShipmentsPanel({ today: todayProp }: { today?: string }): React.JSX.Element {
  const today = todayProp ?? todayJst();
  const initial = defaultYearEndRange(today);
  const [fromInput, setFromInput] = useState(initial.from);
  const [toInput, setToInput] = useState(initial.to);
  // 今出している範囲と、続きの目印（ページの先頭は null）。
  const [range, setRange] = useState(initial);
  const [cursor, setCursor] = useState<{ date: string; slip: string } | null>(null);
  const [data, setData] = useState<YearEndData | null>(null);
  const [permissions, setPermissions] = useState<ViewPermissions>(NO_PERMISSIONS);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [marking, setMarking] = useState<string | null>(null);
  const guard = useRef(false);
  const latest = useRef(0);

  const load = useCallback(
    async (target: { from: string; to: string }, after: { date: string; slip: string } | null) => {
      const ticket = ++latest.current;
      const result = await getAccountingData<YearEndData>("year-end-shipments", {
        from: target.from,
        to: target.to,
        limit: PAGE_LIMIT,
        afterDate: after?.date,
        afterSlip: after?.slip,
      }, isYearEndData);
      if (ticket !== latest.current) return;
      if (!result.ok) {
        if (result.code === LIST_RESTART_CODE) {
          // 目印が古い。一覧を先頭から読み直す。
          setNotice(successNotice("一覧が変わったため、最初から読み直しました"));
          setCursor(null);
          return;
        }
        setError(result.message);
        return;
      }
      setError(null);
      setData(result.data);
      setPermissions(result.permissions);
    },
    [],
  );

  useEffect(() => {
    void load(range, cursor);
  }, [load, range, cursor]);

  const applyRange = () => {
    if (!fromInput || !toInput || fromInput > toInput) {
      setRangeError("開始日は終了日より前にしてください。");
      return;
    }
    if (daysBetween(fromInput, toInput) > MAX_RANGE_DAYS) {
      setRangeError("範囲は60日までです。");
      return;
    }
    setRangeError(null);
    setNotice(null);
    setCursor(null);
    // 新しい範囲の値で読み直す（同じ範囲でも別の値として扱うので、必ず読み直す）。
    setRange({ from: fromInput, to: toInput });
  };

  const mark = async (slip: YearEndSlip) => {
    if (guard.current) return;
    guard.current = true;
    setMarking(slip.slip_id);
    setNotice(null);
    const result = await sendAccountingJson(accountingUrl("year-end-shipments"), "POST", {
      slipId: slip.slip_id,
      note: null,
      requestKey: crypto.randomUUID(),
    });
    if (result.ok) {
      await load(range, cursor);
    } else {
      setNotice(failureNotice(result));
    }
    guard.current = false;
    setMarking(null);
  };

  return (
    <Section title="年末の出荷の確認">
      <p className={noteClassName}>
        年をまたぐ出荷が、出荷した年の売上になっているかを確かめます。運送会社・追跡番号・出荷した日を見て、確かめた発送票に印を付けてください。
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block max-w-xs">
          <span className={labelClassName}>開始日</span>
          <input type="date" className={inputClassName} value={fromInput} onChange={(e) => setFromInput(e.target.value)} />
        </label>
        <label className="block max-w-xs">
          <span className={labelClassName}>終了日</span>
          <input type="date" className={inputClassName} value={toInput} onChange={(e) => setToInput(e.target.value)} />
        </label>
        <Button variant="outline" size="sm" shape="rounded" className="font-acumin" onClick={applyRange}>
          この範囲で出す
        </Button>
      </div>
      {rangeError ? (
        <p role="alert" className="font-acumin lk-text-3xs text-red-700">
          {rangeError}
        </p>
      ) : null}
      {error ? (
        <div className="space-y-2">
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {error}
          </p>
          <Button variant="outline" size="2xs" shape="rounded" className="font-acumin" onClick={() => void load(range, cursor)}>
            もう一度読み込む
          </Button>
        </div>
      ) : null}
      <NoticeLine notice={notice} onReload={() => void load(range, cursor)} />

      {data ? (
        <>
          {data.slips.length === 0 ? (
            <p className={noteClassName}>この範囲に出荷した発送票はありません</p>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="年末の発送票" className={`${tableClassName} min-w-[720px]`}>
                <thead>
                  <tr className="border-b border-[#d4d4d4] text-left text-[#474747]">
                    <th scope="col" className="py-2 pr-3 font-normal">発送票</th>
                    <th scope="col" className="py-2 pr-3 font-normal">出荷した日</th>
                    <th scope="col" className="py-2 pr-3 font-normal">状態</th>
                    <th scope="col" className="py-2 pr-3 font-normal">運送会社</th>
                    <th scope="col" className="py-2 pr-3 font-normal">追跡番号</th>
                    <th scope="col" className="py-2 font-normal">確かめた印</th>
                  </tr>
                </thead>
                <tbody>
                  {data.slips.map((slip) => (
                    <tr key={slip.slip_id} className="border-b border-[#ededed] align-top tabular-nums">
                      <td className="py-2 pr-3">{slip.number}</td>
                      <td className="py-2 pr-3">{dayLabel(slip.shipment_date)}</td>
                      <td className="py-2 pr-3">{STAGE_LABELS[slip.stage] ?? slip.stage}</td>
                      <td className="py-2 pr-3">{carrierLabel(slip.shipping_carrier)}</td>
                      <td className="py-2 pr-3">{slip.tracking_number ?? "-"}</td>
                      <td className="py-2">
                        <div className="space-y-1">
                          {slip.checked_at === null ? (
                            <p>まだ確かめていません</p>
                          ) : slip.check_stale ? (
                            <p className="text-[#b45309]">{STALE_CHECK_TEXT}</p>
                          ) : (
                            <p>{`確かめ済み ${jstDayLabel(slip.checked_at)}`}</p>
                          )}
                          {permissions.manageFinance && (slip.checked_at === null || slip.check_stale) ? (
                            <Button
                              variant="outline"
                              size="2xs"
                              shape="rounded"
                              className="font-acumin"
                              disabled={marking !== null}
                              aria-label={`${slip.number}を${slip.check_stale ? "もう一度" : ""}確かめた`}
                              onClick={() => void mark(slip)}
                            >
                              {slip.check_stale ? "もう一度確かめた" : "確かめた"}
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {cursor ? (
              <Button variant="outline" size="sm" shape="rounded" className="font-acumin" onClick={() => setCursor(null)}>
                最初のページへ
              </Button>
            ) : null}
            {data.next_after_date && data.next_after_slip ? (
              <Button
                variant="outline"
                size="sm"
                shape="rounded"
                className="font-acumin"
                onClick={() => setCursor({ date: data.next_after_date as string, slip: data.next_after_slip as string })}
              >
                次のページ
              </Button>
            ) : null}
          </div>

          <div className="space-y-2 border-t border-[#ededed] pt-3">
            <p className="font-acumin lk-text-4xs font-medium text-black">運送会社の受付日とのずれ</p>
            {!data.carrier_gaps.enabled ? (
              <p className={noteClassName}>運送会社の受付日との照らし合わせはオフです</p>
            ) : data.carrier_gaps.slips.length === 0 ? (
              <p className={noteClassName}>出荷した日と運送会社の受付日が1日以上ずれた発送票はありません</p>
            ) : (
              <div className="overflow-x-auto">
                <table aria-label="運送会社の受付日とのずれ" className={`${tableClassName} min-w-[480px]`}>
                  <thead>
                    <tr className="border-b border-[#d4d4d4] text-left text-[#474747]">
                      <th scope="col" className="py-2 pr-3 font-normal">発送票</th>
                      <th scope="col" className="py-2 pr-3 font-normal">出荷した日</th>
                      <th scope="col" className="py-2 pr-3 font-normal">運送会社の受付日</th>
                      <th scope="col" className="py-2 font-normal">ずれ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.carrier_gaps.slips.map((gap) => (
                      <tr key={gap.slip_id} className="border-b border-[#ededed] tabular-nums">
                        <td className="py-2 pr-3">{gap.number}</td>
                        <td className="py-2 pr-3">{dayLabel(gap.shipment_date)}</td>
                        <td className="py-2 pr-3">{dayLabel(gap.carrier_accepted_date)}</td>
                        <td className="py-2">{gap.gap_days > 0 ? `${gap.gap_days}日後` : `${-gap.gap_days}日前`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.carrier_gaps.enabled && data.carrier_gaps.has_more ? (
              <p className="font-acumin lk-text-4xs text-[#b45309]">{`${PAGE_LIMIT}件を超えました。範囲を狭めてください`}</p>
            ) : null}
          </div>
        </>
      ) : error ? null : (
        <p role="status" className={noteClassName}>
          読み込み中
        </p>
      )}
    </Section>
  );
}

/** 設定のタブ。運送会社の受付日との照らし合わせのオン・オフ（既定オフ）。保存は admin.accounting.settings.manage の人だけ。 */
export function ShippingOptionsSection({ today: todayProp }: { today?: string }): React.JSX.Element {
  const today = todayProp ?? todayJst();
  const [options, setOptions] = useState<ShippingOptions | null>(null);
  const [manage, setManage] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const guard = useRef(false);

  // 設定は年末の一覧の読み口が一緒に返す。1日・1件だけ読む。
  const load = useCallback(async () => {
    const result = await getAccountingData<YearEndData>("year-end-shipments", { from: today, to: today, limit: 1 }, isYearEndData);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    setOptions(result.data.options);
    setEnabled(result.data.options.carrier_date_check_enabled);
    setManage(result.permissions.manageSettings);
  }, [today]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!options || guard.current) return;
    guard.current = true;
    setSaving(true);
    setNotice(null);
    const result = await sendAccountingJson(accountingUrl("year-end-shipments"), "PUT", {
      carrierDateCheckEnabled: enabled,
      expectedVersion: options.version,
      requestKey: crypto.randomUUID(),
    });
    if (result.ok) {
      const saved = (result.data as { options?: ShippingOptions } | null)?.options;
      if (saved) {
        setOptions(saved);
        setEnabled(saved.carrier_date_check_enabled);
      }
      setNotice(successNotice("保存しました。"));
    } else {
      setNotice(failureNotice(result));
    }
    guard.current = false;
    setSaving(false);
  };

  return (
    <Section title="運送会社の受付日">
      <p className={noteClassName}>
        年末の出荷の確認で、出荷した日と運送会社の受付日のずれを一覧に出します。既定はオフです。
      </p>
      <p className="font-acumin lk-text-4xs text-[#b45309]">追跡の登録が動いてから使えます</p>
      {error ? (
        <div className="space-y-2">
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {error}
          </p>
          <Button variant="outline" size="2xs" shape="rounded" className="font-acumin" onClick={() => void load()}>
            もう一度読み込む
          </Button>
        </div>
      ) : null}
      {options && manage ? (
        <div className="space-y-3">
          <label className="flex items-center gap-2 font-acumin lk-text-4xs text-black">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            運送会社の受付日との照らし合わせを使う
          </label>
          <Button
            variant="outline"
            size="sm"
            shape="rounded"
            className="font-acumin"
            disabled={saving || enabled === options.carrier_date_check_enabled}
            onClick={() => void save()}
          >
            オプションを保存
          </Button>
        </div>
      ) : null}
      {options && !manage ? (
        <p className="font-acumin lk-text-4xs text-black">{options.carrier_date_check_enabled ? "今はオンです" : "今はオフです"}</p>
      ) : null}
      <NoticeLine notice={notice} onReload={() => void load()} />
    </Section>
  );
}

