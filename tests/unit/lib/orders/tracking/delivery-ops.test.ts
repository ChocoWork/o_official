jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/ops/ops-store', () => ({ claimAlert: jest.fn(), releaseAlert: jest.fn(), bumpSignal: jest.fn() }));
jest.mock('@/lib/ops/ops-alert-mail', () => ({ sendOpsAlertMail: jest.fn() }));
import { reportDeliveryTrackingIssue, type DeliveryOpsKind } from '@/lib/orders/tracking/delivery-ops';
import { claimAlert, releaseAlert, bumpSignal, type OpsStore } from '@/lib/ops/ops-store';
import { sendOpsAlertMail } from '@/lib/ops/ops-alert-mail';
const store = {} as OpsStore;
const claim = { key: 'delivery_tracking_account_error' as const, claimedAt: '2026-10-21T00:00:00Z', previousSentAt: null };
beforeEach(() => { jest.resetAllMocks(); jest.mocked(claimAlert).mockResolvedValue(claim); jest.mocked(sendOpsAlertMail).mockResolvedValue(true); });
afterEach(() => jest.restoreAllMocks());
test('accountの失敗を1日1回だけ知らせる', async () => {
  jest.mocked(claimAlert).mockResolvedValueOnce(claim).mockResolvedValueOnce(null);
  await reportDeliveryTrackingIssue(store, 'account_error'); await reportDeliveryTrackingIssue(store, 'account_error');
  expect(claimAlert).toHaveBeenCalledWith(store, 'delivery_tracking_account_error', 86400);
  expect(sendOpsAlertMail).toHaveBeenCalledTimes(1);
});
test('署名401は10分5回で1日1回の知らせ', async () => {
  jest.mocked(bumpSignal).mockResolvedValueOnce(4).mockResolvedValueOnce(5);
  await reportDeliveryTrackingIssue(store, 'signature_invalid'); expect(sendOpsAlertMail).toHaveBeenCalledTimes(0);
  await reportDeliveryTrackingIssue(store, 'signature_invalid'); expect(sendOpsAlertMail).toHaveBeenCalledTimes(1);
  expect(bumpSignal).toHaveBeenCalledWith(store, 'delivery_tracking_signature_invalid', 600);
  expect(claimAlert).toHaveBeenCalledWith(store, 'delivery_tracking_signature_invalid', 86400);
});
test.each(['account_error', 'key_missing', 'read_failed', 'unknown_status'] as const)('%sは種類ごと1日、固定文だけで知らせる', async (kind: DeliveryOpsKind) => {
  await reportDeliveryTrackingIssue(store, kind);
  expect(claimAlert).toHaveBeenCalledWith(store, `delivery_tracking_${kind}`, 86400);
  expect(bumpSignal).not.toHaveBeenCalled();
  const mail = jest.mocked(sendOpsAlertMail).mock.calls[0][0];
  expect(mail.kind).toBe(`delivery_tracking_${kind}`); expect(mail.subject).toContain('配送の追跡');
  expect(JSON.stringify(mail)).not.toMatch(/raw本文|unit-key|signature-value|UNIT-1/);
});
test.each([false, 'throw'] as const)('送信失敗%sではclaimを返す', async (mode) => {
  if (mode === false) jest.mocked(sendOpsAlertMail).mockResolvedValue(false);
  else jest.mocked(sendOpsAlertMail).mockRejectedValue(new Error('raw本文 key signature number'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  await reportDeliveryTrackingIssue(store, 'account_error'); expect(releaseAlert).toHaveBeenCalledWith(store, claim);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/raw本文|signature|number/);
});
