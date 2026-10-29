/** @jest-environment node */
import { runInThisContext } from 'node:vm';
import { readDiscountFailure } from '@/features/discounts/discount-admin-client';
jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
test.each([401, 403, 429, 503])('FREQ-547-AC-05: 実物のResponseとReadableStreamの%i本文を最後まで読む', async (status) => {
  let pulls = 0; let ended = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) controller.enqueue(new TextEncoder().encode('{"error":'));
      else if (pulls === 2) controller.enqueue(new TextEncoder().encode('"private body"}'));
      else { ended = true; controller.close(); }
    },
  }, { highWaterMark: 0 });
  // The repo setup replaces Response with node-fetch v2, which does not accept web streams. Use Node's real fetch Response.
  const NativeResponse = runInThisContext('Response') as typeof Response;
  const response = new NativeResponse(stream, { status });
  const result = await readDiscountFailure(response, '失敗', '権限なし');
  expect(result.status).toBe(status);
  expect(result.message).not.toContain('private body');
  expect(response.bodyUsed).toBe(true);
  expect(ended).toBe(true);
  expect(pulls).toBe(3);
});
