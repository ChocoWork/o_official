jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
const responseCookieSetMock = jest.fn();
jest.mock('next/server', () => ({
	NextResponse: {
		json: (body: unknown, init?: { status?: number }) => ({
			status: init?.status ?? 200,
			json: async () => body,
			cookies: { set: responseCookieSetMock },
		}),
	},
}));

import { GET, POST } from '@/app/api/admin/kpi/cost-profit/receipt/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';

const authorizeMock = authorizeAdminPermission as jest.MockedFunction<typeof authorizeAdminPermission>;
const createServiceMock = createServiceRoleClient as jest.MockedFunction<typeof createServiceRoleClient>;
const logAuditMock = logAudit as jest.MockedFunction<typeof logAudit>;
const csrfMock = requireCsrfOrDeny as jest.MockedFunction<typeof requireCsrfOrDeny>;

function requestWithReceipt(fields: Record<string, string> = {}) {
	const formData = new FormData();
	formData.set('entryId', '28');
	formData.set('file', new File(['receipt'], 'receipt.pdf', { type: 'application/pdf' }));
	for (const [name, value] of Object.entries(fields)) formData.set(name, value);
	return {
		formData: async () => formData,
		headers: new Headers(),
	} as Request;
}

function createSupabaseMock() {
	const entryQuery: Record<string, jest.Mock> = {};
	entryQuery.select = jest.fn(() => entryQuery);
	entryQuery.eq = jest.fn(() => entryQuery);
	entryQuery.is = jest.fn(() => entryQuery);
	entryQuery.maybeSingle = jest.fn().mockResolvedValue({
			data: { id: 28, fiscal_year: 2026, expense_date: '2026-08-12' },
			error: null,
		});
	const receiptQuery: Record<string, jest.Mock> = {};
	receiptQuery.insert = jest.fn(() => receiptQuery);
	receiptQuery.select = jest.fn(() => receiptQuery);
	receiptQuery.eq = jest.fn(() => receiptQuery);
	receiptQuery.single = jest.fn().mockResolvedValue({ data: { id: 1 }, error: null });
	receiptQuery.maybeSingle = jest.fn().mockResolvedValue({
		data: {
			id: 1,
			storage_path: '2026/28/receipt.pdf',
			file_name: 'receipt.pdf',
			evidence_kind: 'paper',
			paper_original_kept: true,
		},
		error: null,
	});
	const bucket = {
		upload: jest.fn().mockResolvedValue({ error: null }),
		remove: jest.fn().mockResolvedValue({ error: null }),
		createSignedUrl: jest.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/receipt' }, error: null }),
	};

	return {
		receiptQuery,
		bucket,
		from: jest.fn((table: string) =>
			table === 'admin_finance_expenses' ? entryQuery : receiptQuery,
		),
		storage: { from: jest.fn(() => bucket) },
	};
}

describe('POST /api/admin/kpi/cost-profit/receipt', () => {
	let supabase: ReturnType<typeof createSupabaseMock>;

	beforeEach(() => {
		jest.clearAllMocks();
		authorizeMock.mockResolvedValue({
			ok: true,
			userId: 'admin-id',
			role: 'admin',
			actorEmail: 'admin@example.com',
			permissions: new Set(),
		});
		supabase = createSupabaseMock();
		createServiceMock.mockResolvedValue(supabase as never);
		logAuditMock.mockResolvedValue(undefined);
		csrfMock.mockResolvedValue(undefined);
	});

	it('keeps the upload successful when the rotated CSRF cookie cannot be attached', async () => {
		const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		csrfMock.mockResolvedValue({ rotatedCsrfToken: 'next-token' });
		responseCookieSetMock.mockImplementationOnce(() => {
			throw new Error('cookie finalization failed');
		});

		const response = await POST(requestWithReceipt());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				id: 1,
				storagePath: expect.stringMatching(/^2026\/28\/.+\.pdf$/),
				fileName: 'receipt.pdf',
				mimeType: 'application/pdf',
				fileSize: 7,
			},
		});
		consoleError.mockRestore();
	});

	it('FREQ-559-AC-02: receiptのPOSTは種類を受け紙には原本の有無を求め未指定は未確認のまま', async () => {
		// 電子の証憑は種類だけを保存し、原本の有無は持たない。
		expect((await POST(requestWithReceipt({ evidenceKind: 'electronic' }))).status).toBe(200);
		expect(supabase.receiptQuery.insert).toHaveBeenLastCalledWith(
			expect.objectContaining({ evidence_kind: 'electronic', paper_original_kept: null }),
		);

		// 紙の証憑は原本を残したかどうかを一緒に保存する。
		expect((await POST(requestWithReceipt({ evidenceKind: 'paper', paperOriginalKept: 'true' }))).status).toBe(200);
		expect(supabase.receiptQuery.insert).toHaveBeenLastCalledWith(
			expect.objectContaining({ evidence_kind: 'paper', paper_original_kept: true }),
		);
		expect((await POST(requestWithReceipt({ evidenceKind: 'paper', paperOriginalKept: 'false' }))).status).toBe(200);
		expect(supabase.receiptQuery.insert).toHaveBeenLastCalledWith(
			expect.objectContaining({ evidence_kind: 'paper', paper_original_kept: false }),
		);

		// 種類を送らない画面（Task 11 の前）は、DB の既定の「未確認」に任せて列を送らない。
		expect((await POST(requestWithReceipt())).status).toBe(200);
		const omitted = supabase.receiptQuery.insert.mock.lastCall?.[0] as Record<string, unknown>;
		expect(omitted).not.toHaveProperty('evidence_kind');
		expect(omitted).not.toHaveProperty('paper_original_kept');

		const insertCount = supabase.receiptQuery.insert.mock.calls.length;
		const uploadCount = supabase.bucket.upload.mock.calls.length;
		const invalid: Array<Record<string, string>> = [
			{ evidenceKind: 'paper' },
			{ evidenceKind: 'paper', paperOriginalKept: 'yes' },
			{ evidenceKind: 'electronic', paperOriginalKept: 'false' },
			{ paperOriginalKept: 'true' },
			{ evidenceKind: 'unconfirmed' },
			{ evidenceKind: 'scan' },
		];
		for (const fields of invalid) {
			const response = await POST(requestWithReceipt(fields));
			expect({ fields, status: response.status }).toEqual({ fields, status: 400 });
		}
		// 断った時は置き場にも表にも書かない。
		expect(supabase.receiptQuery.insert).toHaveBeenCalledTimes(insertCount);
		expect(supabase.bucket.upload).toHaveBeenCalledTimes(uploadCount);
	});
});

describe('GET /api/admin/kpi/cost-profit/receipt', () => {
	it('FREQ-559-AC-02: receiptのGETは種類を返す', async () => {
		authorizeMock.mockResolvedValue({
			ok: true,
			userId: 'admin-id',
			role: 'admin',
			actorEmail: 'admin@example.com',
			permissions: new Set(),
		});
		const supabase = createSupabaseMock();
		createServiceMock.mockResolvedValue(supabase as never);

		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit/receipt?path=2026%2F28%2Freceipt.pdf'));

		expect(response.status).toBe(200);
		expect(supabase.receiptQuery.select).toHaveBeenCalledWith(expect.stringContaining('evidence_kind'));
		expect(supabase.receiptQuery.select).toHaveBeenCalledWith(expect.stringContaining('paper_original_kept'));
		expect(await response.json()).toEqual({
			data: {
				url: 'https://signed.example/receipt',
				fileName: 'receipt.pdf',
				expiresIn: 300,
				evidenceKind: 'paper',
				paperOriginalKept: true,
			},
		});
	});
});
