jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/ops/ops-alert-mail', () => ({
  siteUrlInvalidMail: () => ({ kind: 'site_url_invalid', subject: 'fixed subject', lines: ['fixed body'] }),
  sendOpsAlertMail: jest.fn().mockResolvedValue(true),
}));
const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(async () => ({ rpc: mockRpc })) }));

import { notifySiteUrlInvalid } from '@/lib/ops/site-url-alert';
import { sendOpsAlertMail } from '@/lib/ops/ops-alert-mail';
import { logAudit } from '@/lib/audit';

describe('サイトの住所が不正な時の店への知らせ', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRpc.mockResolvedValue({ data: [{ claimed: true, claimed_at: '2026-10-23T00:00:00Z', previous_sent_at: null }], error: null });
    jest.mocked(sendOpsAlertMail).mockResolvedValue(true);
  });

  it('種類ごとに1時間に1回までの既存の権利を取って知らせる', async () => {
    await notifySiteUrlInvalid();
    expect(mockRpc).toHaveBeenCalledWith('claim_ops_alert', { _alert_key: 'site_url_invalid', _cooldown_seconds: 3600 });
    expect(sendOpsAlertMail).toHaveBeenCalledTimes(1);
    mockRpc.mockResolvedValue({ data: [{ claimed: false }], error: null });
    await notifySiteUrlInvalid();
    expect(sendOpsAlertMail).toHaveBeenCalledTimes(1);
  });

  it('宛先なしや送信失敗では権利を返す', async () => {
    jest.mocked(sendOpsAlertMail).mockResolvedValue(false);
    await notifySiteUrlInvalid();
    expect(mockRpc).toHaveBeenLastCalledWith('release_ops_alert', {
      _alert_key: 'site_url_invalid', _claimed_at: '2026-10-23T00:00:00Z', _previous_sent_at: null,
    });
  });

  it('DBが失敗しても認証の返事を壊さず固定の記号だけを監査する', async () => {
    mockRpc.mockRejectedValue(new Error('sensitive failure'));
    await expect(notifySiteUrlInvalid()).resolves.toBeUndefined();
    expect(sendOpsAlertMail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'ops.alert_mail', resource: 'ops_alert', outcome: 'error', detail: 'site_url_invalid_alert_failed', metadata: { kind: 'site_url_invalid' },
    });
  });
});
