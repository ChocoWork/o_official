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

import { POST } from '@/app/api/admin/kpi/cost-profit/receipt/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';

const authorizeMock = authorizeAdminPermission as jest.MockedFunction<typeof authorizeAdminPermission>;
const createServiceMock = createServiceRoleClient as jest.MockedFunction<typeof createServiceRoleClient>;
const logAuditMock = logAudit as jest.MockedFunction<typeof logAudit>;
const csrfMock = requireCsrfOrDeny as jest.MockedFunction<typeof requireCsrfOrDeny>;

function requestWithReceipt() {
	const formData = new FormData();
	formData.set('entryId', '28');
	formData.set('file', new File(['receipt'], 'receipt.pdf', { type: 'application/pdf' }));
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
	receiptQuery.single = jest.fn().mockResolvedValue({ data: { id: 1 }, error: null });
	const bucket = {
		upload: jest.fn().mockResolvedValue({ error: null }),
		remove: jest.fn().mockResolvedValue({ error: null }),
	};

	return {
		from: jest.fn((table: string) =>
			table === 'admin_finance_expenses' ? entryQuery : receiptQuery,
		),
		storage: { from: jest.fn(() => bucket) },
	};
}

describe('POST /api/admin/kpi/cost-profit/receipt', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		authorizeMock.mockResolvedValue({
			ok: true,
			userId: 'admin-id',
			role: 'admin',
			actorEmail: 'admin@example.com',
		});
		createServiceMock.mockResolvedValue(createSupabaseMock() as never);
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
});
