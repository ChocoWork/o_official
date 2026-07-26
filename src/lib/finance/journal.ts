// 取引（取引管理の入力）→ 仕訳 → 総勘定元帳 → 合計残高試算表。
//
// 取引管理は「勘定科目」と「出金方法／入金方法」を入力させるので、
// 実質すでに複式の1組（借方1行・貸方1行）になっている。ここではその変換と、
// 元帳・試算表の集計だけを行う。貸借一致はこの層で検算する。

import {
  accountByCode,
  resolveAccount,
  type Account,
  type BusinessType,
} from "@/lib/finance/accounts";
import { paymentMethodAccountName } from "@/lib/finance/payment-methods";
import type { DepreciationForYear } from "@/lib/finance/depreciation";

export type EntryType = "expense" | "income";

/** 取引管理に入力された1件。API のレスポンス形と揃える。 */
export type FinanceEntry = {
  id: number;
  entryType: EntryType;
  date: string;
  /** 勘定科目名（相手科目） */
  category: string;
  /** 支出概要／収入概要 */
  item: string;
  partner: string;
  amount: number;
  /** 出金方法／入金方法（資金側） */
  paymentMethod: string;
  memo: string;
  seasonTag?: string | null;
};

export type JournalLine = {
  account: Account;
  debit: number;
  credit: number;
};

export type JournalEntry = {
  entryId: number;
  /** 伝票番号 JE-YYYYMMDD-NNN */
  number: string;
  date: string;
  description: string;
  partner: string;
  lines: JournalLine[];
};

/**
 * 取引1件を仕訳へ変換する。
 * 支出は資金が出るので資金科目が貸方、収入は資金が入るので資金科目が借方。
 * 控除性の科目（売上値引・返品／仕入値引・返品）もこの規則で正しく立つ。
 */
function toLines(
  entry: FinanceEntry,
  businessType: BusinessType,
): JournalLine[] {
  const counter = resolveAccount(entry.category);
  const funds = resolveAccount(
    paymentMethodAccountName(entry.paymentMethod, businessType, entry.entryType),
  );
  const amount = entry.amount;

  if (entry.entryType === "expense") {
    return [
      { account: counter, debit: amount, credit: 0 },
      { account: funds, debit: 0, credit: amount },
    ];
  }
  return [
    { account: funds, debit: amount, credit: 0 },
    { account: counter, debit: 0, credit: amount },
  ];
}

/** 取引を日付昇順（同日は id 昇順）で仕訳化する。伝票番号は日付内の連番。 */
export function buildJournal(
  entries: readonly FinanceEntry[],
  businessType: BusinessType,
): JournalEntry[] {
  const sorted = [...entries].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id - b.id,
  );
  const seqByDate = new Map<string, number>();

  return sorted.map((entry) => {
    const seq = (seqByDate.get(entry.date) ?? 0) + 1;
    seqByDate.set(entry.date, seq);
    return {
      entryId: entry.id,
      number: `JE-${entry.date.replaceAll("-", "")}-${String(seq).padStart(3, "0")}`,
      date: entry.date,
      description: entry.item,
      partner: entry.partner,
      lines: toLines(entry, businessType),
    };
  });
}

/**
 * 減価償却の決算整理仕訳。
 * 直接法（資産科目を直接減額）で立てる。青色申告決算書4ページの貸借対照表は
 * 固定資産を未償却残高で記載するため、直接法だと資産科目の元帳残高が
 * そのまま台帳の期末簿価と一致し、突き合わせができる。
 *
 * 借方 減価償却費（必要経費算入額）
 * 借方 事業主貸（家事使用分。事業専用割合が100%未満のとき）
 * 貸方 資産科目（当期償却費の全額）
 */
export function buildDepreciationEntries(
  rows: readonly DepreciationForYear[],
  fiscalYear: number,
): JournalEntry[] {
  const closingDate = `${fiscalYear}-12-31`;

  return rows
    .filter((row) => row.depreciation > 0)
    .map((row, index) => {
      const lines: JournalLine[] = [
        {
          account: resolveAccount("減価償却費"),
          debit: row.businessExpense,
          credit: 0,
        },
      ];
      if (row.privatePortion > 0) {
        lines.push({
          account: resolveAccount("事業主貸"),
          debit: row.privatePortion,
          credit: 0,
        });
      }
      lines.push({
        account: resolveAccount(row.asset.account),
        debit: 0,
        credit: row.depreciation,
      });

      return {
        // 決算整理仕訳は取引 id と衝突しないよう負の id を振る。
        entryId: -row.asset.id,
        number: `JE-${closingDate.replaceAll("-", "")}-D${String(index + 1).padStart(3, "0")}`,
        date: closingDate,
        description: `減価償却費 ${row.asset.name}`,
        partner: "",
        lines,
      };
    });
}

