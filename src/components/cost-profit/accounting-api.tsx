"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { clientFetch } from "@/lib/client-fetch";
import { ACCOUNTING_TEXT } from "@/lib/accounting/accounting-types";
import { toJstDate } from "@/lib/accounting/jst-date";

// 計画2の画面（計上待ち・照合・支払いの取り消し・年末の出荷）が、Task 10 の route を読む共通の入口。
// 読みは no-store で本文を最後まで読み、ok でない応答も本文を読み切って route の日本語の本文（error）を返す。
// 書き込みは period-form の sendAccountingJson を使う。

export type ViewPermissions = {
  /** admin.accounting.settings.manage */
  manageSettings: boolean;
  /** admin.finance.manage（計上係・補充・請求書・年末の印） */
  manageFinance: boolean;
  /** admin.accounting.entries.correct（計上待ちの確認済み・取り消しの振り替え） */
  correctEntries: boolean;
};

export const NO_PERMISSIONS: ViewPermissions = {
  manageSettings: false,
  manageFinance: false,
  correctEntries: false,
};

export type AccountingReadResult<T> =
  | { ok: true; data: T; permissions: ViewPermissions }
  | { ok: false; message: string; code: string | null };

/** 続きの目印が古い時に route が返す固定のコード（一覧を最初から読み直す）。 */
export const LIST_RESTART_CODE = "ACCOUNTING_LIST_RESTART";

const ACCOUNTING_BASE = "/api/admin/accounting";

/** 閲覧者の権限は、route が持つ時だけ true で付ける旗を読む（無ければ false）。 */
function permissionsFrom(value: unknown): ViewPermissions {
  const flags =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    manageSettings: flags.manageSettings === true,
    manageFinance: flags.manageFinance === true,
    correctEntries: flags.correctEntries === true,
  };
}

/** `/api/admin/accounting/<path>` を読む。params の undefined は付けない。 */
export async function getAccountingData<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  /** 答えの形の検査。形が違えば、読み違いとして固定の失敗にする。 */
  isShape?: (data: unknown) => boolean,
): Promise<AccountingReadResult<T>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const url = `${ACCOUNTING_BASE}/${path}${query.size > 0 ? `?${query.toString()}` : ""}`;
  try {
    const response = await clientFetch(url, { cache: "no-store" });
    const text = await response.text();
    let payload: {
      data?: unknown;
      permissions?: unknown;
      error?: unknown;
      code?: unknown;
    } | null = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (
      !response.ok ||
      payload === null ||
      payload.data === undefined ||
      (isShape !== undefined && !isShape(payload.data))
    ) {
      return {
        ok: false,
        message:
          typeof payload?.error === "string" ? payload.error : ACCOUNTING_TEXT.failed,
        code: typeof payload?.code === "string" ? payload.code : null,
      };
    }
    return {
      ok: true,
      data: payload.data as T,
      permissions: permissionsFrom(payload.permissions),
    };
  } catch {
    return { ok: false, message: ACCOUNTING_TEXT.failed, code: null };
  }
}

export const accountingUrl = (path: string): string => `${ACCOUNTING_BASE}/${path}`;

/** 権限だけが要る画面のために、設定の読み口から旗を読む。読めるまでは permissions が null、読めなければ error に固定の文。 */
export function useAccountingPermissions(): { permissions: ViewPermissions | null; error: string | null } {
  const [state, setState] = useState<{ permissions: ViewPermissions | null; error: string | null }>({
    permissions: null,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getAccountingData<unknown>("settings");
      if (cancelled) return;
      setState(
        result.ok
          ? { permissions: result.permissions, error: null }
          : { permissions: null, error: result.message },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/**
 * 読みの順番札。読み始める時に next() で札を取り、答えが来たら isCurrent(札) が偽なら捨てる
 * （日や期間を切り替えた後に、古い答えで上書きしたり追記したりしない）。
 */
export function useTicket(): { next: () => number; isCurrent: (ticket: number) => boolean } {
  const [ticket] = useState(() => {
    let latest = 0;
    return {
      next: () => ++latest,
      isCurrent: (value: number) => value === latest,
    };
  });
  return ticket;
}

export const inputClassName =
  "h-10 w-full rounded-md border border-[#d4d4d4] bg-white px-3 font-acumin lk-text-sm text-black focus:border-black focus:outline-none read-only:bg-[#f5f5f5] read-only:text-[#474747]";
export const labelClassName = "mb-1 block font-acumin lk-text-4xs text-[#474747]";
export const noteClassName = "font-acumin lk-text-4xs text-[#707070]";
export const sectionClassName =
  "space-y-4 rounded-md border border-[#d4d4d4] bg-white p-4 sm:p-5";
export const headingClassName =
  "font-acumin lk-text-sm font-medium tracking-widest text-black";
export const tableClassName =
  "w-full border-collapse font-acumin lk-text-4xs text-black";

/** 名前つきの区画（region）。見出しと区画の名前を同じ文にする。 */
export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={sectionClassName}>
      <h3 id={id} className={headingClassName}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 出来事の種類の呼び名（計上待ち・照合・出荷の跡で使う）。知らない種類は「仕訳」。 */
const EVENT_KIND_LABELS: Readonly<Record<string, string>> = {
  payment_confirmed: "支払い",
  shipment_confirmed: "出荷",
  shipment_redated: "出荷日を直した仕訳",
  pre_shipment_refund: "出荷前の返金",
  return_arrived: "返品の到着",
  return_amount_decided: "返品の額の決定",
  return_refund: "返品の返金",
  refund_failed: "返金の失敗",
  refund_abandoned: "返金の取りやめ",
  stripe_fee: "Stripe の手数料",
  stripe_tax_adjustment: "Stripe の税額の調整",
  payout_started: "入金の開始",
  bank_arrived: "銀行への着金",
  payout_failed: "入金の失敗",
  balance_topup: "残高の補充",
  dispute_event: "支払いの取り消し",
  dispute_withdrawn_late: "遅れた取り下げ",
  manual_entry: "手入力の仕訳",
  migrated_entry: "移した仕訳",
  reversal: "取り消し",
};

export const eventKindLabel = (kind: string): string => EVENT_KIND_LABELS[kind] ?? "仕訳";

/** 日時を日本時間の日（スラッシュ区切り）にする。読めなければ「-」。 */
export function jstDayLabel(instant: string): string {
  try {
    return toJstDate(instant).replaceAll("-", "/");
  } catch {
    return "-";
  }
}

/** `YYYY-MM-DD` をスラッシュ区切りにする。空は「-」。 */
export const dayLabel = (date: string | null | undefined): string =>
  date ? date.replaceAll("-", "/") : "-";

/** 日本時間の今日。 */
export const todayJst = (): string => toJstDate(new Date());

/** 答えの形の検査に使う小さな道具。 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const hasArray = (value: unknown, key: string): boolean =>
  isRecord(value) && Array.isArray(value[key]);
