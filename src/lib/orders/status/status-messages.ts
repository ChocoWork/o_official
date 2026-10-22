import type { OrderStatusErrorCode } from '@/lib/orders/status/status-types';

/**
 * 注文の状況の頁の固定文（グループ E-5。共通の約束 C-4・C-5）。画面・窓口・試験が同じ文を使うので、画面からも読める。
 * 文は一字も変えない（英語へ置き換えたり、説明を言い換えたりしない）。値と店の文章は呼ぶ側が文字として出す。
 * 進み具合・配送・運送会社・支払方法・返品の状態の文は、既存の定数（ORDER_PROGRESS_LABELS・DELIVERY_STATUS_LABELS・
 * SHIPPING_CARRIERS・mapPaymentMethodLabel・OrderReturnsSection の文）をそのまま使い、ここへ写さない。
 */

/** 窓口の error と、画面の誤りの文。code ごとに1つ。401 の error 'Unauthorized' だけは窓口が別に持つ（AUTH_REQUIRED のここの文は画面の案内） */
export const ORDER_STATUS_ERROR_MESSAGES = {
  ORDER_STATUS_NOT_FOUND: 'このページは見つかりません',
  ORDER_STATUS_INPUT_INVALID: '電話番号の下4桁を入れてください。',
  ORDER_STATUS_MISMATCH: '電話番号の下4桁が一致しません。もう一度確かめてください。',
  ORDER_STATUS_LOCKED: '確認できる回数を超えました。ログインするか、お問い合わせください。',
  ORDER_STATUS_UNAVAILABLE: 'ログインするか、お問い合わせください',
  ORDER_STATUS_EXPIRED: '電話番号で確認できる期間が過ぎました。ログインするか、お問い合わせください。',
  ORDER_STATUS_RATE_LIMITED: 'しばらくしてから、もう一度お試しください。',
  ORDER_STATUS_FORBIDDEN: '画面を開き直して、もう一度お試しください。',
  ORDER_STATUS_AUTH_REQUIRED: 'ログインするか、電話番号の下4桁で確かめてください。',
  ORDER_STATUS_TEMPORARILY_UNAVAILABLE: 'ただいま確認できません。時間をおいて、もう一度お試しください。',
  ORDER_STATUS_FAILED: 'ご注文の状況を読み込めませんでした。時間をおいて、もう一度お試しください。',
} as const satisfies Record<OrderStatusErrorCode, string>;

export const ORDER_STATUS_TEXT = {
  metadataTitle: 'ご注文の状況 | Le Fil des Heures',
  heading: 'ご注文の状況',
  orderNumber: (orderNumber: string) => `注文番号 ${orderNumber}`,
  orderDate: (orderDate: string) => `ご注文日 ${orderDate}`,
  progressAriaLabel: '配送ステータス',
  shipment: {
    heading: (number: number) => `配送情報（${number}回目）`,
    shippedAt: '発送日',
    carrier: '配送業者',
    deliveredAt: 'お届け日',
    lastUpdate: '最後の更新',
    history: '配送の移り変わり',
    trackingNumber: '追跡番号',
    trackingLink: '配送状況を確認する',
    deliveredOn: (date: string) => `お届け日 ${date}`,
    updatedAt: (dateTime: string) => `最後の更新 ${dateTime}`,
    problem: '配送に遅れや問題が出ています。詳しくは配送業者のページをご確認ください',
  },
  /** 該当する数が1以上の時だけ出す */
  unshipped: {
    readyHeading: '発送準備中の商品',
    inProductionHeading: '受注生産中の商品',
  },
  items: {
    heading: 'ご注文商品',
    quantity: (quantity: number) => `数量: ${quantity}`,
    exchange: '交換の品',
    refunded: (quantity: number) => `返金済み ${quantity}点`,
    exchangeAmount: '—',
    colorSize: (color: string, size: string) => `${color} / ${size}`,
  },
  amounts: {
    heading: '支払金額',
    subtotal: '小計',
    shipping: '送料',
    discount: 'クーポン値引き',
    total: '支払金額',
  },
  refunds: {
    heading: 'ご返金',
    processing: '手続き中',
    completed: '完了',
    /** 返金が2件以上の時だけ出す */
    total: 'ご返金の合計',
  },
  verify: {
    heading: 'お届け先などの確認',
    description: 'お届け先・お支払い方法・伝票番号を見るには、ご注文の時の電話番号の下4桁を入れてください。',
    label: 'ご注文の時の電話番号の下4桁',
    hint: '数字4桁を入れてください。',
    placeholder: '1234',
    submit: '確かめる',
    submitting: '確認中…',
    verified: '確認できました。',
    loadingPrivate: 'お届け先などを確認しています。',
  },
  private: {
    shippingHeading: 'お届け先',
    contactHeading: 'ご連絡先',
    paymentHeading: 'お支払い方法',
    trackingHeading: '伝票番号',
    returnsHeading: '返品の返送先・送り返しの伝票番号',
    name: 'お名前',
    postalCode: '郵便番号',
    address: '住所',
    phone: '電話番号',
    email: 'メールアドレス',
    /** 空の個人情報の値（空欄のままにしない） */
    empty: '-',
    /** 番号の無い発送は、この行ごと出さない */
    trackingNumber: (trackingNumber: string) => `追跡番号 ${trackingNumber}`,
    returnAddress: '返送先:',
    returnAddressLine: (postalCode: string, address: string) => `〒${postalCode} ${address}`,
    sentBackTracking: (trackingNumber: string) => `送り返しの伝票番号: ${trackingNumber}`,
  },
  login: {
    label: 'ログインする',
    href: '/login',
  },
  guest: {
    heading: '返品・キャンセルをご希望の方へ',
    registerDescription:
      'ご注文の時と同じメールアドレスで会員登録し、メールの確認を済ませると、このご注文が会員の注文履歴に入り、そこから返品・キャンセルを申し込めます。',
    registerLabel: '会員登録して申し込む',
    registerHref: '/login?tab=register',
    contactDescription: '会員登録をせずにお申し込みをご希望の方は、お問い合わせからご連絡ください。注文番号は入力済みで開きます。',
    contactLabel: 'お問い合わせから申し込む',
    contactHref: (orderNumber: string) => `/contact?type=order&order=${encodeURIComponent(orderNumber)}`,
  },
  owner: {
    heading: '返品・キャンセルのお申し込み',
    description: '返品・キャンセルのお申し込みは、会員の注文のページで受け付けています。',
    linkLabel: '会員の注文のページへ',
    href: (orderId: string) => `/account/orders/${orderId}`,
  },
  reload: 'もう一度読み込む',
  notFoundLink: {
    label: 'トップページへ',
    href: '/',
  },
} as const;
