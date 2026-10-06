jest.mock('@/lib/mail', () => ({ sendMail: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));

import { sendMail } from '@/lib/mail';
import { logAudit } from '@/lib/audit';
import {
  backlogAlertMail,
  deadDigestMail,
  modeMismatchMail,
  recoveredOrdersMail,
  sendOpsAlertMail,
  signatureAlertMail,
  staleJobMail,
} from '@/lib/ops/ops-alert-mail';
import type { DeadEvent } from '@/lib/ops/ops-store';

const mockSendMail = sendMail as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;

function deadEvent(n: number): DeadEvent {
  return {
    eventId: `evt_${n}`,
    eventType: 'refund.updated',
    cause: 'unexpected_error',
    receivedAt: new Date('2026-10-05T00:00:00Z'),
    attemptCount: 9,
    deadAt: new Date('2026-10-05T04:15:00Z'),
  };
}

describe('店への知らせのメールの文面', () => {
  it('溜まり: 状態ごとの件数・いちばん古い受け取り・原因の記号を書く', () => {
    const mail = backlogAlertMail([
      { status: 'failed', count: 2, oldestReceivedAt: new Date('2026-10-05T00:00:00Z'), lastErrors: ['stripe_unavailable'] },
      { status: 'queued', count: 1, oldestReceivedAt: new Date('2026-10-05T00:10:00Z'), lastErrors: [] },
    ]);
    expect(mail.kind).toBe('webhook_backlog');
    expect(mail.subject).toBe('【要確認】Stripe の知らせの処理が遅れています');
    const body = mail.lines.join('\n');
    expect(body).toContain('やり直し待ち: 2件');
    expect(body).toContain('原因: stripe_unavailable');
    expect(body).toContain('処理待ち: 1件');
    expect(body).toContain('2026/10/05 9:00');
  });

  it('退避: 50件まで並べ、残りの件数と、見回りと照合が合わせることを書く', () => {
    const events = Array.from({ length: 50 }, (_, i) => deadEvent(i + 1));
    const mail = deadDigestMail(events, 60);
    expect(mail.kind).toBe('webhook_dead');
    expect(mail.subject).toBe('【要対応】処理を止めた Stripe の知らせ（60件）');
    const body = mail.lines.join('\n');
    expect(mail.lines.filter((line) => line.startsWith('- evt_'))).toHaveLength(50);
    expect(body).toContain('- evt_1（refund.updated） 原因: unexpected_error');
    expect(body).toContain('（ほかに 10 件。次の知らせで送ります）');
    expect(body).toContain('注文の状態は毎時の見回りが、返金と会計は毎晩の照合が Stripe に合わせます。');
  });

  it('遅れ: 定期処理の名前と、最後の成功の時刻を書く', () => {
    const sweep = staleJobMail('order_sweep', new Date('2026-10-05T01:00:00Z'));
    expect(sweep.kind).toBe('job_stale');
    expect(sweep.subject).toBe('【要確認】定期処理が止まっています（毎時の見回り）');
    expect(sweep.lines.join('\n')).toContain('2時間以上');
    const reconcile = staleJobMail('stripe_reconcile', new Date('2026-10-05T01:00:00Z'));
    expect(reconcile.subject).toBe('【要確認】定期処理が止まっています（毎晩の照合）');
    expect(reconcile.lines.join('\n')).toContain('25時間以上');
  });

  it('署名不正: 10分の件数と、合言葉を確かめる案内を書く', () => {
    const mail = signatureAlertMail(5);
    expect(mail.kind).toBe('webhook_signature_invalid');
    expect(mail.subject).toBe('【要確認】署名の合わない Stripe の知らせが届いています');
    const body = mail.lines.join('\n');
    expect(body).toContain('10分の間に、署名の合わない知らせが5件届きました');
    expect(body).toContain('設定が正しければ、外からの偽の知らせを断っているだけです。');
  });

  it('モード違い: 届いたモードと鍵のモードを書く', () => {
    const mail = modeMismatchMail(false, true);
    expect(mail.kind).toBe('webhook_mode_mismatch');
    expect(mail.subject).toBe('【要対応】Stripe の本番とテストの知らせが混ざっています');
    expect(mail.lines.join('\n')).toContain('届いた知らせ: テスト、このアプリの鍵: 本番');
    expect(modeMismatchMail(true, null).lines.join('\n')).toContain('このアプリの鍵: 不明');
  });

  it('支払いから作った注文: 注文番号と金額、在庫の理由が重なったことを書く', () => {
    const mail = recoveredOrdersMail([
      { orderId: '11111111-2222-3333-4444-555555555555', reviewReason: 'recovered_from_payment', totalAmount: 89000, currency: 'jpy' },
      { orderId: '66666666-7777-8888-9999-000000000000', reviewReason: 'stock_not_reserved', totalAmount: null, currency: null },
    ]);
    expect(mail.kind).toBe('orders_recovered_from_payment');
    expect(mail.subject).toBe('【要確認】支払いから作った注文（2件）');
    const body = mail.lines.join('\n');
    expect(body).toContain('89,000');
    expect(body).toContain('（在庫も確保できていません）');
    expect(body).toContain('お客様へ確認してください');
  });

  it('どの文面にもメールアドレスを入れない', () => {
    const mails = [
      backlogAlertMail([{ status: 'queued', count: 1, oldestReceivedAt: new Date(), lastErrors: [] }]),
      deadDigestMail([deadEvent(1)], 1),
      staleJobMail('order_sweep', new Date()),
      signatureAlertMail(5),
      modeMismatchMail(true, false),
      recoveredOrdersMail([{ orderId: '11111111-2222-3333-4444-555555555555', reviewReason: 'recovered_from_payment', totalAmount: 100, currency: 'jpy' }]),
    ];
    for (const mail of mails) {
      expect(`${mail.subject}\n${mail.lines.join('\n')}`).not.toMatch(/@/);
    }
  });
});

describe('sendOpsAlertMail', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, SHOP_ALERT_EMAIL: 'shop-alert@e2e.test', MAIL_FROM_ADDRESS: 'no-reply@e2e.test' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('SHOP_ALERT_EMAIL に件名と本文を送り、true を返す', async () => {
    mockSendMail.mockResolvedValueOnce({});
    await expect(sendOpsAlertMail(signatureAlertMail(5))).resolves.toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith({
      to: 'shop-alert@e2e.test',
      subject: '【要確認】署名の合わない Stripe の知らせが届いています',
      text: signatureAlertMail(5).lines.join('\n'),
    });
  });

  it('宛先か差出人が無ければ送らずに false', async () => {
    delete process.env.SHOP_ALERT_EMAIL;
    await expect(sendOpsAlertMail(signatureAlertMail(5))).resolves.toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('送れなければ false を返し、種類だけを監査に残す', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('send failed'));
    await expect(sendOpsAlertMail(signatureAlertMail(5))).resolves.toBe(false);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'ops.alert_mail',
      outcome: 'error',
      resource: 'ops_alert',
      detail: 'mail_send_failed',
      metadata: { kind: 'webhook_signature_invalid' },
    });
  });
});
