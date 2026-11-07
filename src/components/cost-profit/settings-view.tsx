"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button/Button";
import { clientFetch } from "@/lib/client-fetch";
import {
  ACCOUNTING_TEXT,
  type AccountingPeriodsData,
} from "@/lib/accounting/accounting-types";
import { toJstDate } from "@/lib/accounting/jst-date";
import {
  addMonthsClamped,
  parseIsoDate,
  type AccountingPeriod,
} from "@/lib/accounting/period";
import type { StartupDeadline } from "@/lib/accounting/startup-deadlines";
import {
  FilingDeadlinesPanel,
  HOLIDAY_TABLE_MISSING_TEXT,
  holidayUnknown,
  politeNote,
  slashDate,
} from "./filing-deadlines-panel";
import {
  errorNotice,
  failureNotice,
  NoticeLine,
  PeriodForm,
  sendAccountingJson,
  successNotice,
  type AccountingSendResult,
  type Notice,
} from "./period-form";

// 設定・期間のタブ（FREQ-555・561）。開業日と事業の形、期間の一覧と追加、期間ごとの申告の期限、
// 開業日からの届け出の期限、個人の最後の期間のやめた日の登録。
// 追加・更新のボタンは admin.accounting.settings.manage の人だけに出し、ほかの人は読み取りだけにする。

const PERIODS_URL = "/api/admin/accounting/periods";
const SETTINGS_URL = "/api/admin/accounting/settings";
/** 開業日に選べる最も前の日（route の検査と同じ範囲を画面にも出す）。 */
const MIN_BUSINESS_START = "2000-01-01";

export const SOLE_END_ALWAYS_NOTICE =
  "事業をやめたら、年が変わる前、かつ事業の形を法人へ変える前に、やめた日を登録してください。翌年の個人の期間が先にできると登録できません";

const BUSINESS_TYPE_LABELS: Record<AccountingPeriod["businessType"], string> = {
  soleProprietor: "個人",
  corporation: "法人",
};

const STARTUP_LABELS: Record<StartupDeadline["kind"], string> = {
  business_start_notice: "開業の届け出",
  blue_return_approval: "青色申告の承認の申請",
  inventory_method_notice: "棚卸資産の評価の方法の届け出",
  inventory_method_change: "棚卸資産の評価の方法の変更の承認の申請",
};

const inputClassName =
  "h-10 w-full rounded-md border border-[#d4d4d4] bg-white px-3 font-acumin lk-text-sm text-black focus:border-black focus:outline-none read-only:bg-[#f5f5f5] read-only:text-[#474747]";
const labelClassName = "mb-1 block font-acumin lk-text-4xs text-[#474747]";
const noteClassName = "font-acumin lk-text-4xs text-[#707070]";

