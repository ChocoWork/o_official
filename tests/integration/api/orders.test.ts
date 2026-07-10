jest.mock('@/lib/supabase/server', () => ({
	createClient: jest.fn(),
	createServiceRoleClient: jest.fn(),
	resolveRequestUser: jest.fn(),
}));

jest.mock('@/lib/storage/item-images', () => ({
	signItemImageUrl: jest.fn(),
}));

jest.mock('next/server', () => ({
	NextResponse: {
		json: (body: unknown, init?: { status?: number; headers?: HeadersInit }) => {
			const headers = new Map<string, string>();
			if (init?.headers instanceof Headers) {
				init.headers.forEach((value, key) => {
					headers.set(key, value);
				});
			} else if (init?.headers) {
				for (const [key, value] of Object.entries(init.headers)) {
					headers.set(key, String(value));
				}
			}

			return {
				status: init?.status ?? 200,
				_body: body,
				headers,
				json: async () => body,
			};
		},
	},
}));

const { createClient, createServiceRoleClient, resolveRequestUser } = require('@/lib/supabase/server');
const { signItemImageUrl } = require('@/lib/storage/item-images');

describe('GET /api/orders', () => {
	beforeEach(() => {
		jest.resetAllMocks();
		resolveRequestUser.mockResolvedValue({
			data: { user: { id: 'user-1' } },
			error: null,
		});
		createServiceRoleClient.mockResolvedValue({});
		signItemImageUrl.mockResolvedValue('https://cdn.example.com/signed-image.jpg');
	});

	test('returns authenticated orders with no-store cache headers', async () => {
		const orderQuery = {
			select: jest.fn().mockReturnThis(),
			eq: jest.fn().mockReturnThis(),
			order: jest.fn().mockResolvedValue({
				data: [
					{
						id: 'order-1',
						created_at: '2026-04-01T00:00:00.000Z',
						status: 'paid',
						total_amount: 12000,
						currency: 'jpy',
						order_items: [
							{
								id: 'line-1',
								item_id: 10,
								item_name: 'Silk Blouse',
								item_image_url: 'item-image.jpg',
								color: 'Black',
								size: 'M',
								quantity: 1,
								line_total: 12000,
							},
						],
					},
				],
				error: null,
			}),
		};

		createClient.mockResolvedValue({
			from: jest.fn().mockReturnValue(orderQuery),
		});

		createServiceRoleClient.mockResolvedValue({
			from: jest.fn().mockReturnValue({
				select: jest.fn().mockReturnThis(),
				in: jest.fn().mockResolvedValue({
					data: [{ id: 10, stock_quantity: 5 }],
					error: null,
				}),
			}),
		});

		const { GET } = require('@/app/api/orders/route');
		const response: { status: number; json: () => Promise<unknown>; headers: Map<string, string> } = await GET(
			new Request('http://localhost/api/orders'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(body).toEqual({
			data: [
				{
					id: 'order-1',
					orderNumber: 'ORD-ORDER-1',
					orderDate: '2026/04/01',
					status: '決済完了',
					totalAmount: expect.stringMatching(/^[¥￥]12,000$/),
					itemCount: 1,
					shippingFullName: '',
					shippingEmail: '',
					shippingPhone: '',
					shippingAddress: '',
					items: [
						{
							id: 'line-1',
							itemId: 10,
							name: 'Silk Blouse',
							imageUrl: 'https://cdn.example.com/signed-image.jpg',
							color: 'Black',
							size: 'M',
							quantity: 1,
							amount: expect.stringMatching(/^[¥￥]12,000$/),
							stockStatus: 'in_stock',
						},
					],
					detailHref: '/account/orders/order-1',
				},
			],
		});
	});

	test('returns no-store on unauthorized responses', async () => {
		createClient.mockResolvedValue({ from: jest.fn() });
		resolveRequestUser.mockResolvedValue({
			data: { user: null },
			error: { message: 'Unauthorized' },
		});

		const { GET } = require('@/app/api/orders/route');
		const response: { status: number; headers: Map<string, string> } = await GET(
			new Request('http://localhost/api/orders'),
		);

		expect(response.status).toBe(401);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});
});

describe('GET /api/orders/[id]', () => {
	beforeEach(() => {
		jest.resetAllMocks();
		resolveRequestUser.mockResolvedValue({
			data: { user: { id: 'user-1' } },
			error: null,
		});
		createServiceRoleClient.mockResolvedValue({});
		signItemImageUrl.mockResolvedValue('https://cdn.example.com/signed-image.jpg');
	});

	test('returns order detail with no-store cache headers', async () => {
		const maybeSingle = jest.fn().mockResolvedValue({
			data: {
				id: 'order-1',
				created_at: '2026-04-01T00:00:00.000Z',
				status: 'paid',
				payment_intent_id: 'pi_123',
				subtotal_amount: 12000,
				shipping_amount: 500,
				discount_amount: 1000,
				total_amount: 11500,
				currency: 'jpy',
				shipping_full_name: '山田 花子',
				shipping_email: 'user@example.com',
				shipping_postal_code: '1500001',
				shipping_prefecture: '東京都',
				shipping_city: '渋谷区',
				shipping_address: '神宮前1-2-3',
				shipping_building: '青山ハイツ 101',
				shipping_phone: '090-1111-2222',
				order_items: [
					{
						id: 'line-1',
						item_id: 10,
						item_name: 'Silk Blouse',
						item_image_url: 'item-image.jpg',
						color: 'Black',
						size: 'M',
						quantity: 1,
						line_total: 12000,
					},
				],
			},
			error: null,
		});

		createClient.mockResolvedValue({
			from: jest.fn().mockReturnValue({
				select: jest.fn().mockReturnThis(),
				eq: jest.fn().mockReturnThis(),
				maybeSingle,
			}),
		});

		createServiceRoleClient.mockResolvedValue({
			from: jest.fn().mockImplementation((table: string) => {
				if (table === 'checkout_drafts') {
					return {
						select: jest.fn().mockReturnThis(),
						eq: jest.fn().mockReturnThis(),
						limit: jest.fn().mockReturnThis(),
						maybeSingle: jest.fn().mockResolvedValue({
							data: { payment_method: 'stripe_card' },
							error: null,
						}),
					};
				}

				return {
					select: jest.fn().mockReturnThis(),
					in: jest.fn().mockResolvedValue({
						data: [{ id: 10, stock_quantity: 5 }],
						error: null,
					}),
				};
			}),
		});

		const { GET } = require('@/app/api/orders/[id]/route');
		const response: { status: number; json: () => Promise<unknown>; headers: Map<string, string> } = await GET(
			new Request('http://localhost/api/orders/order-1'),
			{ params: Promise.resolve({ id: 'order-1' }) },
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(body).toMatchObject({
			id: 'order-1',
			orderNumber: 'ORD-ORDER-1',
			orderDate: '2026/04/01 09:00',
			status: 'paid',
			subtotalAmount: expect.stringMatching(/^[¥￥]12,000$/),
			shippingAmount: expect.stringMatching(/^[¥￥]500$/),
			discountAmount: expect.stringMatching(/^-[¥￥]1,000$/),
			totalAmount: expect.stringMatching(/^[¥￥]11,500$/),
			paymentMethod: 'クレジットカード',
			items: [
				expect.objectContaining({
					id: 'line-1',
					itemId: 10,
					stockStatus: 'in_stock',
				}),
			],
		});
	});

	test('returns no-store on not found responses', async () => {
		createClient.mockResolvedValue({
			from: jest.fn().mockReturnValue({
				select: jest.fn().mockReturnThis(),
				eq: jest.fn().mockReturnThis(),
				maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
			}),
		});

		const { GET } = require('@/app/api/orders/[id]/route');
		const response: { status: number; headers: Map<string, string> } = await GET(
			new Request('http://localhost/api/orders/order-404'),
			{ params: Promise.resolve({ id: 'order-404' }) },
		);

		expect(response.status).toBe(404);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});
});