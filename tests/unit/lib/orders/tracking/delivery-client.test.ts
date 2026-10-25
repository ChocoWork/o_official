import { act, renderHook, waitFor } from '@testing-library/react';
import * as deliveryClient from '@/lib/orders/tracking/delivery-client';
import { DELIVERY_FORM_TEXT, useDeliverySubmission } from '@/lib/orders/tracking/delivery-client';
import type { DeliveryCallResult } from '@/lib/orders/tracking/delivery-types';

const REQUEST_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Body = { requestKey: string; value: string };

function setup(results: Array<DeliveryCallResult<{ id: string }>>) {
  const send = jest.fn<Promise<DeliveryCallResult<{ id: string }>>, [Body]>(async () => results.shift() ?? ({ kind: 'unknown' } as const));
  const handlers = { onSucceeded: jest.fn(), onClose: jest.fn(), onUncertain: jest.fn() };
  const view = renderHook(() => useDeliverySubmission<Body, { id: string }>({ send, ...handlers }));
  const submit = (value = 'a') => act(async () => { view.result.current.submit((requestKey) => ({ requestKey, value })); });
  return { send, view, submit, ...handlers };
}

// G-3 Task 7: 窓口を呼ぶ停止の道具（submitTrackingEdit・submitManualDelivered）は無くなった。窓口を呼ぶ道具は shipment-slip-client.ts だけに置く。
// 二重防止の番号と結果不明の再送の流れ（useDeliverySubmission）と画面の言葉は、発送票の2つのダイアログが使うので残る
describe('delivery-client の整理（G-3 Task 7）', () => {
  it('FREQ-534-AC-05: 停止の道具 submitTrackingEdit・submitManualDelivered は無く、useDeliverySubmission と DELIVERY_FORM_TEXT が残る', () => {
    expect(deliveryClient).not.toHaveProperty('submitTrackingEdit');
    expect(deliveryClient).not.toHaveProperty('submitManualDelivered');
    expect(typeof useDeliverySubmission).toBe('function');
    expect(DELIVERY_FORM_TEXT).toEqual({
      back: '戻る',
      saving: '保存しています…',
      checkAgain: 'もう一度確かめる',
      unknown: '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。',
    });
  });
});

describe('useDeliverySubmission（二重防止の番号と結果不明の再送）', () => {
  it('FREQ-534-AC-01: 本文は今の二重防止の番号を受け取って組み、成功したら onSucceeded（閉じるのは親）', async () => {
    const { send, view, submit, onSucceeded, onClose } = setup([{ kind: 'ok', data: { id: 'x' } }]);
    await submit();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual({ requestKey: expect.stringMatching(REQUEST_KEY_PATTERN), value: 'a' });
    expect(onSucceeded).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(view.result.current.busy).toBe(false);
    expect(view.result.current.uncertain).toBe(false);
  });

  it('FREQ-534-AC-01: 処理の前の断り（blocked）は番号も中身も保ち、文を出す。処理の中の断り（refused）は新しい番号にする', async () => {
    const { send, view, submit } = setup([
      { kind: 'blocked', message: 'ブロック' }, { kind: 'refused', message: '断り' }, { kind: 'ok', data: { id: 'x' } },
    ]);
    await submit();
    expect(view.result.current.message).toBe('ブロック');
    await submit();
    expect(view.result.current.message).toBe('断り');
    await submit();
    const keys = send.mock.calls.map(([body]) => body.requestKey);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('FREQ-534-AC-01: 結果不明は入力を止め、「もう一度確かめる」は保存した同じ中身・同じ番号だけを送り直す。閉じる時は親に読み直しを頼む', async () => {
    const { send, view, submit, onSucceeded, onClose, onUncertain } = setup([{ kind: 'unknown' }, { kind: 'ok', data: { id: 'x' } }]);
    await submit('first');
    expect(view.result.current.uncertain).toBe(true);
    await submit('second'); // 結果不明の間は新しい送信を受け付けない
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => { view.result.current.checkAgain(); });
    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
    expect(view.result.current.uncertain).toBe(false);

    const second = setup([{ kind: 'unknown' }]);
    await second.submit();
    act(() => second.view.result.current.close());
    expect(second.onUncertain).toHaveBeenCalledTimes(1);
    expect(second.onClose).toHaveBeenCalledTimes(1);
    expect(onUncertain).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
