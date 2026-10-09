const mockAfter = jest.fn();
jest.mock('next/server', () => ({ after: (...args: unknown[]) => mockAfter(...args) }));
const mockRun = jest.fn();
jest.mock('@/lib/orders/email/order-email-worker', () => ({
  runOrderEmailWorker: (...args: unknown[]) => mockRun(...args),
}));

import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';

describe('scheduleOrderEmailDelivery', () => {
  beforeEach(() => jest.clearAllMocks());

  it('返事の後に worker を1回動かす。失敗はログだけにする', async () => {
    mockRun.mockRejectedValue(new Error('boom'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    scheduleOrderEmailDelivery();
    await (mockAfter.mock.calls[0][0] as () => Promise<void>)();

    expect(mockRun).toHaveBeenCalledWith();
    expect(error).toHaveBeenCalledWith('[order-email] inline worker run failed', 'Error');
    error.mockRestore();
  });

  it('リクエストの外（after が使えない）では投げずに、毎分の定期処理に任せる', () => {
    mockAfter.mockImplementation(() => {
      throw new Error('after() was called outside a request scope');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => scheduleOrderEmailDelivery()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[order-email] inline delivery was not scheduled', 'Error');
    warn.mockRestore();
  });
});
