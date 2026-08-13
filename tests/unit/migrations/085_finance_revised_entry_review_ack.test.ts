import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('085_finance_revised_entry_review_ack migration', () => {
	it('allows the corporation correction review reason', () => {
		const sql = readFileSync(
			join(process.cwd(), 'migrations', '085_finance_revised_entry_review_ack.sql'),
			'utf8',
		);

		expect(sql).toContain('admin_finance_entry_review_acks_reason_check');
		expect(sql).toContain("'duplicate'");
		expect(sql).toContain("'unknownAccount'");
		expect(sql).toContain("'unlinkedAsset'");
		expect(sql).toContain("'revisedEntry'");
	});
});
