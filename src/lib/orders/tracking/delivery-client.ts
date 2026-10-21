import { useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { DELIVERY_ERROR_MESSAGES } from '@/lib/orders/tracking/delivery-messages';
import type {
  DeliveryCallResult,
  MarkDeliveredInput,
  MarkDeliveredResult,
  UpdateTrackingInput,
  UpdateTrackingResult,
} from '@/lib/orders/tracking/delivery-types';

/**
 * 管理画面（ブラウザ）から、伝票番号を直す窓口と、配達済みにする窓口（POST。計画の C-3）を呼ぶ道具と、
 * 直す画面・配達済みの画面が共有する「二重防止の番号と結果不明の再送」の流れ。
 * clientFetch を使うのでブラウザだけで動く。サーバーからは import しない。
 */

// 画面の言葉は計画の C-5・C-4 のとおり（句点を足し引きしない）
export const DELIVERY_FORM_TEXT = {
  back: '戻る',
  saving: '保存しています…',
  checkAgain: 'もう一度確かめる',
  unknown: '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。',
} as const;

const UNAUTHENTICATED_MESSAGE = '認証が必要です。再ログインしてください。';
// 管理画面の隣の操作と同じ文
const FORBIDDEN_MESSAGE = 'この操作の権限がありません。';
const RATE_LIMITED_MESSAGE = 'しばらくしてから、もう一度お試しください。';
const REFUSED_FALLBACK_MESSAGE = DELIVERY_ERROR_MESSAGES.DELIVERY_ARGUMENT_INVALID.message;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 窓口が日本語で返す断りの文（`{ error }`）。文字でない・空・長すぎる時は使わない */
function ownErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const { error } = body;
  return typeof error === 'string' && error.length > 0 && error.length <= 200 ? error : null;
}

function readTrackingResult(data: unknown): UpdateTrackingResult | null {
  if (!isRecord(data)) return null;
  const { trackingChangeId, trackingVersion, replayed } = data;
  return typeof trackingChangeId === 'string' && typeof trackingVersion === 'number' && typeof replayed === 'boolean'
    ? { trackingChangeId, trackingVersion, replayed }
    : null;
}

function readDeliveredResult(data: unknown): MarkDeliveredResult | null {
  if (!isRecord(data)) return null;
  const { eventId, deliveredAt, replayed } = data;
  return typeof eventId === 'string' && typeof deliveredAt === 'string' && typeof replayed === 'boolean'
    ? { eventId, deliveredAt, replayed }
    : null;
}

/**
 * 書く窓口の答えを、画面が分けて扱う4つにする。
 * - ok: 記録できた（前の結果の再送でも同じ）
 * - blocked: 処理に入る前の断り（401・403・429）。何も変わっていない。二重防止の番号は変えない
 * - refused: 処理の中の断り（400・404・409 ほか）。記録していない。次の送信は別の操作なので新しい番号にする
 * - unknown: 通信が切れた・500 番台・読めない成功。記録されたかもしれない
 * 送信が途中で切れたかもしれない時に画面が同じ二重防止の番号で送り直せるよう、書き込みを自動では送り直さない（clientFetch も同じ）。
 */
async function callDeliveryApi<T>(
  url: string,
  body: object,
  readData: (data: unknown) => T | null,
): Promise<DeliveryCallResult<T>> {
  let response: Response;
  try {
    response = await clientFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'unknown' };
  }

  if (response.status >= 500) return { kind: 'unknown' };
  if (response.ok) {
    try {
      const parsed: unknown = await response.json();
      const data = readData(isRecord(parsed) ? parsed.data : undefined);
      return data ? { kind: 'ok', data } : { kind: 'unknown' };
    } catch {
      return { kind: 'unknown' };
    }
  }

  // 回数の制限などの共通の守りは英語の短い文を返すので、権限と回数の制限は固定の文にする
  if (response.status === 401) return { kind: 'blocked', message: UNAUTHENTICATED_MESSAGE };
  if (response.status === 403) return { kind: 'blocked', message: FORBIDDEN_MESSAGE };
  if (response.status === 429) return { kind: 'blocked', message: RATE_LIMITED_MESSAGE };
  const errorBody: unknown = await response.json().catch(() => null);
  return { kind: 'refused', message: ownErrorMessage(errorBody) ?? REFUSED_FALLBACK_MESSAGE };
}