type LoadedData = AccountingPeriodsData & { manageSettings: boolean };

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="space-y-4 rounded-md border border-[#d4d4d4] bg-white p-4 sm:p-5"
    >
      <h3
        id={id}
        className="font-acumin lk-text-sm font-medium tracking-widest text-black"
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 期間の申告の設定（課税事業者か免税事業者か・課税事業者になった日・法人の延長）。権限のある人だけ。 */
function FilingForm({
  period,
  onSaved,
  guard,
  notice,
  onNotice,
  onReload,
}: {
  period: AccountingPeriod;
  onSaved: () => Promise<void>;
  guard: { current: boolean };
  /** 知らせは親が持つ（保存の後に版が変わって作り直されても、成功の文を残す）。 */
  notice: Notice | null;
  onNotice: (notice: Notice | null) => void;
  onReload: () => void;
}) {
  const [status, setStatus] = useState(period.consumptionTaxStatus);
  const [taxableFrom, setTaxableFrom] = useState(
    period.consumptionTaxableFrom ?? "",
  );
  const [corporateExtension, setCorporateExtension] = useState(
    period.corporateTaxExtensionMonths,
  );
  const [consumptionExtension, setConsumptionExtension] = useState(
    period.consumptionTaxExtensionMonths,
  );
  const [saving, setSaving] = useState(false);
  const isCorporation = period.businessType === "corporation";

  const save = async () => {
    if (guard.current) return;
    if (status === "taxable" && !taxableFrom) {
      onNotice(errorNotice("課税事業者になった日を入れてください。"));
      return;
    }
    guard.current = true;
    setSaving(true);
    onNotice(null);
    const result = await sendAccountingJson(
      `${PERIODS_URL}/${period.id}/filing`,
      "PUT",
      {
        corporateTaxExtensionMonths: isCorporation ? corporateExtension : 0,
        consumptionTaxExtensionMonths:
          isCorporation && corporateExtension === 1 ? consumptionExtension : 0,
        consumptionTaxStatus: status,
        consumptionTaxableFrom: status === "taxable" ? taxableFrom : null,
        expectedVersion: period.version,
        requestKey: crypto.randomUUID(),
      },
    );
    if (result.ok) await onSaved();
    guard.current = false;
    setSaving(false);
    onNotice(result.ok ? successNotice("申告の設定を保存しました。") : failureNotice(result));
  };

  return (
    <div className="mt-3 space-y-3 border-t border-[#ededed] pt-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClassName}>消費税</span>
          <select
            className={inputClassName}
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as AccountingPeriod["consumptionTaxStatus"])
            }
          >
            <option value="exempt">免税事業者</option>
            <option value="taxable">課税事業者</option>
          </select>
        </label>
        {status === "taxable" ? (
          <label className="block">
            <span className={labelClassName}>課税事業者になった日</span>
            <input
              type="date"
              className={inputClassName}
              value={taxableFrom}
              onChange={(event) => setTaxableFrom(event.target.value)}
            />
          </label>
        ) : null}
      </div>
      {isCorporation ? (
        <div className="space-y-2">
          <label className="flex items-center gap-2 font-acumin lk-text-4xs text-black">
            <input
              type="checkbox"
              checked={corporateExtension === 1}
              onChange={(event) =>
                setCorporateExtension(event.target.checked ? 1 : 0)
              }
            />
            法人税の申告の期限を1か月延ばす
          </label>
          <label className="flex items-center gap-2 font-acumin lk-text-4xs text-black">
            <input
              type="checkbox"
              checked={corporateExtension === 1 && consumptionExtension === 1}
              disabled={corporateExtension !== 1}
              onChange={(event) =>
                setConsumptionExtension(event.target.checked ? 1 : 0)
              }
            />
            消費税の申告の期限も1か月延ばす（法人税を延ばした時だけ）
          </label>
        </div>
      ) : null}
      <NoticeLine notice={notice} onReload={onReload} />
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          shape="rounded"
          className="font-acumin"
          disabled={saving}
          onClick={() => void save()}
        >
          申告の設定を保存
        </Button>
      </div>
    </div>
  );
}

