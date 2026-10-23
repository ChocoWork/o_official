export {};

jest.mock('@/lib/supabase/server', () => ({
	createClient: jest.fn(),
}));
jest.mock('@/lib/auth/authenticate', () => ({
	authenticateRequest: jest.fn(),
	authFailureResponse: jest.fn(),
}));
jest.mock('@/lib/csrfMiddleware', () => ({
	requireCsrfOrDeny: jest.fn(),
}));
jest.mock('next/server', () => ({
	NextResponse: {
		json: (body: unknown, init?: { status?: number }) => ({
			status: init?.status ?? 200,
			json: async () => body,
		}),
	},
}));

const { createClient } = require('@/lib/supabase/server');
const { authenticateRequest } = require('@/lib/auth/authenticate');
const { requireCsrfOrDeny } = require('@/lib/csrfMiddleware');
const handler = require('@/app/api/profile/addresses/route');

const ADDRESS = {
	postalCode: '1500001',
	prefecture: '東京都',
	city: '渋谷区',
	address: '神宮前1-2-3',
	building: '',
	isDefault: true,
};

function makePutRequest() {
	return new Request('http://localhost/api/profile/addresses', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ addresses: [ADDRESS] }),
	});
}

// requireCsrfOrDeny が返す本物の NextResponse。試験の環境の Response（node-fetch）には静的な json が無いので直接作る
function realCsrfDenyResponse(status: number, body: unknown) {
	const { NextResponse: RealNextResponse } = jest.requireActual('next/server');
	return new RealNextResponse(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('PUT /api/profile/addresses', () => {
	beforeEach(() => {
		jest.resetAllMocks();
		authenticateRequest.mockResolvedValue({ ok: true, claims: { sub: 'user-1', session_id: 'session-1' } });
	});

	test('CSRF が通れば住所を保存して200を返す', async () => {
		requireCsrfOrDeny.mockResolvedValue(undefined);
		const upsert = jest.fn().mockResolvedValue({ error: null });
		createClient.mockResolvedValue({ from: jest.fn().mockReturnValue({ upsert }) });

		const res: any = await handler.PUT(makePutRequest());

		expect(res.status).toBe(200);
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({ user_id: 'user-1' }),
			expect.objectContaining({ onConflict: 'user_id' }),
		);
	});

	// requireCsrfOrDeny は本物の Response（403 か DB の失敗の500）を返す（R-22）
	test.each([
		{ label: '403（なりすまし）', status: 403, body: { error: 'Forbidden', reason: 'CSRF validation failed' } },
		{ label: '500（照合の DB の失敗）', status: 500, body: { error: 'Internal server error' } },
	])('CSRF で断られたら（$label）その応答をそのまま返し、本文の読み取りと保存に進まない', async ({ status, body }) => {
		const denyResponse = realCsrfDenyResponse(status, body);
		requireCsrfOrDeny.mockResolvedValue(denyResponse);
		const from = jest.fn();
		createClient.mockResolvedValue({ from });
		const req = makePutRequest();
		const readBody = jest.spyOn(req, 'json');

		const res: any = await handler.PUT(req);

		expect(res).toBe(denyResponse);
		expect(res.status).toBe(status);
		expect(await res.json()).toEqual(body);
		expect(readBody).not.toHaveBeenCalled();
		expect(from).not.toHaveBeenCalled();
	});
});