const deliveryUrl = (orderId: string, fulfillmentId: string, operation: 'tracking' | 'delivered') =>
  `/api/admin/orders/${orderId}/fulfillments/${fulfillmentId}/${operation}`;

/** 伝票番号を直す（POST .../fulfillments/[fulfillmentId]/tracking）。送るのは C-3 の4項目だけ */
export function submitTrackingEdit(
  orderId: string,
  fulfillmentId: string,
  body: Pick<UpdateTrackingInput, 'requestKey' | 'carrier' | 'trackingNumber' | 'notifyCustomer'>,
): Promise<DeliveryCallResult<UpdateTrackingResult>> {
  return callDeliveryApi(deliveryUrl(orderId, fulfillmentId, 'tracking'), body, readTrackingResult);
}

/** 手で配達済みにする（POST .../fulfillments/[fulfillmentId]/delivered）。送るのは C-3 の3項目だけ */
export function submitManualDelivered(
  orderId: string,
  fulfillmentId: string,
  body: Pick<MarkDeliveredInput, 'requestKey' | 'deliveredOn' | 'notifyCustomer'>,
): Promise<DeliveryCallResult<MarkDeliveredResult>> {
  return callDeliveryApi(deliveryUrl(orderId, fulfillmentId, 'delivered'), body, readDeliveredResult);
}

type DeliverySubmissionOptions<Body, Result> = {
  /** 窓口を呼ぶ（submitTrackingEdit か submitManualDelivered） */
  send: (body: Body) => Promise<DeliveryCallResult<Result>>;
  /** 記録できた（前の結果の再送でも）。親へ知らせる処理 */
  onSucceeded: () => void;
  onClose: () => void;
  /** 結果が分からないまま閉じる。記録されたかもしれないので、親が一覧を読み直す */
  onUncertain?: () => void;
};

/**
 * 直す画面と配達済みの画面が共有する流れ（計画の Task 10。返品の画面の useReturnOperation と同じ考え）。
 * 二重防止の番号は画面を開いた時（この hook を使う部品を表示した時）に作り、窓口が断った時（refused）だけ作り直す。
 * 結果が分からない時（unknown）は、送った本文をそのまま取っておき、「もう一度確かめる」でその同じ中身と同じ番号だけを送り直す
 * （入力は止める。同じ番号なら DB は前の結果を返すので、記録は1回分のまま）。処理の前の断り（blocked）は、番号も中身も結果不明の状態も保つ。
 */
export function useDeliverySubmission<Body extends { requestKey: string }, Result>({
  send,
  onSucceeded,
  onClose,
  onUncertain,
}: DeliverySubmissionOptions<Body, Result>) {
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 結果が分からない送信の本文。null でなければ、入力を止めて「もう一度確かめる」だけを出す
  const [pending, setPending] = useState<Body | null>(null);
  // 一度でも結果が分からなかったか。閉じる時に、親へ読み直しを頼むために持つ
  const [everUncertain, setEverUncertain] = useState(false);

  const run = async (body: Body) => {
    setBusy(true);
    setMessage(null);
    const result = await send(body);
    setBusy(false);
    if (result.kind === 'ok') {
      setPending(null);
      onSucceeded();
      return;
    }
    if (result.kind === 'blocked') {
      setMessage(result.message);
      return;
    }
    if (result.kind === 'refused') {
      setRequestKey(crypto.randomUUID());
      setPending(null);
      setMessage(result.message);
      return;
    }
    setPending(body);
    setEverUncertain(true);
  };

  return {
    busy,
    /** 結果が分からない状態（入力を止める） */
    uncertain: pending !== null,
    /** 画面の role="alert" に出す断り・入力の誤りの文。結果不明の文（DELIVERY_FORM_TEXT.unknown）は別に出す */
    message,
    setMessage,
    /** 窓口へ送る。本文は、今の二重防止の番号を受け取って組む */
    submit: (build: (requestKey: string) => Body) => {
      if (busy || pending !== null) return;
      void run(build(requestKey));
    },
    /** 「もう一度確かめる」。保存してある同じ中身（同じ番号）で送り直す */
    checkAgain: () => {
      if (busy || pending === null) return;
      void run(pending);
    },
    /** 戻る・Escape。送っている間は閉じない。結果が分からないまま閉じる時は、親に読み直しを頼む */
    close: () => {
      if (busy) return;
      if (everUncertain) onUncertain?.();
      onClose();
    },
  };
}