export function SettingsView({
  onChanged,
  today: todayProp,
}: {
  /** 書き込みが済んだ後に呼ぶ（会計の画面の期間・月割りを読み直す）。 */
  onChanged?: () => void;
  /** 日本時間の今日（試験用）。 */
  today?: string;
}) {
  const today = todayProp ?? toJstDate(new Date());
  const maxBusinessStart = addMonthsClamped(today, 12);
  const [data, setData] = useState<LoadedData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 書き込みは1つずつ。押した直後の2回目を止める。
  const busy = useRef(false);

  const [startInput, setStartInput] = useState("");
  const [startNotice, setStartNotice] = useState<Notice | null>(null);
  const [savingStart, setSavingStart] = useState(false);

  const [typeChoice, setTypeChoice] = useState<AccountingPeriod["businessType"] | null>(null);
  const [endConfirmed, setEndConfirmed] = useState(false);
  const [typeNotice, setTypeNotice] = useState<Notice | null>(null);
  const [savingType, setSavingType] = useState(false);

  const [soleFormOpen, setSoleFormOpen] = useState(false);
  const [endedInput, setEndedInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const [soleNotice, setSoleNotice] = useState<Notice | null>(null);
  const [filingNotices, setFilingNotices] = useState<Record<string, Notice | null>>({});
  const [savingSole, setSavingSole] = useState(false);
  const endedInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await clientFetch(PERIODS_URL, { cache: "no-store" });
      // ok でない応答も本文を最後まで読む。
      const text = await response.text();
      let payload: {
        data?: AccountingPeriodsData;
        permissions?: { manageSettings?: unknown };
        error?: unknown;
      } | null = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      if (!response.ok || !payload?.data) {
        setLoadError(
          typeof payload?.error === "string" ? payload.error : ACCOUNTING_TEXT.failed,
        );
        return;
      }
      setLoadError(null);
      setData({
        ...payload.data,
        manageSettings: payload.permissions?.manageSettings === true,
      });
    } catch {
      setLoadError(ACCOUNTING_TEXT.failed);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (soleFormOpen) endedInputRef.current?.focus();
  }, [soleFormOpen]);

  if (!data) {
    return (
      <div className="space-y-3">
        {loadError ? (
          <>
            <p role="alert" className="font-acumin lk-text-3xs text-red-700">
              {loadError}
            </p>
            <Button
              variant="outline"
              size="sm"
              shape="rounded"
              className="font-acumin"
              onClick={() => void load()}
            >
              もう一度読み込む
            </Button>
          </>
        ) : (
          <p role="status" className={noteClassName}>
            読み込み中
          </p>
        )}
      </div>
    );
  }

  const { periods, settings, deadlines, interim, startup, manageSettings } = data;
  const sorted = [...periods].sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1));
  const soleLast = sorted.filter((p) => p.businessType === "soleProprietor").at(-1) ?? null;
  const firstCorporate = sorted.find(
    (p) => p.businessType === "corporation" && p.name === "第1期",
  );
  const firstCorporateDue =
    (firstCorporate &&
      deadlines[firstCorporate.id]?.find((d) => d.tax === "corporate_tax")?.due) ??
    null;
  const endedOn = settings.soleBusinessEndedOn;
  const chosenType = typeChoice ?? settings.currentBusinessType;
  const toCorporation =
    settings.currentBusinessType === "soleProprietor" && chosenType === "corporation";

  /** 版の衝突の後に、知らせを消して読み直す。 */
  const reload = () => {
    setStartNotice(null);
    setTypeNotice(null);
    setSoleNotice(null);
    setFilingNotices({});
    void load();
  };

  /** 書き込みの後は、期間・期限・設定の版を読み直し、会計の画面にも知らせる。 */
  const afterWrite = async () => {
    await load();
    onChanged?.();
  };

  const run = async (
    setSaving: (value: boolean) => void,
    send: () => Promise<AccountingSendResult>,
    onDone: (result: AccountingSendResult) => void,
  ) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    const result = await send();
    if (result.ok) await afterWrite();
    busy.current = false;
    setSaving(false);
    onDone(result);
  };

  const saveBusinessStart = () => {
    if (!startInput) {
      setStartNotice(errorNotice("開業日を入れてください。"));
      return;
    }
    if (startInput < MIN_BUSINESS_START || startInput > maxBusinessStart) {
      setStartNotice(errorNotice("選べる日の範囲で入れてください"));
      return;
    }
    setStartNotice(null);
    void run(
      setSavingStart,
      () =>
        sendAccountingJson(SETTINGS_URL, "PUT", {
          businessStartDate: startInput,
          currentBusinessType: settings.currentBusinessType,
          expectedVersion: settings.version,
          requestKey: crypto.randomUUID(),
        }),
      (result) =>
        setStartNotice(result.ok ? successNotice("開業日を保存しました。") : failureNotice(result)),
    );
  };

  const saveBusinessType = () => {
    setTypeNotice(null);
    void run(
      setSavingType,
      () =>
        sendAccountingJson(SETTINGS_URL, "PUT", {
          businessStartDate: settings.businessStartDate,
          currentBusinessType: chosenType,
          expectedVersion: settings.version,
          requestKey: crypto.randomUUID(),
        }),
      (result) => {
        if (result.ok) {
          setTypeChoice(null);
          setEndConfirmed(false);
        }
        setTypeNotice(result.ok ? successNotice("事業の形を変えました。") : failureNotice(result));
      },
    );
  };

  const rechoosing = endedOn !== null;
  const saveSoleEnd = () => {
    if (!soleLast) return;
    const lastDay = `${parseIsoDate(soleLast.startsOn).year}-12-31`;
    if (!endedInput || endedInput < soleLast.startsOn || endedInput > lastDay) {
      setSoleNotice(
        errorNotice(
        `やめた日は${slashDate(soleLast.startsOn)}から${slashDate(lastDay)}までの日にしてください。`,
        ),
      );
      return;
    }
    setSoleNotice(null);
    void run(
      setSavingSole,
      () =>
        sendAccountingJson(`${PERIODS_URL}/${soleLast.id}/final-sole`, "POST", {
          endedOn: endedInput,
          expectedPeriodVersion: soleLast.version,
          expectedSettingsVersion: settings.version,
          reason: rechoosing ? reasonInput.trim() : null,
          requestKey: crypto.randomUUID(),
        }),
      (result) => {
        if (result.ok) {
          setSoleFormOpen(false);
          setEndedInput("");
          setReasonInput("");
          setSoleNotice(
            successNotice(rechoosing ? "やめた日を選び直しました。" : "やめた日を登録しました。"),
          );
        } else {
          setSoleNotice(failureNotice(result));
        }
      },
    );
  };

  const openSoleForm = () => {
    setSoleFormOpen(true);
    setSoleNotice(null);
  };

  return (
    <div className="space-y-5">
      {loadError ? (
        <p role="alert" className="font-acumin lk-text-3xs text-red-700">
          {loadError}
        </p>
      ) : null}

      <Section title="開業日と事業の形">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="space-y-2">
            {settings.businessStartDate !== null ? (
              <>
                <label className="block max-w-xs">
                  <span className={labelClassName}>開業日</span>
                  <input
                    type="date"
                    readOnly
                    className={inputClassName}
                    value={settings.businessStartDate}
                  />
                </label>
                <p className={noteClassName}>開業日は選び直せません</p>
                <NoticeLine notice={startNotice} onReload={reload} />
              </>
            ) : manageSettings ? (
              <>
                <label className="block max-w-xs">
                  <span className={labelClassName}>開業日</span>
                  <input
                    type="date"
                    min={MIN_BUSINESS_START}
                    max={maxBusinessStart}
                    className={inputClassName}
                    value={startInput}
                    onChange={(event) => setStartInput(event.target.value)}
                  />
                </label>
                <p className="font-acumin lk-text-4xs text-[#474747]">
                  一度入れると選び直せません
                </p>
                <p className={noteClassName}>
                  {`選べる日: ${slashDate(MIN_BUSINESS_START)}〜${slashDate(maxBusinessStart)}`}
                </p>
                <NoticeLine notice={startNotice} onReload={reload} />
                <Button
                  variant="primary"
                  size="sm"
                  shape="rounded"
                  className="font-acumin"
                  disabled={savingStart}
                  onClick={saveBusinessStart}
                >
                  開業日を保存
                </Button>
              </>
            ) : (
              <p className="font-acumin lk-text-4xs text-black">開業日: 未入力</p>
            )}
          </div>

          <div className="space-y-2">
            <p className="font-acumin lk-text-4xs text-black">
              {`今の事業の形: ${BUSINESS_TYPE_LABELS[settings.currentBusinessType]}`}
            </p>
            {manageSettings ? (
              <>
                <label className="block max-w-xs">
                  <span className={labelClassName}>新しい事業の形</span>
                  <select
                    className={inputClassName}
                    value={chosenType}
                    onChange={(event) => {
                      setTypeChoice(event.target.value as AccountingPeriod["businessType"]);
                      setEndConfirmed(false);
                      setTypeNotice(null);
                    }}
                  >
                    <option value="soleProprietor">個人</option>
                    <option value="corporation">法人</option>
                  </select>
                </label>
                {toCorporation ? (
                  endedOn === null ? (
                    <div className="space-y-2 rounded-md border border-[#d4d4d4] px-3 py-2">
                      <p className="font-acumin lk-text-4xs text-[#474747]">
                        先にやめた日を登録してください
                      </p>
                      <Button
                        variant="outline"
                        size="2xs"
                        shape="rounded"
                        className="font-acumin"
                        onClick={openSoleForm}
                      >
                        やめた日の登録へ
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2 rounded-md border border-[#d4d4d4] px-3 py-2">
                      <p className="font-acumin lk-text-4xs text-black">
                        {`やめた日: ${slashDate(endedOn)}`}
                      </p>
                      <p className="font-acumin lk-text-4xs text-[#474747]">
                        やめた日が正しいか確かめてから切り替えてください。切り替えた後に日を選び直しても、それまでに法人の期間へ入った取引は動きません
                      </p>
                      <label className="flex items-center gap-2 font-acumin lk-text-4xs text-black">
                        <input
                          type="checkbox"
                          checked={endConfirmed}
                          onChange={(event) => setEndConfirmed(event.target.checked)}
                        />
                        やめた日を確かめました
                      </label>
                    </div>
                  )
                ) : null}
                <NoticeLine notice={typeNotice} onReload={reload} />
                <Button
                  variant="outline"
                  size="sm"
                  shape="rounded"
                  className="font-acumin"
                  disabled={
                    savingType ||
                    chosenType === settings.currentBusinessType ||
                    (toCorporation && (endedOn === null || !endConfirmed))
                  }
                  onClick={saveBusinessType}
                >
                  事業の形を変える
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </Section>

      <Section title="期間">
        {sorted.length === 0 ? (
          <p className={noteClassName}>期間がまだありません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse font-acumin lk-text-4xs text-black">
              <thead>
                <tr className="border-b border-[#d4d4d4] text-left text-[#474747]">
                  <th scope="col" className="py-2 pr-3 font-normal">名前</th>
                  <th scope="col" className="py-2 pr-3 font-normal">始まり</th>
                  <th scope="col" className="py-2 pr-3 font-normal">終わり</th>
                  <th scope="col" className="py-2 font-normal">事業の形</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((period) => (
                  <tr key={period.id} className="border-b border-[#ededed] tabular-nums">
                    <td className="py-2 pr-3">{period.name}</td>
                    <td className="py-2 pr-3">{slashDate(period.startsOn)}</td>
                    <td className="py-2 pr-3">{slashDate(period.endsOn)}</td>
                    <td className="py-2">{BUSINESS_TYPE_LABELS[period.businessType]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {manageSettings ? (
          <PeriodForm
            key={settings.currentBusinessType}
            periods={periods}
            settings={settings}
            onCreated={() => void afterWrite()}
          />
        ) : null}
      </Section>

      <Section title="申告の期限">
        {sorted.length === 0 ? (
          <p className={noteClassName}>期間を作ると、申告の期限を出します。</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {sorted.map((period) => (
              <FilingDeadlinesPanel
                key={period.id}
                period={period}
                deadlines={deadlines[period.id] ?? []}
                interim={interim[period.id] ?? []}
                firstCorporateDue={firstCorporateDue}
                soleEndedOn={endedOn}
              >
                {manageSettings ? (
                  <FilingForm
                    key={period.version}
                    period={period}
                    guard={busy}
                    onSaved={afterWrite}
                    notice={filingNotices[period.id] ?? null}
                    onNotice={(notice) =>
                      setFilingNotices((current) => ({ ...current, [period.id]: notice }))
                    }
                    onReload={reload}
                  />
                ) : null}
              </FilingDeadlinesPanel>
            ))}
          </div>
        )}
      </Section>

      <Section title="開業日からの届け出">
        {startup.length === 0 ? (
          <p className={noteClassName}>開業日を入れると、届け出の期限を出します。</p>
        ) : (
          <ul>
            {startup.map((item) => (
              <li
                key={item.kind}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[#ededed] py-2 font-acumin lk-text-4xs text-black last:border-b-0"
              >
                <span className="min-w-[12em] text-[#474747]">{STARTUP_LABELS[item.kind]}</span>
                <span className="tabular-nums">{slashDate(item.dueOn)}</span>
                {item.passed ? (
                  <span className="text-[#b45309]">
                    期限を過ぎました
                    {item.consequence ? `。${politeNote(item.consequence)}` : ""}
                  </span>
                ) : null}
                {holidayUnknown(item.dueOn) ? (
                  <span className="text-[#707070]">{HOLIDAY_TABLE_MISSING_TEXT}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {soleLast ? (
        <Section title="事業をやめた日">
          <p className="rounded-md border border-[#d4d4d4] px-3 py-2 font-acumin lk-text-4xs text-[#474747]">
            {SOLE_END_ALWAYS_NOTICE}
          </p>
          <p className="font-acumin lk-text-4xs text-black">
            {`${soleLast.name}のやめた日: ${endedOn ? slashDate(endedOn) : "未登録"}`}
          </p>
          {endedOn !== null && settings.currentBusinessType === "soleProprietor" ? (
            <p className={noteClassName}>
              やめた日より後の取引は、事業の形を法人へ切り替えるまで止まります。法人の期間へ黙って入ることはありません。
            </p>
          ) : null}
          {manageSettings ? (
            <Button
              variant="outline"
              size="sm"
              shape="rounded"
              className="font-acumin"
              aria-expanded={soleFormOpen}
              onClick={() => (soleFormOpen ? setSoleFormOpen(false) : openSoleForm())}
            >
              {rechoosing ? "やめた日を選び直す" : "事業をやめた日を登録する"}
            </Button>
          ) : null}
          {manageSettings && soleFormOpen ? (
            <div className="space-y-3 rounded-sm border border-[#ededed] p-4">
              <p className="font-acumin lk-text-4xs text-black tabular-nums">
                {`今の終わり: ${slashDate(soleLast.endsOn)}`}
              </p>
              {rechoosing && endedOn ? (
                <p className="font-acumin lk-text-4xs text-black tabular-nums">
                  {`前のやめた日: ${slashDate(endedOn)}`}
                </p>
              ) : null}
              <label className="block max-w-xs">
                <span className={labelClassName}>やめた日</span>
                <input
                  ref={endedInputRef}
                  type="date"
                  min={soleLast.startsOn}
                  max={`${parseIsoDate(soleLast.startsOn).year}-12-31`}
                  className={inputClassName}
                  value={endedInput}
                  onChange={(event) => setEndedInput(event.target.value)}
                />
              </label>
              {endedInput ? (
                <p className="font-acumin lk-text-4xs text-black tabular-nums">
                  {`新しい終わり: ${slashDate(endedInput)}`}
                </p>
              ) : null}
              <p className={noteClassName}>短くすると、減価償却などはその月までの月割りになります。</p>
              <p className={noteClassName}>やめた日より後の日付の仕訳があれば、先に取引の日付と期間を確かめてください。</p>
              {rechoosing ? (
                <>
                  <p className={noteClassName}>
                    縮める時は、新しいやめた日より後の日付の仕訳が無いことを確かめてください。延ばす時は同じ年の12月31日まで選べます。
                  </p>
                  <label className="block">
                    <span className={labelClassName}>選び直す理由</span>
                    <textarea
                      maxLength={500}
                      className={`${inputClassName} h-20 py-2`}
                      value={reasonInput}
                      onChange={(event) => setReasonInput(event.target.value)}
                    />
                  </label>
                </>
              ) : null}
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  shape="rounded"
                  className="font-acumin"
                  disabled={
                    savingSole || !endedInput || (rechoosing && reasonInput.trim() === "")
                  }
                  onClick={saveSoleEnd}
                >
                  {rechoosing ? "選び直しを保存" : "登録する"}
                </Button>
              </div>
            </div>
          ) : null}
          <NoticeLine notice={soleNotice} onReload={reload} />
          {settings.soleEndChanges.length > 0 ? (
            <div className="space-y-1">
              <p className={labelClassName}>選び直しの記録</p>
              <ul aria-label="選び直しの記録" className="space-y-1">
                {settings.soleEndChanges.map((change) => (
                  <li
                    key={`${change.changedAt}-${change.newEndedOn}`}
                    className="font-acumin lk-text-4xs text-black tabular-nums"
                  >
                    {`${change.previousEndedOn ? slashDate(change.previousEndedOn) : "なし"} → ${slashDate(change.newEndedOn)}（${change.reason}） ${slashDate(toJstDate(change.changedAt))}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}
