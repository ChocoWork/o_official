import {
  accountByCode,
  type BusinessType,
} from "@/lib/finance/accounts";
import {
  buildJournal,
  type FinanceEntry,
} from "@/lib/finance/journal";

const FUNDING_ACCOUNT_CODES = new Set(["2110", "2120", "2510", "2520", "2920"]);
const PAYABLE_ACCOUNT_CODES = new Set([
  "2010",
  "2020",
  "2030",
  "2130",
  "2140",
  "2160",
  "2170",
  "2210",
  "2220",
  "2540",
]);
const OWNER_FUNDING_ACCOUNT_CODE = "2920";
const MISSING_COUNTERPARTY = "相手先未設定";
const UNATTRIBUTED_OPENING = "繰越・相手先未設定";

export type CounterpartyBalanceRow = {
  counterparty: string;
  accountCode: string;
  accountName: string;
  received: number;
  settled: number;
  balance: number;
  lastActivityDate: string | null;
  ownerFunding: boolean;
  unattributedOpening: boolean;
};

export type CounterpartyBalanceSection = {
  rows: CounterpartyBalanceRow[];
  totals: {
    received: number;
    settled: number;
    balance: number;
  };
};

export type CounterpartyBalanceSummary = {
  funding: CounterpartyBalanceSection;
  payables: CounterpartyBalanceSection;
};

type MutableRow = CounterpartyBalanceRow;

function emptySection(): CounterpartyBalanceSection {
  return {
    rows: [],
    totals: { received: 0, settled: 0, balance: 0 },
  };
}

function sectionForAccount(code: string): "funding" | "payables" | null {
  if (FUNDING_ACCOUNT_CODES.has(code)) return "funding";
  if (PAYABLE_ACCOUNT_CODES.has(code)) return "payables";
  return null;
}

function rowKey(counterparty: string, accountCode: string): string {
  return `${accountCode}\u0000${counterparty}`;
}

function totalsOf(rows: readonly CounterpartyBalanceRow[]) {
  return rows.reduce(
    (totals, row) => ({
      received: totals.received + row.received,
      settled: totals.settled + row.settled,
      balance: totals.balance + row.balance,
    }),
    { received: 0, settled: 0, balance: 0 },
  );
}

/**
 * 記録開始から対象日までの仕訳を相手先・対象科目別に集計する。
 * 借入・事業主資金は受入累計から返済・引出済みを差し引き、
 * その他の支払債務だけを総勘定元帳の正式残高へ科目単位で照合する。
 */
export function buildCounterpartyBalances(
  entries: readonly FinanceEntry[],
  businessType: BusinessType,
  throughDate: string,
  officialBalances: ReadonlyMap<string, number>,
): CounterpartyBalanceSummary {
  const targetEntries = entries.filter((entry) => entry.date <= throughDate);
  const rows = new Map<string, MutableRow>();

  for (const journalEntry of buildJournal(targetEntries, businessType)) {
    for (const line of journalEntry.lines) {
      if (!sectionForAccount(line.account.code)) continue;

      const counterparty = journalEntry.partner.trim() || MISSING_COUNTERPARTY;
      const key = rowKey(counterparty, line.account.code);
      const row = rows.get(key) ?? {
        counterparty,
        accountCode: line.account.code,
        accountName: line.account.name,
        received: 0,
        settled: 0,
        balance: 0,
        lastActivityDate: null,
        ownerFunding: line.account.code === OWNER_FUNDING_ACCOUNT_CODE,
        unattributedOpening: false,
      };

      row.received += line.credit;
      row.settled += line.debit;
      row.balance += line.credit - line.debit;
      if (!row.lastActivityDate || journalEntry.date > row.lastActivityDate) {
        row.lastActivityDate = journalEntry.date;
      }
      rows.set(key, row);
    }
  }

  const targetCodes = new Set([
    ...[...rows.values()]
      .filter((row) => sectionForAccount(row.accountCode) === 'payables')
      .map((row) => row.accountCode),
    ...[...officialBalances.keys()].filter((code) => sectionForAccount(code) === 'payables'),
  ]);

  for (const accountCode of targetCodes) {
    const account = accountByCode(accountCode);
    if (!account) continue;
    const attributedBalance = [...rows.values()]
      .filter((row) => row.accountCode === accountCode)
      .reduce((sum, row) => sum + row.balance, 0);
    const difference = (officialBalances.get(accountCode) ?? 0) - attributedBalance;
    if (difference === 0) continue;

    rows.set(rowKey(UNATTRIBUTED_OPENING, accountCode), {
      counterparty: UNATTRIBUTED_OPENING,
      accountCode,
      accountName: account.name,
      received: Math.max(difference, 0),
      settled: Math.max(-difference, 0),
      balance: difference,
      lastActivityDate: null,
      ownerFunding: accountCode === OWNER_FUNDING_ACCOUNT_CODE,
      unattributedOpening: true,
    });
  }

  const result: CounterpartyBalanceSummary = {
    funding: emptySection(),
    payables: emptySection(),
  };
  for (const row of rows.values()) {
    const section = sectionForAccount(row.accountCode);
    if (!section) continue;
    result[section].rows.push({
      counterparty: row.counterparty,
      accountCode: row.accountCode,
      accountName: row.accountName,
      received: row.received,
      settled: row.settled,
      balance: row.balance,
      lastActivityDate: row.lastActivityDate,
      ownerFunding: row.ownerFunding,
      unattributedOpening: row.unattributedOpening,
    });
  }

  for (const section of [result.funding, result.payables]) {
    section.rows.sort(
      (a, b) =>
        b.balance - a.balance ||
        a.accountCode.localeCompare(b.accountCode) ||
        a.counterparty.localeCompare(b.counterparty, "ja"),
    );
    section.totals = totalsOf(section.rows);
  }

  return result;
}
