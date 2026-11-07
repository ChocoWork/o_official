"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import type { AccountingSettings } from "@/lib/accounting/accounting-types";
import {
  addDays,
  validateNewPeriod,
  type AccountingPeriod,
  type ValidateNewPeriodResult,
} from "@/lib/accounting/period";
import { clientFetch } from "@/lib/client-fetch";
import { ACCOUNTING_TEXT } from "@/lib/accounting/accounting-types";
import { slashDate } from "./filing-deadlines-panel";

// 期間の追加フォーム（FREQ-555-AC-01・AC-08）。個人は年、法人は始まり（成立の日）と終わり（決算日）。
// 送る前に validateNewPeriod で確かめ、DB と同じ境界で止める。

export const CORPORATE_NOTICE =
  "決算月を変えた時は税務署へ遅滞なく届け出てください（法人税法15条）";

const inputClassName =
  "h-10 w-full rounded-md border border-[#d4d4d4] bg-white px-3 font-acumin lk-text-sm text-black focus:border-black focus:outline-none";
const labelClassName = "mb-1 block font-acumin lk-text-4xs text-[#474747]";

type BusinessType = AccountingPeriod["businessType"];

export type AccountingSendResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string };

/**
 * 会計の設定・期間の書き込み（Task 8 の route）。ok でない応答も本文を最後まで読み、
 * route の日本語の本文（error）を返す。読めない本文や通信の失敗は共通の文にする。
 */
export async function sendAccountingJson(
  url: string,
  method: "POST" | "PUT",
  body: Record<string, unknown>,
): Promise<AccountingSendResult> {
  try {
    const response = await clientFetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload: { data?: unknown; error?: unknown } | null = null;
    try {
      payload = JSON.parse(text) as { data?: unknown; error?: unknown };
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return {
        ok: false,
        message:
          typeof payload?.error === "string" ? payload.error : ACCOUNTING_TEXT.failed,
      };
    }
    return { ok: true, data: payload?.data ?? null };
  } catch {
    return { ok: false, message: ACCOUNTING_TEXT.failed };
  }
}

function rejectionText(
  result: Exclude<ValidateNewPeriodResult, { ok: true }>,
  expectedStart: string | null,
): string {
  switch (result.code) {
    case "too_long":
      return "会計の期間は1年を超えられません。";
    case "overlap":
      return "会計の期間が重なっています。";
    case "gap":
      return expectedStart
        ? `前の期間とすき間があります。${slashDate(expectedStart)}から始まる期間にしてください。`
        : "会計の期間にすき間があります。";
    case "sole_not_calendar":
      return "個人の期間は1月1日から12月31日までです。";
    case "bad_range":
      return "終わりの日は始まりの日と同じか後にしてください。";
  }
}

export function PeriodForm({
  periods,
  settings,
  onCreated,
}: {
  periods: readonly AccountingPeriod[];
  settings: AccountingSettings;
  onCreated: () => void;
}) {
  // やめた日を登録した後は、個人の期間をこれより後に作らない（法人の期間だけ）。
  const soleEnded = settings.soleBusinessEndedOn !== null;
  const [chosenType, setChosenType] = useState<BusinessType>(
    settings.currentBusinessType,
  );
  const businessType: BusinessType = soleEnded ? "corporation" : chosenType;
  const [year, setYear] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const sameType = periods.filter((p) => p.businessType === businessType);
  const lastEnd = sameType.reduce<string | null>(
    (max, p) => (max === null || p.endsOn > max ? p.endsOn : max),
    null,
  );
  const expectedStart = lastEnd === null ? null : addDays(lastEnd, 1);
  const isFirstCorporate = businessType === "corporation" && sameType.length === 0;

  const submit = async () => {
    if (submittingRef.current) return;
    const range =
      businessType === "soleProprietor"
        ? /^\d{4}$/.test(year)
          ? { startsOn: `${year}-01-01`, endsOn: `${year}-12-31` }
          : null
        : startsOn && endsOn
          ? { startsOn, endsOn }
          : null;
    if (!range) {
      setMessage(
        businessType === "soleProprietor"
          ? "年を4桁で入れてください。"
          : "始まりと終わりの日を入れてください。",
      );
      return;
    }
    const checked = validateNewPeriod({ businessType, ...range, existing: periods });
    if (!checked.ok) {
      setMessage(rejectionText(checked, expectedStart));
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setMessage(null);
    const result = await sendAccountingJson("/api/admin/accounting/periods", "POST", {
      businessType,
      ...range,
      requestKey: crypto.randomUUID(),
    });
    submittingRef.current = false;
    setSubmitting(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setYear("");
    setStartsOn("");
    setEndsOn("");
    setMessage("期間を追加しました。");
    onCreated();
  };

  return (
    <div className="space-y-3 rounded-sm border border-[#ededed] p-4">
      <h4 className="font-acumin lk-text-xs font-medium tracking-widest text-black">
        期間を追加する
      </h4>
      {soleEnded ? (
        <p className="font-acumin lk-text-4xs text-[#474747]">
          やめた日を登録したので、次は法人の期間を作ります。個人の期間はこれより後に作りません。
        </p>
      ) : (
        <label className="block max-w-xs">
          <span className={labelClassName}>事業の形</span>
          <select
            aria-label="期間の事業の形"
            className={inputClassName}
            value={chosenType}
            onChange={(event) => {
              setChosenType(event.target.value as BusinessType);
              setMessage(null);
            }}
          >
            <option value="soleProprietor">個人</option>
            <option value="corporation">法人</option>
          </select>
        </label>
      )}
      {businessType === "soleProprietor" ? (
        <>
          <p className="font-acumin lk-text-4xs text-[#707070]">
            個人の期間は1月1日から12月31日までです。年の途中で事業をやめた時は、ここで短い期間を作らず「事業をやめた日を登録する」から登録してください。
          </p>
          <label className="block max-w-xs">
            <span className={labelClassName}>年</span>
            <input
              type="number"
              inputMode="numeric"
              min={2000}
              max={2100}
              className={inputClassName}
              value={year}
              onChange={(event) => setYear(event.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <p className="rounded-md border border-[#d4d4d4] px-3 py-2 font-acumin lk-text-4xs text-[#474747]">
            {CORPORATE_NOTICE}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClassName}>
                {isFirstCorporate ? "始まり（成立の日）" : "始まり"}
              </span>
              <input
                type="date"
                className={inputClassName}
                value={startsOn}
                onChange={(event) => setStartsOn(event.target.value)}
              />
            </label>
            <label className="block">
              <span className={labelClassName}>終わり（決算日）</span>
              <input
                type="date"
                className={inputClassName}
                value={endsOn}
                onChange={(event) => setEndsOn(event.target.value)}
              />
            </label>
          </div>
          <p className="font-acumin lk-text-5xs text-[#707070]">
            期間は1年を超えられません。
            {expectedStart
              ? `前の期間に続けて${slashDate(expectedStart)}から始めます。`
              : null}
          </p>
        </>
      )}
      {message ? (
        <p
          role="status"
          className={`font-acumin lk-text-4xs ${message === "期間を追加しました。" ? "text-[#16844b]" : "text-red-700"}`}
        >
          {message}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          shape="rounded"
          className="font-acumin"
          disabled={submitting}
          onClick={() => void submit()}
        >
          {submitting ? "追加中..." : "期間を追加"}
        </Button>
      </div>
    </div>
  );
}