export type LedgerRow = {
  date: string;
  number: string;
  /** 相手科目名（複合仕訳になった場合は「諸口」） */
  counterAccount: string;
  debit: number;
  credit: number;
  /** normalSide 基準の累計残高 */
  balance: number;
  description: string;
  partner: string;
};

export type LedgerAccount = {
  account: Account;
  openingBalance: number;
  rows: LedgerRow[];
  debitTotal: number;
  creditTotal: number;
  closingBalance: number;
};

/** 借方残の科目なら +1、貸方残なら -1。残高の符号をそろえるための係数。 */
function sideSign(account: Account): 1 | -1 {
  return account.normalSide === "debit" ? 1 : -1;
}

/**
 * 総勘定元帳。科目ごとに時系列で並べ、normalSide 基準の残高を積む。
 * openingBalances は期首残高（科目コード → normalSide 基準の金額）。
 */
export function buildGeneralLedger(
  journal: readonly JournalEntry[],
  openingBalances: ReadonlyMap<string, number> = new Map(),
): LedgerAccount[] {
  const byCode = new Map<string, LedgerAccount>();

  const ensure = (account: Account): LedgerAccount => {
    const existing = byCode.get(account.code);
    if (existing) return existing;
    const opening = openingBalances.get(account.code) ?? 0;
    const created: LedgerAccount = {
      account,
      openingBalance: opening,
      rows: [],
      debitTotal: 0,
      creditTotal: 0,
      closingBalance: opening,
    };
    byCode.set(account.code, created);
    return created;
  };

  // 期首残高だけがあって当期に動きがない科目（元入金など）も元帳に出す。
  // これを落とすと試算表の貸借が期首分だけ狂う。
  for (const [code] of openingBalances) {
    const account = accountByCode(code);
    if (account) ensure(account);
  }

  for (const entry of journal) {
    for (const line of entry.lines) {
      const ledger = ensure(line.account);
      const others = entry.lines.filter((other) => other !== line);
      const counterAccount =
        others.length === 1 ? others[0].account.name : "諸口";

      ledger.debitTotal += line.debit;
      ledger.creditTotal += line.credit;
      ledger.closingBalance +=
        sideSign(line.account) * (line.debit - line.credit);

      ledger.rows.push({
        date: entry.date,
        number: entry.number,
        counterAccount,
        debit: line.debit,
        credit: line.credit,
        balance: ledger.closingBalance,
        description: entry.description,
        partner: entry.partner,
      });
    }
  }

  return [...byCode.values()].sort((a, b) =>
    a.account.code.localeCompare(b.account.code),
  );
}

export type TrialBalanceRow = {
  account: Account;
  openingBalance: number;
  debitTotal: number;
  creditTotal: number;
  /** 残高が借方側にある場合の金額（貸方側なら 0） */
  debitBalance: number;
  creditBalance: number;
};

export type TrialBalance = {
  rows: TrialBalanceRow[];
  debitTotal: number;
  creditTotal: number;
  debitBalanceTotal: number;
  creditBalanceTotal: number;
  /** 合計・残高の双方で貸借が一致しているか */
  isBalanced: boolean;
  /** 借方合計 − 貸方合計。0 でなければ入力または変換の異常。 */
  difference: number;
};

/**
 * 合計残高試算表。
 * 「合計」は借方・貸方の発生額、「残高」は差額を科目の正常側へ寄せた値。
 * 複式簿記が成立していれば 合計借方 = 合計貸方、残高借方 = 残高貸方 になる。
 */
export function buildTrialBalance(
  ledger: readonly LedgerAccount[],
): TrialBalance {
  const rows: TrialBalanceRow[] = ledger.map((account) => {
    // 残高は normalSide 基準。正なら正常側、負なら反対側に立つ。
    const signed = account.closingBalance;
    const onDebitSide = account.account.normalSide === "debit";
    const debitBalance = onDebitSide
      ? Math.max(signed, 0)
      : Math.max(-signed, 0);
    const creditBalance = onDebitSide
      ? Math.max(-signed, 0)
      : Math.max(signed, 0);

    return {
      account: account.account,
      openingBalance: account.openingBalance,
      debitTotal: account.debitTotal,
      creditTotal: account.creditTotal,
      debitBalance,
      creditBalance,
    };
  });

  const sum = (pick: (row: TrialBalanceRow) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);

  const debitTotal = sum((row) => row.debitTotal);
  const creditTotal = sum((row) => row.creditTotal);
  const debitBalanceTotal = sum((row) => row.debitBalance);
  const creditBalanceTotal = sum((row) => row.creditBalance);

  return {
    rows,
    debitTotal,
    creditTotal,
    debitBalanceTotal,
    creditBalanceTotal,
    isBalanced:
      debitTotal === creditTotal && debitBalanceTotal === creditBalanceTotal,
    difference: debitTotal - creditTotal,
  };
}
