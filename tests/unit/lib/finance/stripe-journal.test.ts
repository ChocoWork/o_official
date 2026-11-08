import { mergeJournalEntries } from '@/lib/finance/stripe-journal';
import { accountByCode, type Account } from '@/lib/finance/accounts';
import type { JournalEntry } from '@/lib/finance/journal';
import { savedEntryToJournalEntry, type SavedJournalEntry } from '@/lib/accounting/journal-types';

// 注文の売上と Stripe の仕訳の合成（buildStripeJournal）は FREQ-570 で無くなった。ここには、保存した仕訳と
// 決算整理の仕訳を重ねる道具 mergeJournalEntries の試験だけを残す。

const lookup = (code: string) => accountByCode(code) as Account;

function saved(entryNo: number, dedupeKey: string, entryDate: string): SavedJournalEntry {
  return {
    id: `00000000-0000-4000-8000-00000000000${entryNo}`, periodId: '00000000-0000-4000-8000-000000000002',
    entryNo, entryDate, eventKind: 'manual_entry', dedupeKey,
    description: '広告', recordedAt: `${entryDate}T01:00:00Z`, recordedBy: null, isLate: false,
    reversesEntryId: null, reason: null, sourceTable: 'admin_finance_expenses', sourceId: String(entryNo),
    migratedFrom: null, migratedAt: null, sourceRecordedAt: null,
    lines: [
      { lineNo: 1, accountCode: '6110', debit: 3_000, credit: 0, subAccount: null, counterparty: null, orderId: null, memo: null },
      { lineNo: 2, accountCode: '1010', debit: 0, credit: 3_000, subAccount: null, counterparty: null, orderId: null, memo: null },
    ],
  };
}

function closing(number: string, date: string): JournalEntry {
  return {
    entryId: -1, number, date, description: '減価償却費', partner: '',
    lines: [
      { account: lookup('6110'), debit: 1_000, credit: 0 },
      { account: lookup('1535'), debit: 0, credit: 1_000 },
    ],
  };
}

describe('mergeJournalEntries', () => {
  it('adds Stripe funds in transit as an asset account', () => {
    expect(accountByCode('1150')).toMatchObject({
      type: 'asset', normalSide: 'debit', section: 'その他流動資産',
    });
  });

  it('FREQ-570-AC-01: 保存した仕訳と決算整理の仕訳は印が違うので重ねずに両方残し、同じ印は1本にまとめる', () => {
    const base = [
      savedEntryToJournalEntry(saved(1, 'manual_entry:1:0', '2026-08-15'), lookup),
      savedEntryToJournalEntry(saved(2, 'payment_confirmed:pi_1', '2026-08-16'), lookup),
    ];
    const generated = [closing('JE-20261231-D001', '2026-12-31')];

    const merged = mergeJournalEntries(base, generated);

    expect(merged.map((entry) => entry.sourceKey ?? entry.number)).toEqual([
      'manual_entry:1:0', 'payment_confirmed:pi_1', 'JE-20261231-D001',
    ]);
    // 同じ印を重ねて渡しても増えない。
    expect(mergeJournalEntries(merged, generated)).toHaveLength(merged.length);
    expect(mergeJournalEntries(generated, generated)).toHaveLength(generated.length);
  });

  it('FREQ-570-AC-01: 日付の順に並べ、同じ日は伝票番号の順にする', () => {
    const merged = mergeJournalEntries(
      [
        savedEntryToJournalEntry(saved(2, 'k:2', '2026-03-02'), lookup),
        savedEntryToJournalEntry(saved(1, 'k:1', '2026-03-02'), lookup),
      ],
      [closing('JE-20260301-D001', '2026-03-01')],
    );

    expect(merged.map((entry) => entry.number)).toEqual(['JE-20260301-D001', 'JE-000001', 'JE-000002']);
  });
});
