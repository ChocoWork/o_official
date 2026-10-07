import {
  MODE_MISMATCH_ALERT,
  SIGNATURE_ALERT,
  recordModeMismatch,
  recordSignatureFailure,
} from '@/lib/ops/webhook-receiver-signals';
import type { OpsStore } from '@/lib/ops/ops-store';
import type { OpsAlertMail } from '@/lib/ops/ops-alert-mail';

function store(responses: { bump?: number; claimed?: boolean; bumpError?: boolean }) {
  const rpc = jest.fn(async (name: string) => {
    if (name === 'bump_ops_signal') {
      return responses.bumpError ? { data: null, error: { message: 'db down' } } : { data: responses.bump ?? 1, error: null };
    }
    if (name === 'claim_ops_alert') {
      return responses.claimed
        ? { data: [{ claimed: true, claimed_at: '2026-10-05T00:00:00Z', previous_sent_at: null }], error: null }
        : { data: [{ claimed: false, claimed_at: null, previous_sent_at: '2026-10-05T00:00:00Z' }], error: null };
    }
    return { data: true, error: null };
  });
  return { store: { rpc } as unknown as OpsStore, rpc };
}

describe('受け取り口の署名不正とモード違い', () => {
  it('数の決まり: 署名不正は10分に5件、モード違いは1件でも。どちらも1時間に1回まで', () => {
    expect(SIGNATURE_ALERT).toEqual({ key: 'webhook_signature_invalid', windowSeconds: 600, threshold: 5, cooldownSeconds: 3600 });
    expect(MODE_MISMATCH_ALERT).toEqual({ key: 'webhook_mode_mismatch', windowSeconds: 3600, threshold: 1, cooldownSeconds: 3600 });
  });

  it('署名不正が4件目までは数えるだけで、送る権利も取らない', async () => {
    const { store: s, rpc } = store({ bump: 4 });
    const send = jest.fn();
    await recordSignatureFailure({ store: s, send });
    expect(rpc).toHaveBeenCalledWith('bump_ops_signal', { _alert_key: 'webhook_signature_invalid', _window_seconds: 600 });
    expect(rpc).not.toHaveBeenCalledWith('claim_ops_alert', expect.anything());
    expect(send).not.toHaveBeenCalled();
  });

  it('5件目で権利が取れれば1回だけ送る', async () => {
    const { store: s } = store({ bump: 5, claimed: true });
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);
    await recordSignatureFailure({ store: s, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].kind).toBe('webhook_signature_invalid');
    expect(send.mock.calls[0][0].lines.join('\n')).toContain('5件');
  });

  it('1時間以内に送っていれば送らない', async () => {
    const { store: s, rpc } = store({ bump: 5, claimed: false });
    const send = jest.fn();
    await recordSignatureFailure({ store: s, send });
    expect(rpc).toHaveBeenCalledWith('claim_ops_alert', { _alert_key: 'webhook_signature_invalid', _cooldown_seconds: 3600 });
    expect(send).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith('release_ops_alert', expect.anything());
  });

  it('しきい値を超えた6件目からは、送る権利を取りにいかない（窓ごとに1回だけ取りにいく）', async () => {
    const { store: s, rpc } = store({ bump: 6, claimed: true });
    const send = jest.fn();
    await recordSignatureFailure({ store: s, send });
    expect(rpc).toHaveBeenCalledWith('bump_ops_signal', { _alert_key: 'webhook_signature_invalid', _window_seconds: 600 });
    expect(rpc).not.toHaveBeenCalledWith('claim_ops_alert', expect.anything());
    expect(send).not.toHaveBeenCalled();
  });

  it('しきい値ちょうどの5件目では、送る権利を1回だけ取りにいく', async () => {
    const { store: s, rpc } = store({ bump: 5, claimed: true });
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);
    await recordSignatureFailure({ store: s, send });
    expect(rpc.mock.calls.filter(([name]) => name === 'claim_ops_alert')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('送れなくても権利を返さず、続く署名不正では送り直さない', async () => {
    let lastSentAt: string | null = null;
    const rpc = jest.fn(async (name: string) => {
      if (name === 'bump_ops_signal') return { data: 5, error: null };
      if (name === 'claim_ops_alert') {
        if (lastSentAt !== null) {
          return { data: [{ claimed: false, claimed_at: null, previous_sent_at: lastSentAt }], error: null };
        }
        lastSentAt = '2026-10-05T00:00:00Z';
        return { data: [{ claimed: true, claimed_at: lastSentAt, previous_sent_at: null }], error: null };
      }
      if (name === 'release_ops_alert') lastSentAt = null;
      return { data: true, error: null };
    });
    const s: OpsStore = { rpc };
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(false);

    for (let i = 0; i < 5; i++) await recordSignatureFailure({ store: s, send });

    expect(send).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalledWith('release_ops_alert', expect.anything());
  });

  it('送信が例外になっても権利を返さず、エラーの種類だけを記録する', async () => {
    const { store: s, rpc } = store({ bump: 5, claimed: true });
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockRejectedValue(new Error('boom'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(recordSignatureFailure({ store: s, send })).resolves.toBeUndefined();
      expect(rpc).not.toHaveBeenCalledWith('release_ops_alert', expect.anything());
      expect(errorSpy).toHaveBeenCalledWith('[webhook] Failed to record signature failure', 'Error');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('モード違いは1件目で送り、届いたモードと鍵のモードを書く', async () => {
    const { store: s } = store({ bump: 1, claimed: true });
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);
    await recordModeMismatch({ store: s, send }, false, true);
    expect(send.mock.calls[0][0].kind).toBe('webhook_mode_mismatch');
    expect(send.mock.calls[0][0].lines.join('\n')).toContain('届いた知らせ: テスト、このアプリの鍵: 本番');
  });

  it('モード違いも、1件目だけ送る権利を取りにいき、2件目以降は取りにいかない', async () => {
    const first = store({ bump: 1, claimed: true });
    await recordModeMismatch({ store: first.store, send: jest.fn().mockResolvedValue(true) }, false, true);
    expect(first.rpc.mock.calls.filter(([name]) => name === 'claim_ops_alert')).toHaveLength(1);

    const second = store({ bump: 2, claimed: true });
    const send = jest.fn();
    await recordModeMismatch({ store: second.store, send }, false, true);
    expect(second.rpc).not.toHaveBeenCalledWith('claim_ops_alert', expect.anything());
    expect(send).not.toHaveBeenCalled();
  });

  it('DB の失敗は外へ出さない（受け取り口の返事を壊さない）', async () => {
    const { store: s } = store({ bumpError: true });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordSignatureFailure({ store: s, send: jest.fn() })).resolves.toBeUndefined();
    await expect(recordModeMismatch({ store: s, send: jest.fn() }, true, false)).resolves.toBeUndefined();
  });
});
