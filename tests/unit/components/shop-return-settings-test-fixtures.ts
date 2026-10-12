import type { ShopReturnSettings } from '@/lib/orders/returns/return-types';

type ReasonRow = ShopReturnSettings['reasons'][number];
type UpdatedEntry = ShopReturnSettings['updated']['shipping'];

const DEFECT_PHOTO_NOTE = '傷や不具合の場所がわかる写真をお送りください';
const SIZE_PHOTO_NOTE = 'タグの付いた状態がわかる写真をお送りください';

/** 理由ごとの設定の最初の値（仕様書 8-3 の表。移行 A が入れる値と同じ）。呼ぶたびに新しい物を返す */
function initialReasons(): ReasonRow[] {
  const hiddenFromCustomers = {
    shown: false,
    resolutions: 'refund_and_exchange',
    outOfStockExchange: 'decline',
    photo: 'optional',
    photoInstructions: '',
    shippingPayer: 'customer',
  } as const;
  return [
    {
      reason: 'defective',
      shown: true,
      resolutions: 'refund_and_exchange',
      outOfStockExchange: 'make',
      photo: 'required',
      photoInstructions: DEFECT_PHOTO_NOTE,
      shippingPayer: 'shop',
    },
    {
      reason: 'wrong_item',
      shown: true,
      resolutions: 'refund_and_exchange',
      outOfStockExchange: 'make',
      photo: 'required',
      photoInstructions: DEFECT_PHOTO_NOTE,
      shippingPayer: 'shop',
    },
    {
      reason: 'size_too_small',
      shown: true,
      resolutions: 'exchange_only',
      outOfStockExchange: 'decline',
      photo: 'optional',
      photoInstructions: SIZE_PHOTO_NOTE,
      shippingPayer: 'customer',
    },
    {
      reason: 'size_too_large',
      shown: true,
      resolutions: 'exchange_only',
      outOfStockExchange: 'decline',
      photo: 'optional',
      photoInstructions: SIZE_PHOTO_NOTE,
      shippingPayer: 'customer',
    },
    { reason: 'color', ...hiddenFromCustomers },
    { reason: 'style', ...hiddenFromCustomers },
    { reason: 'not_as_described', ...hiddenFromCustomers },
    { reason: 'unwanted', ...hiddenFromCustomers },
    {
      reason: 'other',
      shown: true,
      resolutions: 'refund_and_exchange',
      outOfStockExchange: 'decline',
      photo: 'optional',
      photoInstructions: '',
      shippingPayer: 'customer',
    },
    {
      reason: 'unknown',
      shown: false,
      resolutions: 'refund_and_exchange',
      outOfStockExchange: 'decline',
      photo: 'none',
      photoInstructions: '',
      shippingPayer: 'customer',
    },
  ];
}

/** まだ誰も変えていないまとまり */
const notChangedYet = (): UpdatedEntry => ({ at: null, byEmail: null });

/**
 * 窓口が返す返品の設定（ShopReturnSettings）。既定は移行 A が入れる最初の値（返送先は空、期限は7日・品ごと・目安3日、
 * 手数料と要検品はオフ、理由ごとは仕様書 8-3 の表）。違う所だけ overrides で渡す。
 */
export function buildShopReturnSettings(overrides: Partial<ShopReturnSettings> = {}): ShopReturnSettings {
  return {
    requestsEnabled: true,
    requestTypes: 'returns_only',
    noticeText: '',
    windowDays: 7,
    windowStart: 'each_item',
    deliveryBufferDays: 3,
    returnAddress: null,
    customerPaidMethod: 'customer_ships',
    shopLabelFee: 0,
    noReturnNeededEnabled: false,
    restockingFeeEnabled: false,
    restockingFeePercent: 0,
    exchangeFeesEnabled: false,
    exchangeFee: 0,
    exchangeShippingFee: 0,
    inspectionEnabled: false,
    reasons: initialReasons(),
    updated: {
      requests: notChangedYet(),
      window: notChangedYet(),
      shipping: notChangedYet(),
      reasons: notChangedYet(),
      fees: notChangedYet(),
      receiving: notChangedYet(),
    },
    ...overrides,
  };
}
