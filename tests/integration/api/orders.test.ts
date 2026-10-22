export {};

jest.mock('@/lib/supabase/server', () => ({
	createClient: jest.fn(),
	createServiceRoleClient: jest.fn(),
}));
// 認証は claims ベースの authenticateRequest に一本化した（旧 resolveRequestUser）。
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  // 本物と同じく headers を通す。落とすと no-store の検証がすり抜ける。
  authFailureResponse: (reason: string, headers: Record<string, string> = {}) =>
    require('next/server').NextResponse.json(
      { error: reason === 'unavailable' ? 'Service temporarily unavailable' : 'Unauthorized' },
      { status: reason === 'unavailable' ? 503 : 401, headers },
    ),
}));

jest.mock('@/lib/storage/item-images', () => ({
	signItemImageUrl: jest.fn(),
}));

// 配送の集計と配送の記録の読み出し（delivery-store）は server-only。本物の読み出しを、差し替えた DB の答えで通す
jest.mock('server-only', () => ({}), { virtual: true });

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

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { authenticateRequest } = require('@/lib/auth/authenticate');
const { signItemImageUrl } = require('@/lib/storage/item-images');

// 配送の集計・配送の記録の読み出し（delivery-store）は、注文の番号と発送の番号に uuid の形を求める
const DELIVERED_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const PARTIAL_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455557777';
const FULFILLMENT_ID = 'd1b2c3d4-1111-4222-8333-444455556661';

// private.order_line_fulfillment の1行（在庫の品1点が仕上がり済みで未発送 = 発送準備中）
const READY_LINE_ROW = {
	order_id: 'order-1',
	order_item_id: 'line-1',
	variant_id: 5,
	fulfillment_type: 'stock',
	quantity: 1,
	shipped: 0,
	completed: 1,
	refunded_before_shipment: 0,
	refunded_after_shipment: 0,
	in_production: 0,
	ready_unshipped: 1,
	unshipped: 1,
};

