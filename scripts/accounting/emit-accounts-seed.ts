// npx tsx scripts/accounting/emit-accounts-seed.ts
// ACCOUNTS から public.accounting_accounts の INSERT の本文を標準出力へ出す（S2 の
// `-- ACC_ACCOUNTS_BEGIN/END` の間へ貼る）。resolveAccount のフォールバック 9999（諸口）も1行足す。

import { ACCOUNTS, type Account } from '../../src/lib/finance/accounts';

export type CarryoverRole = 'capital_sole' | 'owner_draw' | 'owner_contribution' | 'retained_corp' | 'pl_zero' | 'carry';

export type AccountSeedRow = {
	code: string;
	accountType: Account['type'];
	normalSide: Account['normalSide'];
	scope: Account['scope'];
	carryoverRole: CarryoverRole;
};

/** 期首へ残高をどう写すか（設計 3-e・3-f）。区分が事業主貸の勘定（1910・1920）は期首を0にする。 */
function carryoverRole(account: Pick<Account, 'code' | 'type' | 'section'>): CarryoverRole {
	if (account.code === '2910') return 'capital_sole';
	if (account.code === '2920') return 'owner_contribution';
	if (account.code === '3040') return 'retained_corp';
	if (account.section === '事業主貸') return 'owner_draw';
	if (account.type === 'revenue' || account.type === 'expense') return 'pl_zero';
	return 'carry';
}

export function buildAccountsSeedRows(): AccountSeedRow[] {
	const rows: AccountSeedRow[] = ACCOUNTS.map((account) => ({
		code: account.code,
		accountType: account.type,
		normalSide: account.normalSide,
		scope: account.scope,
		carryoverRole: carryoverRole(account),
	}));
	rows.push({ code: '9999', accountType: 'expense', normalSide: 'debit', scope: 'common', carryoverRole: 'pl_zero' });
	return rows;
}

export function buildAccountsSeedSql(): string {
	const values = buildAccountsSeedRows().map(
		(row) => `  ('${row.code}','${row.accountType}','${row.normalSide}','${row.scope}','${row.carryoverRole}')`,
	);
	return `INSERT INTO public.accounting_accounts (code,account_type,normal_side,scope,carryover_role) VALUES\n${values.join(',\n')};\n`;
}

if (require.main === module) {
	process.stdout.write(buildAccountsSeedSql());
}
