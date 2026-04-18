jest.mock('@/lib/supabase/server', () => ({
	createClient: jest.fn(),
	resolveRequestUser: jest.fn(),
}));

jest.mock('next/server', () => ({
	NextResponse: {
		json: (body: unknown, init?: { status?: number }) => ({
			status: init?.status ?? 200,
			_body: body,
			json: async () => body,
		}),
	},
}));

const { createClient, resolveRequestUser } = require('@/lib/supabase/server');
const handler = require('@/app/api/profile/route');

function createProfileQueryBuilder(results: Array<{ data: unknown; error: unknown }>) {
	const maybeSingle = jest.fn();
	for (const result of results) {
		maybeSingle.mockResolvedValueOnce(result);
	}

	return {
		select: jest.fn().mockReturnThis(),
		eq: jest.fn().mockReturnThis(),
		maybeSingle,
	};
}

describe('GET /api/profile', () => {
	beforeEach(() => {
		jest.resetAllMocks();
		resolveRequestUser.mockResolvedValue({
			data: {
				user: {
					id: 'user-1',
					email: 'user@example.com',
				},
			},
			error: null,
		});
	});

	test('optional profile columns が未適用でも stable columns で取得を継続する', async () => {
		const builder = createProfileQueryBuilder([
			{
				data: null,
				error: {
					code: 'PGRST204',
					message: "Could not find the 'optional_name' column of 'profiles' in the schema cache",
				},
			},
			{
				data: {
					display_name: '山田 花子',
					kana_name: 'ヤマダ ハナコ',
					phone: '090-1111-2222',
					address: {
						postalCode: '1500001',
						prefecture: '東京都',
						city: '渋谷区',
						address: '神宮前1-2-3',
						building: '青山ハイツ 101',
					},
				},
				error: null,
			},
		]);

		createClient.mockResolvedValue({
			from: jest.fn().mockReturnValue(builder),
		});

		const req = new Request('http://localhost/api/profile', { method: 'GET' });
		const res: any = await handler.GET(req);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(builder.select).toHaveBeenNthCalledWith(1, 'display_name, kana_name, phone, address, optional_name, optional_phone');
		expect(builder.select).toHaveBeenNthCalledWith(2, 'display_name, kana_name, phone, address');
		expect(body).toMatchObject({
			email: 'user@example.com',
			fullName: '山田 花子',
			kanaName: 'ヤマダ ハナコ',
			phone: '090-1111-2222',
		});
	});

	test('認証失敗時は 401 を返す', async () => {
		createClient.mockResolvedValue({ from: jest.fn() });
		resolveRequestUser.mockResolvedValue({
			data: { user: null },
			error: { message: 'Unauthorized' },
		});

		const req = new Request('http://localhost/api/profile', { method: 'GET' });
		const res: any = await handler.GET(req);

		expect(res.status).toBe(401);
	});

	test('POST は電話番号を整形して保存する', async () => {
		const upsert = jest.fn().mockResolvedValue({ error: null });
		createClient.mockResolvedValue({
			from: jest.fn().mockReturnValue({
				upsert,
			}),
		});

		const req = new Request('http://localhost/api/profile', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				fullName: '山田 花子',
				kanaName: 'ヤマダ ハナコ',
				phone: '09012345678',
				address: {
					postalCode: '1500001',
					prefecture: '東京都',
					city: '渋谷区',
					address: '神宮前1-2-3',
					building: '青山ハイツ 101',
				},
			}),
		});

		const res: any = await handler.POST(req);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				phone: '090-1234-5678',
				optional_phone: '090-1234-5678',
			}),
			expect.objectContaining({ onConflict: 'user_id' }),
		);
		expect(body).toMatchObject({ phone: '090-1234-5678' });
	});
});