describe('GET /api/orders', () => {
	beforeEach(() => {
		jest.resetAllMocks();
		authenticateRequest.mockResolvedValue({ ok: true, claims: { sub: 'user-1', session_id: 'session-1' } });
		createServiceRoleClient.mockResolvedValue({});
		signItemImageUrl.mockResolvedValue('https://cdn.example.com/signed-image.jpg');
	});

	test('returns authenticated orders with no-store cache headers', async () => {
		const orderQuery = {
			select: jest.fn().mockReturnThis(),
			eq: jest.fn().mockReturnThis(),
			not: jest.fn().mockReturnThis(),
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

		const rpc = jest.fn().mockImplementation(async (name: string) => ({
			data: name === 'list_order_line_fulfillment' ? [READY_LINE_ROW] : [],
			error: null,
		}));
		createServiceRoleClient.mockResolvedValue({ rpc });

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
					status: '発送準備中',
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
						},
					],
					detailHref: '/account/orders/order-1',
				},
			],
		});
		expect(rpc).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: ['order-1'] });
		expect(rpc).toHaveBeenCalledWith('list_order_refund_summaries', { _order_ids: ['order-1'] });
		expect(rpc).toHaveBeenCalledWith('list_order_delivery_summaries', { _order_ids: ['order-1'] });
	});

	test('取り消していない発送が全部配達済みの注文は、一覧の言葉が「配達済み」になる（配送の集計を DB の行から読む）', async () => {
		const orderQuery = {
			select: jest.fn().mockReturnThis(),
			eq: jest.fn().mockReturnThis(),
			not: jest.fn().mockReturnThis(),
			order: jest.fn().mockResolvedValue({
				data: [
					{
						id: DELIVERED_ORDER_ID,
						created_at: '2026-04-01T00:00:00.000Z',
						status: 'shipped',
						total_amount: 12000,
						currency: 'jpy',
						order_items: [],
					},
					{
						id: PARTIAL_ORDER_ID,
						created_at: '2026-04-02T00:00:00.000Z',
						status: 'shipped',
						total_amount: 12000,
						currency: 'jpy',
						order_items: [],
					},
				],
				error: null,
			}),
		};
		createClient.mockResolvedValue({ from: jest.fn().mockReturnValue(orderQuery) });

		const rpc = jest.fn().mockImplementation(async (name: string) => {
			if (name === 'list_order_line_fulfillment') {
				return {
					data: [
						{ ...READY_LINE_ROW, order_id: DELIVERED_ORDER_ID, shipped: 1, ready_unshipped: 0, unshipped: 0 },
						{ ...READY_LINE_ROW, order_id: PARTIAL_ORDER_ID, shipped: 1, ready_unshipped: 0, unshipped: 0 },
					],
					error: null,
				};
			}
			if (name === 'list_order_delivery_summaries') {
				return {
					data: [
						{ order_id: DELIVERED_ORDER_ID, active_count: 1, delivered_count: 1, attention_kind: null },
						{ order_id: PARTIAL_ORDER_ID, active_count: 2, delivered_count: 1, attention_kind: 'attempted_delivery' },
					],
					error: null,
				};
			}
			return { data: [], error: null };
		});
		createServiceRoleClient.mockResolvedValue({ rpc });

		const { GET } = require('@/app/api/orders/route');
		const response: { status: number; json: () => Promise<{ data: Array<{ id: string; status: string }> }> } = await GET(
			new Request('http://localhost/api/orders'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.map((order) => [order.id, order.status])).toEqual([
			[DELIVERED_ORDER_ID, '配達済み'],
			[PARTIAL_ORDER_ID, '配送中'],
		]);
		// 要対応の種類などの内側の情報は、お客様の一覧に出さない
		expect(JSON.stringify(body)).not.toContain('attempted_delivery');
		expect(rpc).toHaveBeenCalledWith('list_order_delivery_summaries', { _order_ids: [DELIVERED_ORDER_ID, PARTIAL_ORDER_ID] });
	});

	test('配送の集計の読み取りが失敗したら 500（no-store）で、偽の「配送中」を返さない', async () => {
		const orderQuery = {
			select: jest.fn().mockReturnThis(),
			eq: jest.fn().mockReturnThis(),
			not: jest.fn().mockReturnThis(),
			order: jest.fn().mockResolvedValue({
				data: [{ id: DELIVERED_ORDER_ID, created_at: '2026-04-01T00:00:00.000Z', status: 'shipped', total_amount: 12000, currency: 'jpy', order_items: [] }],
				error: null,
			}),
		};
		createClient.mockResolvedValue({ from: jest.fn().mockReturnValue(orderQuery) });
		const rpc = jest.fn().mockImplementation(async (name: string) =>
			name === 'list_order_delivery_summaries'
				? { data: null, error: { message: 'down', code: '08006' } }
				: { data: name === 'list_order_line_fulfillment' ? [{ ...READY_LINE_ROW, order_id: DELIVERED_ORDER_ID, shipped: 1, ready_unshipped: 0, unshipped: 0 }] : [], error: null });
		createServiceRoleClient.mockResolvedValue({ rpc });
		const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

		const { GET } = require('@/app/api/orders/route');
		const response: { status: number; headers: Map<string, string> } = await GET(new Request('http://localhost/api/orders'));

		expect(response.status).toBe(500);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		consoleError.mockRestore();
	});


	test('全部の商品を発送前に返金して手続き中の返金がある注文は、一覧の言葉も「キャンセルの手続き中」になる', async () => {
		const orderQuery = {
			select: jest.fn().mockReturnThis(),
			eq: jest.fn().mockReturnThis(),
			not: jest.fn().mockReturnThis(),
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
								item_image_url: null,
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
		createClient.mockResolvedValue({ from: jest.fn().mockReturnValue(orderQuery) });
		signItemImageUrl.mockResolvedValue(null);

		const rpc = jest.fn().mockImplementation(async (name: string) => {
			if (name === 'list_order_line_fulfillment') {
				// 1点を発送前に全部返金した（未発送 0・発送準備中 0）
				return { data: [{ ...READY_LINE_ROW, refunded_before_shipment: 1, ready_unshipped: 0, unshipped: 0 }], error: null };
			}
			if (name === 'list_order_refund_summaries') {
				return {
					data: [
						{
							order_id: 'order-1',
							paid_amount: 12000,
							succeeded_amount: 0,
							open_amount: 12000,
							refundable_amount: 0,
							has_open_refund: true,
							has_unresolved_refund_failure: false,
						},
					],
					error: null,
				};
			}
			return { data: [], error: null };
		});
		createServiceRoleClient.mockResolvedValue({ rpc });

		const { GET } = require('@/app/api/orders/route');
		const response: { status: number; json: () => Promise<{ data: Array<{ status: string }> }> } = await GET(
			new Request('http://localhost/api/orders'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.map((order) => order.status)).toEqual(['キャンセルの手続き中']);
	});

	test('returns no-store on unauthorized responses', async () => {
		createClient.mockResolvedValue({ from: jest.fn() });
		authenticateRequest.mockResolvedValue({ ok: false, reason: 'missing' });

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
		authenticateRequest.mockResolvedValue({ ok: true, claims: { sub: 'user-1', session_id: 'session-1' } });
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
				not: jest.fn().mockReturnThis(),
				maybeSingle,
			}),
		});

		// list_order_refunds の1行（送料だけを返金して成功した。商品の行なし）。操作した人のメールなど内側の情報も入れておく
		const REFUND_ROW = {
			refund_id: 'refund-1',
			source: 'admin',
			status: 'succeeded',
			stripe_status: 'succeeded',
			stripe_pending_reason: null,
			stripe_failure_reason: null,
			customer_action_expires_at: null,
			payment_method_type: 'card',
			amount: 500,
			shipping_amount: 500,
			adjustment_amount: 0,
			note: null,
			stripe_reason: 'requested_by_customer',
			cancel_reason: null,
			notify_customer: true,
			actor_email: 'admin@example.com',
			reference_number: null,
			reference_type: null,
			created_at: '2026-04-02T00:30:00.000Z',
			accepted_at: '2026-04-02T00:30:01.000Z',
			succeeded_at: '2026-04-02T00:30:02.000Z',
			failed_at: null,
			errored_at: null,
			lines: [],
		};
		const rpc = jest.fn().mockImplementation(async (name: string) => {
			if (name === 'list_order_line_fulfillment') return { data: [READY_LINE_ROW], error: null };
			if (name === 'list_order_refunds') return { data: [REFUND_ROW], error: null };
			// 返品・交換の欄の答え（返品もキャンセルの申し込みも無く、受付もしていない注文）。答えを足さないと、
			// 空の配列が「答えが読めない」誤り（RefundStoreError）になり、窓口が欄を null にしてログに誤りを出す
			if (name === 'get_customer_order_returns') {
				return {
					data: { returns: [], cancel_requests: [], availability: { returns: 'none', ended_on: null, cancel: false } },
					error: null,
				};
			}
			// 配送の記録（追跡オフ・発送なし）。配列のままだと「答えが読めない」誤りになり、窓口が 500 にする
			if (name === 'get_order_delivery_detail') return { data: { enabled: false, fulfillments: [] }, error: null };
			return { data: [], error: null };
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
			rpc,
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
			progress: {
				key: 'ready',
				label: '発送準備中',
				partiallyShipped: false,
				steps: [
					{ key: 'payment', label: 'お支払い', state: 'done' },
					{ key: 'ready', label: '発送準備中', state: 'current' },
					{ key: 'in_transit', label: '配送中', state: 'todo' },
					{ key: 'delivered', label: '配達済み', state: 'todo' },
				],
			},
			shipments: [],
			// 本物の listOrderRefunds が DB の行を読み、窓口が日本時間の日付と円の言葉に直す
			refunds: [
				{
					id: 'refund-1',
					date: '2026/04/02',
					amount: expect.stringMatching(/^[¥￥]500$/),
					status: 'completed',
					customerActionDeadline: null,
				},
			],
			refundTotal: null,
			returnSection: { returns: [], cancelRequests: [], availability: { returns: 'none', endedOn: null, cancel: false } },
			subtotalAmount: expect.stringMatching(/^[¥￥]12,000$/),
			shippingAmount: expect.stringMatching(/^[¥￥]500$/),
			discountAmount: expect.stringMatching(/^-[¥￥]1,000$/),
			totalAmount: expect.stringMatching(/^[¥￥]11,500$/),
			paymentMethod: 'クレジットカード',
			items: [
				expect.objectContaining({
					id: 'line-1',
					itemId: 10,
					shippedQuantity: 0,
					refundedQuantity: 0,
					readyQuantity: 1,
					inProductionQuantity: 0,
				}),
			],
		});
		expect(rpc).toHaveBeenCalledWith('list_order_refunds', { _order_id: 'order-1' });
		// 共通化前に通した全文。省略キー・null・配列順・キー順も固定する（画像は固定mock）。
		const expectedJsonBeforeRefactor = '{"id":"order-1","orderNumber":"ORD-ORDER-1","orderDate":"2026/04/01 09:00","status":"paid","progress":{"key":"ready","label":"発送準備中","partiallyShipped":false,"steps":[{"key":"payment","label":"お支払い","state":"done"},{"key":"ready","label":"発送準備中","state":"current"},{"key":"in_transit","label":"配送中","state":"todo"},{"key":"delivered","label":"配達済み","state":"todo"}]},"subtotalAmount":"￥12,000","shippingAmount":"￥500","discountAmount":"-￥1,000","totalAmount":"￥11,500","paymentMethod":"クレジットカード","shippingFullName":"山田 花子","shippingEmail":"user@example.com","shippingPhone":"090-1111-2222","shippingAddress":"〒1500001 東京都 渋谷区 神宮前1-2-3 青山ハイツ 101","shipments":[],"refunds":[{"id":"refund-1","date":"2026/04/02","amount":"￥500","status":"completed","customerActionDeadline":null}],"refundTotal":null,"returnSection":{"returns":[],"cancelRequests":[],"availability":{"returns":"none","endedOn":null,"cancel":false}},"items":[{"id":"line-1","itemId":10,"variantId":null,"name":"Silk Blouse","imageUrl":"https://cdn.example.com/signed-image.jpg","color":"Black","size":"M","quantity":1,"amount":"￥12,000","shippedQuantity":0,"refundedQuantity":0,"readyQuantity":1,"inProductionQuantity":0}]}';
		expect(JSON.stringify(body)).toBe(expectedJsonBeforeRefactor);
		expect(rpc).toHaveBeenCalledWith('get_customer_order_returns', { _order_id: 'order-1', _customer_id: 'user-1' });
		expect(rpc).toHaveBeenCalledWith('list_order_delivery_summaries', { _order_ids: ['order-1'] });
		expect(rpc).toHaveBeenCalledWith('get_order_delivery_detail', { _order_id: 'order-1' });
		// 操作した人のメールなど内側の情報は、DB の行にあっても、お客様に返さない
		expect(JSON.stringify(body)).not.toContain('admin@example.com');
		expect(body).not.toHaveProperty('shippedAt');
		expect(body).not.toHaveProperty('shippingCarrier');
		expect(body).not.toHaveProperty('trackingNumber');
	});

	test('returns no-store on not found responses', async () => {
		createClient.mockResolvedValue({
			from: jest.fn().mockReturnValue({
				select: jest.fn().mockReturnThis(),
				eq: jest.fn().mockReturnThis(),
				not: jest.fn().mockReturnThis(),
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

	describe('配達済みと配送の状況（グループ E-4）', () => {
		const originalKey = process.env.TRACKING_17TRACK_API_KEY;
		const originalBaseUrl = process.env.TRACKING_17TRACK_BASE_URL;

		afterEach(() => {
			for (const [name, value] of [['TRACKING_17TRACK_API_KEY', originalKey], ['TRACKING_17TRACK_BASE_URL', originalBaseUrl]] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		});

		const SHIPPED_ORDER = {
			id: DELIVERED_ORDER_ID,
			created_at: '2026-04-01T00:00:00.000Z',
			status: 'shipped',
			payment_intent_id: null,
			subtotal_amount: 12000,
			shipping_amount: 0,
			discount_amount: 0,
			total_amount: 12000,
			currency: 'jpy',
			order_items: [
				{ id: 'line-1', item_id: 10, item_name: 'Silk Blouse', item_image_url: null, color: 'Black', size: 'M', quantity: 1, line_total: 12000 },
			],
		};
		const FULFILLMENT_ROW = {
			fulfillment_id: FULFILLMENT_ID,
			number: 1,
			shipping_carrier: 'yamato',
			tracking_number: '1234-5678-9012',
			notify_customer: true,
			completes_order: true,
			shipped_at: '2026-04-02T01:00:00+00:00',
			created_by_email: 'admin@example.com',
			cancelled_at: null,
			cancelled_by_email: null,
			legacy: false,
			lines: [{ order_item_id: 'line-1', quantity: 1 }],
		};
		const DETAIL_FULFILLMENT = {
			fulfillment_id: FULFILLMENT_ID,
			number: 1,
			carrier: 'yamato',
			tracking_number: '1234-5678-9012',
			notify_customer: true,
			shipped_at: '2026-04-02T01:00:00+00:00',
			cancelled_at: null,
			tracking_version: 2,
			delivery_status: 'delivered',
			delivery_status_at: '2026-04-05T03:00:00+00:00',
			delivered_at: '2026-04-05T03:00:00+00:00',
			delivered_source: 'tracking',
			registration: { state: 'stopped', failure_kind: null, stop_reason: 'delivered', expires_at: '2026-05-02T01:00:00+00:00', ever_registered: true },
			events: [
				{
					id: 'e1b2c3d4-1111-4222-8333-44445555aaa1', tracking_version: 2, status: 'delivered', happened_at: '2026-04-05T03:00:00+00:00',
					recorded_at: '2026-04-05T03:00:05+00:00', source: 'tracking', provider_sub_status: 'Delivered_Other', actor_email: null,
				},
				{
					id: 'e1b2c3d4-1111-4222-8333-44445555aaa2', tracking_version: 1, status: 'in_transit', happened_at: '2026-04-03T01:00:00+00:00',
					recorded_at: '2026-04-03T01:00:05+00:00', source: 'tracking', provider_sub_status: 'InTransit_Old', actor_email: null,
				},
				{
					id: 'e1b2c3d4-1111-4222-8333-44445555aaa3', tracking_version: 2, status: 'confirmed', happened_at: '2026-04-04T01:00:00+00:00',
					recorded_at: '2026-04-04T01:00:05+00:00', source: 'tracking_edit', provider_sub_status: null, actor_email: 'admin@example.com',
				},
			],
			tracking_changes: [],
		};

		function arrange(answers: Record<string, unknown>) {
			createClient.mockResolvedValue({
				from: jest.fn().mockReturnValue({
					select: jest.fn().mockReturnThis(),
					eq: jest.fn().mockReturnThis(),
					not: jest.fn().mockReturnThis(),
					maybeSingle: jest.fn().mockResolvedValue({ data: SHIPPED_ORDER, error: null }),
				}),
			});
			const rpc = jest.fn().mockImplementation(async (name: string) => {
				if (name in answers) return answers[name];
				if (name === 'list_order_line_fulfillment') {
					return { data: [{ ...READY_LINE_ROW, order_id: DELIVERED_ORDER_ID, shipped: 1, ready_unshipped: 0, unshipped: 0 }], error: null };
				}
				if (name === 'list_order_fulfillments') return { data: [FULFILLMENT_ROW], error: null };
				if (name === 'get_customer_order_returns') {
					return { data: { returns: [], cancel_requests: [], availability: { returns: 'none', ended_on: null, cancel: false } }, error: null };
				}
				if (name === 'list_order_delivery_summaries') {
					return { data: [{ order_id: DELIVERED_ORDER_ID, active_count: 1, delivered_count: 1, attention_kind: null }], error: null };
				}
				return { data: [], error: null };
			});
			createServiceRoleClient.mockResolvedValue({ rpc });
			return rpc;
		}

		async function getDetail() {
			const { GET } = require('@/app/api/orders/[id]/route');
			const response: { status: number; json: () => Promise<any>; headers: Map<string, string> } = await GET(
				new Request(`http://localhost/api/orders/${DELIVERED_ORDER_ID}`),
				{ params: Promise.resolve({ id: DELIVERED_ORDER_ID }) },
			);
			return { response, body: await response.json() };
		}

		test('追跡オンで鍵あり・追跡中（止めた）の配達済みの発送は、deliveredAt と delivery（現版の出来事だけ・状況と時刻だけ）を返し、進み具合は「配達済み」', async () => {
			process.env.TRACKING_17TRACK_API_KEY = 'test-only-key';
			delete process.env.TRACKING_17TRACK_BASE_URL;
			const rpc = arrange({ get_order_delivery_detail: { data: { enabled: true, fulfillments: [DETAIL_FULFILLMENT] }, error: null } });

			const { response, body } = await getDetail();

			expect(response.status).toBe(200);
			expect(body.progress).toMatchObject({ key: 'delivered', label: '配達済み' });
			expect(body.progress.steps.every((step: { state: string }) => step.state === 'done')).toBe(true);
			expect(body.shipments).toEqual([
				expect.objectContaining({
					id: FULFILLMENT_ID,
					deliveredAt: '2026-04-05T03:00:00+00:00',
					delivery: {
						status: 'delivered',
						statusAt: '2026-04-05T03:00:00+00:00',
						events: [
							{ status: 'delivered', happenedAt: '2026-04-05T03:00:00+00:00' },
							{ status: 'confirmed', happenedAt: '2026-04-04T01:00:00+00:00' },
						],
					},
				}),
			]);
			const json = JSON.stringify(body);
			for (const secret of ['admin@example.com', 'Delivered_Other', 'InTransit_Old', 'actorEmail', 'providerSubStatus', 'trackingChanges']) {
				expect(json).not.toContain(secret);
			}
			expect(rpc).toHaveBeenCalledWith('list_order_delivery_summaries', { _order_ids: [DELIVERED_ORDER_ID] });
			expect(rpc).toHaveBeenCalledWith('get_order_delivery_detail', { _order_id: DELIVERED_ORDER_ID });
		});

		test('追跡オフでも、配達済みの時刻は返し、delivery は返さない（追跡のリンクだけ）', async () => {
			process.env.TRACKING_17TRACK_API_KEY = 'test-only-key';
			arrange({ get_order_delivery_detail: { data: { enabled: false, fulfillments: [DETAIL_FULFILLMENT] }, error: null } });

			const { response, body } = await getDetail();

			expect(response.status).toBe(200);
			expect(body.shipments[0].deliveredAt).toBe('2026-04-05T03:00:00+00:00');
			expect(body.shipments[0]).not.toHaveProperty('delivery');
			expect(body.shipments[0].trackingUrl).toContain('1234-5678-9012');
		});

		test('一度も登録できずに止まった発送（ever_registered が偽）は、delivery を返さず、配達済みの時刻だけ返す', async () => {
			process.env.TRACKING_17TRACK_API_KEY = 'test-only-key';
			delete process.env.TRACKING_17TRACK_BASE_URL;
			const neverRegistered = { ...DETAIL_FULFILLMENT, registration: { ...DETAIL_FULFILLMENT.registration, stop_reason: 'expired', ever_registered: false } };
			arrange({ get_order_delivery_detail: { data: { enabled: true, fulfillments: [neverRegistered] }, error: null } });

			const { response, body } = await getDetail();

			expect(response.status).toBe(200);
			expect(body.shipments[0]).not.toHaveProperty('delivery');
			expect(body.shipments[0].deliveredAt).toBe('2026-04-05T03:00:00+00:00');
		});

		test('ever_registered が無い・真偽値でない答えは読めない答えとして 500 にする（推測で出し分けない）', async () => {
			process.env.TRACKING_17TRACK_API_KEY = 'test-only-key';
			const registration = Object.fromEntries(Object.entries(DETAIL_FULFILLMENT.registration).filter(([key]) => key !== 'ever_registered'));
			arrange({ get_order_delivery_detail: { data: { enabled: true, fulfillments: [{ ...DETAIL_FULFILLMENT, registration }] }, error: null } });
			const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

			const { response } = await getDetail();

			expect(response.status).toBe(500);
			consoleError.mockRestore();
		});

		test('鍵が無い間は、追跡オンで記録済みでも delivery を返さない', async () => {
			delete process.env.TRACKING_17TRACK_API_KEY;
			arrange({ get_order_delivery_detail: { data: { enabled: true, fulfillments: [DETAIL_FULFILLMENT] }, error: null } });

			const { body } = await getDetail();

			expect(body.shipments[0]).not.toHaveProperty('delivery');
			expect(body.shipments[0].deliveredAt).toBe('2026-04-05T03:00:00+00:00');
		});

		test('配送の記録の読み取りが失敗したら 500（no-store）で、空の履歴の偽の画面を返さない', async () => {
			process.env.TRACKING_17TRACK_API_KEY = 'test-only-key';
			arrange({ get_order_delivery_detail: { data: null, error: { message: 'down', code: '08006' } } });
			const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

			const { response, body } = await getDetail();

			expect(response.status).toBe(500);
			expect(response.headers.get('Cache-Control')).toBe('no-store');
			expect(body).toEqual({ error: 'Failed to fetch order detail' });
			consoleError.mockRestore();
		});
	});
});
