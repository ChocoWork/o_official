jest.mock('@/lib/mail', () => ({ sendMail: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));

import { sendMail } from '@/lib/mail';
import { logAudit } from '@/lib/audit';
import {
  backlogAlertMail,
  deadDigestMail,
  modeMismatchMail,
  reconcileFindingsMail,
  recoveredOrdersMail,
  sendOpsAlertMail,
  signatureAlertMail,
  staleJobMail,
} from '@/lib/ops/ops-alert-mail';
import type { DeadEvent } from '@/lib/ops/ops-store';
import type { StripeReconciliationError, UnmatchedRecentPayment } from '@/lib/stripe/reconcile-orders';

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

  it('退避: 渡された知らせを並べ、残りの件数と、見回りと照合が合わせること（注文を作るのは直近24時間まで）を書く', () => {
    const events = Array.from({ length: 50 }, (_, i) => deadEvent(i + 1));
    const mail = deadDigestMail(events, 60);
    expect(mail.kind).toBe('webhook_dead');
    expect(mail.subject).toBe('【要対応】処理を止めた Stripe の知らせ（60件）');
    const body = mail.lines.join('\n');
    expect(mail.lines.filter((line) => line.startsWith('- evt_'))).toHaveLength(50);
    expect(body).toContain('- evt_1（refund.updated） 原因: unexpected_error');
    expect(body).toContain('（ほかに 10 件。次の知らせで送ります）');
    expect(mail.lines).toContain('注文の状態は毎時の見回りが、返金と会計は毎晩の照合が Stripe に合わせます。ただし、見回りが注文を作るのは、直近24時間の Checkout Session の支払いだけです。');
    expect(mail.lines).toContain('それより古い、注文の無い支払いは、直近7日の分を毎晩の照合のメールでお知らせします。');
  });

  it.each([
    'stripe_unavailable',
    'db_unavailable',
    'not_converged',
    'lease_expired',
    'invalid_payload',
    'unexpected_error',
  ])('溜まりと退避: 原因の記号 %s をそのまま書く', (cause) => {
    const backlog = backlogAlertMail([
      { status: 'failed', count: 1, oldestReceivedAt: new Date('2026-10-05T00:00:00Z'), lastErrors: [cause] },
    ]);
    const dead = deadDigestMail([{ ...deadEvent(1), cause }], 1);
    expect(backlog.lines.join('\n')).toContain(`原因: ${cause}`);
    expect(dead.lines.join('\n')).toContain(`原因: ${cause}`);
  });

  it('溜まり: 原因の自由文は unexpected_error にしてメールアドレスを載せない', () => {
    const mail = backlogAlertMail([
      { status: 'failed', count: 2, oldestReceivedAt: new Date('2026-10-05T00:00:00Z'), lastErrors: ['stripe_unavailable', 'Error: buyer@example.com'] },
    ]);
    const body = `${mail.subject}\n${mail.lines.join('\n')}`;
    expect(body).toContain('原因: stripe_unavailable、unexpected_error');
    expect(body).not.toContain('Error: buyer@example.com');
    expect(body).not.toContain('buyer@example.com');
  });

  it.each(['Error: buyer@example.com', null])('退避: 原因 %s は unexpected_error にしてメールアドレスを載せない', (cause) => {
    const mail = deadDigestMail([{ ...deadEvent(1), cause }], 1);
    const body = `${mail.subject}\n${mail.lines.join('\n')}`;
    expect(body).toContain('原因: unexpected_error');
    expect(body).not.toContain('Error: buyer@example.com');
    expect(body).not.toContain('buyer@example.com');
  });

  it('遅れ: 定期処理の名前と、最後の成功の時刻を書く', () => {
    const sweep = staleJobMail('order_sweep', new Date('2026-10-05T01:00:00Z'));
    expect(sweep.kind).toBe('job_stale');
    expect(sweep.subject).toBe('【要確認】定期処理が止まっています（毎時の見回り）');
    expect(sweep.lines.join('\n')).toContain('2時間以上');
    expect(sweep.lines.join('\n')).toContain('最後の成功: 2026/10/05 10:00');
    const reconcile = staleJobMail('stripe_reconcile', new Date('2026-10-05T01:00:00Z'));
    expect(reconcile.subject).toBe('【要確認】定期処理が止まっています（毎晩の照合）');
    expect(reconcile.lines.join('\n')).toContain('25時間以上');
    expect(reconcile.lines.join('\n')).toContain('最後の成功: 2026/10/05 10:00');
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
    expect(mail.lines).toContain('モードの違う知らせは処理していません（この知らせは1時間に1回までなので、続けて届いた分は書いていません）。');
    expect(modeMismatchMail(true, null).lines.join('\n')).toContain('このアプリの鍵: 不明');
  });

  it('支払いから作った注文: 注文番号と金額、在庫の理由が重なったことを書く', () => {
    const mail = recoveredOrdersMail([
      { orderId: '11111111-2222-3333-4444-555555555555', reviewReason: 'recovered_from_payment', totalAmount: 89000, currency: 'jpy' },
      { orderId: '66666666-7777-8888-9999-000000000000', reviewReason: 'stock_not_reserved', totalAmount: null, currency: 'jpy' },
      { orderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', reviewReason: 'recovered_from_payment', totalAmount: 1200, currency: null },
    ]);
    expect(mail.kind).toBe('orders_recovered_from_payment');
    expect(mail.subject).toBe('【要確認】支払いから作った注文（3件）');
    const body = mail.lines.join('\n');
    expect(body).toContain('89,000');
    expect(body).toContain('（在庫も確保できていません）');
    expect(body).toContain('お客様へ確認してください');
    const orderLines = mail.lines.filter((line) => line.startsWith('- 注文番号 '));
    expect(orderLines).toHaveLength(3);
    expect(orderLines[0]).toContain('注文番号 ORD-11111111');
    expect(orderLines[0]).toContain('89,000');
    expect(orderLines[0]).not.toContain('（在庫も確保できていません）');
    expect(orderLines[1]).toBe('- 注文番号 ORD-66666666 金額不明（在庫も確保できていません）');
    expect(orderLines[2]).toBe('- 注文番号 ORD-AAAAAAAA 金額不明');
    expect(orderLines[2]).not.toContain('（在庫も確保できていません）');
    const stockGuidance = '在庫を確保できていない注文は、先に在庫の手当てをしてください。';
    expect(mail.lines).toContain(stockGuidance);
    expect(mail.lines.indexOf(stockGuidance)).toBeGreaterThan(mail.lines.indexOf(orderLines[2]));
    expect(mail.lines.indexOf(stockGuidance)).toBeLessThan(mail.lines.indexOf('管理画面の ORDER タブの「要対応・要確認」で、確認したら確認済みにしてください。'));
  });

  it('支払いから作った注文: 自動メールの送信と決済画面で完了を見ていない可能性を案内する', () => {
    const mail = recoveredOrdersMail([
      { orderId: '11111111-2222-3333-4444-555555555555', reviewReason: 'recovered_from_payment', totalAmount: 89000, currency: 'jpy' },
    ]);
    expect(mail.lines).toContain('お客様には注文確定（またはお支払い待ち）のメールが自動で届いていますが、決済の画面で注文の完了を見ていない可能性があります。注文の内容をお客様へ確認してください。');
  });

  it('支払いから作った注文: 在庫未確保の注文が無ければ在庫の案内を書かない', () => {
    const mail = recoveredOrdersMail([
      { orderId: '11111111-2222-3333-4444-555555555555', reviewReason: 'recovered_from_payment', totalAmount: 89000, currency: 'jpy' },
    ]);
    expect(mail.lines.join('\n')).not.toContain('（在庫も確保できていません）');
    expect(mail.lines).not.toContain('在庫を確保できていない注文は、先に在庫の手当てをしてください。');
  });

  it('支払いから作った注文: 要確認の印を付けられなかった注文（reviewReason が null）の行にだけ、その旨と管理画面に出ないことを書く', () => {
    const note = '（要確認の印を付けられませんでした。管理画面の「要対応・要確認」には出ません）';
    const mail = recoveredOrdersMail([
      { orderId: '11111111-2222-3333-4444-555555555555', reviewReason: null, totalAmount: 89000, currency: 'jpy' },
      { orderId: '66666666-7777-8888-9999-000000000000', reviewReason: 'recovered_from_payment', totalAmount: 1200, currency: 'jpy' },
    ]);
    const orderLines = mail.lines.filter((line) => line.startsWith('- 注文番号 '));
    expect(orderLines).toHaveLength(2);
    expect(orderLines[0]).toContain('注文番号 ORD-11111111');
    expect(orderLines[0]).toContain('89,000');
    expect(orderLines[0].endsWith(note)).toBe(true);
    expect(orderLines[1]).toContain('注文番号 ORD-66666666');
    expect(orderLines[1]).not.toContain('印を付けられませんでした');
    expect(mail.lines.filter((line) => line.includes(note))).toHaveLength(1);
    // 印を付けられなかった注文の在庫の状態は分からないので、在庫については何も言わない
    expect(mail.lines.join('\n')).not.toContain('（在庫も確保できていません）');
    expect(mail.lines).not.toContain('在庫を確保できていない注文は、先に在庫の手当てをしてください。');
  });

  it('支払いから作った注文: 通貨が2文字でも例外を出さず金額を書く', () => {
    const orders = [{
      orderId: '11111111-2222-3333-4444-555555555555',
      reviewReason: 'recovered_from_payment' as const,
      totalAmount: 89000,
      currency: 'jp',
    }];
    expect(() => recoveredOrdersMail(orders)).not.toThrow();
    expect(recoveredOrdersMail(orders).lines).toContain('- 注文番号 ORD-11111111 ¥89,000');
  });

  describe('照合で見つかったこと', () => {
    const created = Date.parse('2026-10-05T00:00:00Z') / 1000;
    const payment = (n: number): UnmatchedRecentPayment => ({ id: `pi_${n}`, amount: 1000 + n, currency: 'jpy', created });
    const failure = (n: number): StripeReconciliationError => ({ sourceId: `po_${n}`, reason: 'stripe_unavailable' });

    it('件名に注文なしと失敗の件数を書き、支払いと失敗を1行ずつ並べる', () => {
      const mail = reconcileFindingsMail({
        unmatched: [
          { id: 'pi_1', amount: 89000, currency: 'jpy', created },
          { id: 'pi_2', amount: 1200, currency: 'jpy', created: Date.parse('2026-10-05T01:30:00Z') / 1000 },
        ],
        errors: [
          { sourceId: 'pi_9', reason: 'stripe_unavailable' },
          { sourceId: 'po_1', reason: 'db_unavailable' },
          { sourceId: 'po_2', reason: 'not_converged' },
        ],
      });

      expect(mail.kind).toBe('reconcile_findings');
      expect(mail.subject).toBe('【要確認】毎晩の照合で注文の無い支払い・失敗が見つかりました（注文なし 2件・失敗 3件）');
      const items = mail.lines.filter((line) => line.startsWith('- '));
      expect(items).toHaveLength(5);
      expect(items[0]).toContain('pi_1');
      expect(items[0]).toContain('89,000');
      expect(items[0]).toContain('2026/10/05 9:00');
      expect(items[1]).toContain('pi_2');
      expect(items[1]).toContain('1,200');
      expect(items[1]).toContain('2026/10/05 10:30');
      expect(items.slice(2)).toEqual([
        '- pi_9 原因: stripe_unavailable',
        '- po_1 原因: db_unavailable',
        '- po_2 原因: not_converged',
      ]);
    });

    it('何が起きたかを書く（支払い済みで注文が無いこと、支払いや入金を合わせられなかったこと）', () => {
      const body = reconcileFindingsMail({ unmatched: [payment(1)], errors: [failure(1)] }).lines.join('\n');
      expect(body).toContain('Stripe には成功した支払いがあるのに、注文がありません');
      expect(body).toContain('お客様は支払い済みで、注文が無い状態です');
      expect(body).toContain('支払いや入金を Stripe と合わせられませんでした');
    });

    it('支払いも失敗も20行まで書き、残りは「（ほかに N 件）」にまとめる。件名の件数は全件', () => {
      const mail = reconcileFindingsMail({
        unmatched: Array.from({ length: 25 }, (_, i) => payment(i + 1)),
        errors: Array.from({ length: 23 }, (_, i) => failure(i + 1)),
      });

      expect(mail.subject).toContain('（注文なし 25件・失敗 23件）');
      expect(mail.lines.filter((line) => line.startsWith('- pi_'))).toHaveLength(20);
      expect(mail.lines.filter((line) => line.startsWith('- po_'))).toHaveLength(20);
      expect(mail.lines).toContain('（ほかに 5 件）');
      expect(mail.lines).toContain('（ほかに 3 件）');
      const body = mail.lines.join('\n');
      expect(body).not.toContain('pi_21');
      expect(body).not.toContain('po_21');
    });

    it('20件ちょうどはそのまま書き、21件目から「（ほかに 1 件）」にする', () => {
      const exact = reconcileFindingsMail({ unmatched: Array.from({ length: 20 }, (_, i) => payment(i + 1)), errors: [] });
      expect(exact.lines.filter((line) => line.startsWith('- pi_'))).toHaveLength(20);
      expect(exact.lines.join('\n')).not.toContain('ほかに');

      const over = reconcileFindingsMail({ unmatched: Array.from({ length: 21 }, (_, i) => payment(i + 1)), errors: [] });
      expect(over.lines.filter((line) => line.startsWith('- pi_'))).toHaveLength(20);
      expect(over.lines).toContain('（ほかに 1 件）');
    });

    it('支払いだけのときは失敗の見出しを書かず、失敗だけのときは支払いの見出しを書かない', () => {
      const onlyPayments = reconcileFindingsMail({ unmatched: [payment(1)], errors: [] });
      expect(onlyPayments.subject).toContain('（注文なし 1件・失敗 0件）');
      expect(onlyPayments.lines.join('\n')).not.toContain('合わせられなかった');

      const onlyErrors = reconcileFindingsMail({ unmatched: [], errors: [failure(1)] });
      expect(onlyErrors.subject).toContain('（注文なし 0件・失敗 1件）');
      expect(onlyErrors.lines.join('\n')).not.toContain('注文がありません');
      expect(onlyErrors.lines.filter((line) => line.startsWith('- '))).toEqual(['- po_1 原因: stripe_unavailable']);
    });

    it('次にやること: Stripe のダッシュボードで確かめ、注文が無ければお客様へ連絡して注文を作るか返金し、手順書の見出しを指す', () => {
      const body = reconcileFindingsMail({ unmatched: [payment(1)], errors: [] }).lines.join('\n');
      expect(body).toContain('Stripe のダッシュボードで');
      expect(body).toContain('お客様に連絡して、注文を作るか返金してください');
      expect(body).toContain('手順書（docs/06_Operations/webhook-queue-operations.md）の「照合で見つかったことの知らせが来たとき」');
    });

    it('お客様の名前・住所・メールアドレスは、渡されても書かない。原因の自由文は unexpected_error にする', () => {
      const payments = [{
        ...payment(1),
        receipt_email: 'buyer@example.com',
        shipping: { name: '山田 太郎', address: { line1: '渋谷区1-2-3' } },
        billing_details: { name: '山田 花子', email: 'buyer@example.com' },
      }];
      const errors = [{ sourceId: 'pi_9', reason: 'Error: buyer@example.com' }] as unknown as StripeReconciliationError[];

      const mail = reconcileFindingsMail({ unmatched: payments, errors });

      const body = `${mail.subject}\n${mail.lines.join('\n')}`;
      expect(body).not.toMatch(/@|buyer|山田|渋谷/);
      expect(body).toContain('- pi_9 原因: unexpected_error');
    });
  });

  it('どの文面にもメールアドレスを入れない', () => {
    const mails = [
      backlogAlertMail([{ status: 'queued', count: 1, oldestReceivedAt: new Date(), lastErrors: [] }]),
      deadDigestMail([deadEvent(1)], 1),
      staleJobMail('order_sweep', new Date()),
      signatureAlertMail(5),
      modeMismatchMail(true, false),
      recoveredOrdersMail([{ orderId: '11111111-2222-3333-4444-555555555555', reviewReason: 'recovered_from_payment', totalAmount: 100, currency: 'jpy' }]),
      reconcileFindingsMail({
        unmatched: [{ id: 'pi_1', amount: 100, currency: 'jpy', created: Date.parse('2026-10-05T00:00:00Z') / 1000 }],
        errors: [{ sourceId: 'po_1', reason: 'stripe_unavailable' }],
      }),
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
    const to = process.env.SHOP_ALERT_EMAIL;
    const from = process.env.MAIL_FROM_ADDRESS;
    try {
      delete process.env.SHOP_ALERT_EMAIL;
      await expect(sendOpsAlertMail(signatureAlertMail(5))).resolves.toBe(false);
      expect(mockSendMail).not.toHaveBeenCalled();

      process.env.SHOP_ALERT_EMAIL = to;
      delete process.env.MAIL_FROM_ADDRESS;
      await expect(sendOpsAlertMail(signatureAlertMail(5))).resolves.toBe(false);
      expect(mockSendMail).not.toHaveBeenCalled();
    } finally {
      if (to === undefined) delete process.env.SHOP_ALERT_EMAIL;
      else process.env.SHOP_ALERT_EMAIL = to;
      if (from === undefined) delete process.env.MAIL_FROM_ADDRESS;
      else process.env.MAIL_FROM_ADDRESS = from;
    }
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
