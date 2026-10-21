jest.mock('server-only', () => ({}), { virtual: true });
const mockAfter = jest.fn();
jest.mock('next/server', () => ({ after: (...args: unknown[]) => mockAfter(...args) }));
const mockRun = jest.fn();
jest.mock('@/lib/orders/tracking/delivery-worker', () => ({ runDeliveryTrackingWorker: (...args: unknown[]) => mockRun(...args) }));
import { scheduleDeliveryTracking } from '@/lib/orders/tracking/delivery-schedule';
beforeEach(() => jest.resetAllMocks());
afterEach(() => jest.restoreAllMocks());
test('afterで同じworkerを1回起動し、例外の本文をログへ出さない', async () => {
  mockRun.mockRejectedValue(new Error('raw本文 key signature number'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  scheduleDeliveryTracking(); expect(mockRun).not.toHaveBeenCalled();
  await mockAfter.mock.calls[0][0]();
  expect(mockRun).toHaveBeenCalledWith();
  expect(log.mock.calls).toEqual([['[delivery-tracking] inline worker run failed', 'Error']]);
});
test('afterが使えなくても投げず毎分の回復へ任せる', () => {
  mockAfter.mockImplementation(() => { throw new Error('raw本文'); });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(scheduleDeliveryTracking).not.toThrow();
  expect(warn.mock.calls).toEqual([['[delivery-tracking] inline worker was not scheduled', 'Error']]);
});
test('workerの同期例外もafterから漏らさず名前だけ残す', async () => {
  mockRun.mockImplementation(() => { throw new TypeError('raw本文'); });
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  scheduleDeliveryTracking(); await expect(mockAfter.mock.calls[0][0]()).resolves.toBeUndefined();
  expect(log.mock.calls).toEqual([['[delivery-tracking] inline worker run failed', 'TypeError']]);
});
