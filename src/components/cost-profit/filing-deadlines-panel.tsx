import type { ReactNode } from "react";
import {
  rollForwardDeadline,
  type FilingDeadline,
  type InterimFiling,
} from "@/lib/accounting/filing-deadlines";
import { isJpHoliday } from "@/lib/accounting/jp-holidays";
import {
  addDays,
  monthsPeriodEnd,
  parseIsoDate,
  type AccountingPeriod,
} from "@/lib/accounting/period";

// 期間ごとの申告の期限（FREQ-561-AC-02）。期限は Task 5 の filingDeadlines の結果をそのまま描く。

export const slashDate = (date: string) => date.replaceAll("-", "/");

export const HOLIDAY_TABLE_MISSING_TEXT =
  "祝日の表がまだ無いので、休みの日の繰り下げを確かめられません";

const TAX_LABELS: Record<FilingDeadline["tax"], string> = {
  income_tax: "所得税の確定申告",
  consumption_tax_individual: "消費税の確定申告（個人）",
  corporate_tax: "法人税の確定申告",
  consumption_tax_corporate: "消費税の確定申告（法人）",
  local_tax: "法人住民税・事業税の申告",
};

const INTERIM_LABELS: Record<InterimFiling["tax"], string> = {
  corporate_tax: "法人税の中間申告",
  consumption_tax_corporate: "消費税の中間申告",
};

/** 期限の注記（常体の短い文を「。」でつないだもの）を、画面の穏やかな文へ直す。 */
export function politeNote(note: string): string {
  return note
    .split("。")
    .filter((part) => part !== "")
    .map((part) => {
      if (part.endsWith("かかる")) return `${part.slice(0, -2)}かります`;
      if (part.endsWith("要る")) return `${part.slice(0, -2)}要ります`;
      if (part.endsWith("なる")) return `${part.slice(0, -2)}なります`;
      return `${part}です`;
    })
    .join("。");
}

/** 祝日の表が無い年の日か（isJpHoliday が undefined を返す）。 */
export const holidayUnknown = (date: string) => isJpHoliday(date) === undefined;

/** 期首から6か月を過ぎた日（この日が期間の終わり以後なら、期間は6か月以下）。 */
function sixMonthsEndOf(period: AccountingPeriod): string {
  return monthsPeriodEnd(addDays(period.startsOn, -1), 6);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[#ededed] py-2 font-acumin lk-text-4xs text-black last:border-b-0">
      <span className="min-w-[12em] text-[#474747]">{label}</span>
      <span className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
        {children}
      </span>
    </li>
  );
}

const Muted = ({ children }: { children: ReactNode }) => (
  <span className="text-[#707070]">{children}</span>
);

export function FilingDeadlinesPanel({
  period,
  deadlines,
  interim,
  firstCorporateDue,
  soleEndedOn,
  children,
}: {
  period: AccountingPeriod;
  deadlines: readonly FilingDeadline[];
  interim: readonly InterimFiling[];
  /** 法人の第1期の法人税の申告の期限（定額法を選ぶ届け出の期限。法人税法施行令51条2項）。 */
  firstCorporateDue: string | null;
  /** 登録済みのやめた日。この期間に入っていれば、所得税の年分・帳簿の期間・消費税の課税期間を分けて見せる。 */
  soleEndedOn: string | null;
  /** 期間の申告の設定のフォーム（権限のある人だけ）。 */
  children?: ReactNode;
}) {
  const hasConsumption = deadlines.some(
    (deadline) =>
      deadline.tax === "consumption_tax_individual" ||
      deadline.tax === "consumption_tax_corporate",
  );
  const isFinalSole =
    period.businessType === "soleProprietor" &&
    soleEndedOn !== null &&
    period.startsOn <= soleEndedOn &&
    soleEndedOn <= period.endsOn;
  const year = parseIsoDate(period.startsOn).year;
  const shortTerm = period.endsOn <= sixMonthsEndOf(period);
  const interimReferenceDue = rollForwardDeadline(
    monthsPeriodEnd(sixMonthsEndOf(period), 2),
    isJpHoliday,
  ).due;

  return (
    <div
      role="group"
      aria-label={`${period.name}の申告の期限`}
      className="rounded-sm border border-[#ededed] p-4"
    >
      <h4 className="mb-2 font-acumin lk-text-xs font-medium tracking-widest text-black">
        {period.name}
        <span className="ml-2 font-normal text-[#707070] tabular-nums">
          {slashDate(period.startsOn)}〜{slashDate(period.endsOn)}
        </span>
      </h4>
      <ul>
        {isFinalSole ? (
          <>
            <Row label="所得税の年分">
              {`${year}/01/01〜${year}/12/31`}
            </Row>
            <Row label="帳簿の期間">
              {`${slashDate(period.startsOn)}〜${slashDate(period.endsOn)}`}
            </Row>
            <Row label="消費税の課税期間">
              {`${year}/01/01〜${year}/12/31`}
            </Row>
          </>
        ) : null}
        {deadlines.map((deadline) => (
          <Row key={deadline.tax} label={TAX_LABELS[deadline.tax]}>
            <span>{slashDate(deadline.due)}</span>
            {deadline.rolled ? (
              <Muted>元の期限 {slashDate(deadline.baseDue)}</Muted>
            ) : null}
            {deadline.note !== "" ? (
              <Muted>{politeNote(deadline.note)}</Muted>
            ) : null}
            {deadline.holidayTableMissing ? (
              <Muted>{HOLIDAY_TABLE_MISSING_TEXT}</Muted>
            ) : null}
          </Row>
        ))}
        {!hasConsumption ? (
          <Row label="消費税の確定申告">
            <span>課税事業者になったら出します</span>
          </Row>
        ) : null}
        {interim.map((filing) => {
          // 法人税の中間申告は期間が6か月を超える時だけ要る（法人税法71条1項）。
          const notNeededShort =
            filing.tax === "corporate_tax" &&
            filing.reason === "prior_tax_unknown" &&
            shortTerm;
          const due = filing.dueOn ?? interimReferenceDue;
          return (
            <Row key={filing.tax} label={INTERIM_LABELS[filing.tax]}>
              {filing.reason === "first_term" ? (
                <>
                  <span>前の期が無いため不要</span>
                  <Muted>期限の目安 {slashDate(due)}</Muted>
                </>
              ) : notNeededShort ? (
                <span>期間が6か月以下のため不要</span>
              ) : (
                <>
                  <span>前の期の税額が入るまで判定できません</span>
                  <Muted>期限 {slashDate(due)}</Muted>
                </>
              )}
              {!notNeededShort && holidayUnknown(due) ? (
                <Muted>{HOLIDAY_TABLE_MISSING_TEXT}</Muted>
              ) : null}
            </Row>
          );
        })}
        {period.businessType === "corporation" && firstCorporateDue ? (
          <Row label="減価償却で定額法を選ぶ届け出">
            <span>{slashDate(firstCorporateDue)}（第1期の申告の期限）</span>
          </Row>
        ) : null}
      </ul>
      {children}
    </div>
  );
}
