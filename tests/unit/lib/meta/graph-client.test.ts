jest.mock('server-only', () => ({}), { virtual: true });

import { metaGraphGetAll } from '@/lib/meta/graph-client';

describe('metaGraphGetAll', () => {
	beforeEach(() => {
		global.fetch = jest.fn();
	});

	it('follows paging.next until every page has been collected', async () => {
		(global.fetch as jest.Mock)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [{ id: 'first' }],
					paging: { next: 'https://graph.facebook.com/v25.0/items?after=cursor' },
				}),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ data: [{ id: 'second' }] }),
			});

		const rows = await metaGraphGetAll<{ id: string }>(
			'graph.facebook.com',
			'v25.0',
			'items',
			'access-token',
			{ limit: '100' },
		);

		expect(rows).toEqual([{ id: 'first' }, { id: 'second' }]);
		expect(global.fetch).toHaveBeenCalledTimes(2);
		expect(global.fetch).toHaveBeenNthCalledWith(
			2,
			new URL('https://graph.facebook.com/v25.0/items?after=cursor'),
			expect.objectContaining({
				headers: { Authorization: 'Bearer access-token' },
			}),
		);
	});

	it('rejects a paging URL outside the allowed Meta Graph hosts', async () => {
		(global.fetch as jest.Mock).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: [{ id: 'first' }],
				paging: { next: 'https://attacker.example/steal-token' },
			}),
		});

		await expect(metaGraphGetAll(
			'graph.facebook.com',
			'v25.0',
			'items',
			'access-token',
		)).rejects.toThrow('Invalid Meta Graph paging URL');
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});
});
