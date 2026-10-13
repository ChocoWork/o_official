-- 返品の記録と数え方（グループ E-3 設計書 4・6・8・11 章）の移行 A
--
-- 返品（Shopify の Return と ReturnLineItem）・受け取りの記録・受け取りの商品の扱いの 4 つの表と守り、
-- 注文の商品の「交換の品」の列、返金の道 return と返品の番号、在庫の台帳の返品の番号と理由 return・exchange、
-- 注文のメールの表の返品の番号の列・種類・一意の決まり、ショップの設定の「返品」の欄（全体と理由ごとの 2 つの表と最初の値）、
-- 権限の行 admin.orders.return を足す。
-- 確保中の数に交換の品の確保（exchange）を足し、返品の行ごとの数・商品ごとの返品の数・発送の行ごとの返品できる数と期限・
-- 返品の状態の確かめ直し・返品の設定を読む関数を作り、在庫の履歴に返品の番号を出す。
-- 表は public に置き、書くのは SECURITY DEFINER の関数だけ（service_role は読むだけ）。
-- 返品を作る・取り消す・読み出す関数は移行 B、受け取り・額を決めて返金する関数と返金の本体の切り出しは移行 C で作る。
-- 移行 A〜C（E-2。20261011222930_order_refund_records.sql・20261011223147_order_refund_requests.sql・
-- 20261011223453_order_refund_results.sql）の後に当てる。
BEGIN;

-- 1. 返品（Shopify の Return）と返品の行（ReturnLineItem）。
--    実行した人・した時刻の列は外部キーにしない: ON DELETE SET NULL は UPDATE として動くので、書き換えを止める守りとぶつかり、
--    利用者の削除そのものが失敗する（E-1・E-2 の表と同じ考え）。
--    一意の制約には、自動で付く名前と同じ名前を明示する（二重防止の番号 order_returns_request_key_key・
--    order_return_receipts_request_key_key は、移行 B の関数が制約の名前でぶつかりを見分ける。注文ごとの番号
--    order_returns_order_id_number_key は、本番に当てた後の指紋の確かめが名前で探す）
CREATE TABLE public.order_returns (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders (id) ON DELETE RESTRICT,
  number integer NOT NULL CHECK (number >= 1),
  source text NOT NULL CHECK (source IN ('customer_request', 'shop')),
  status text NOT NULL CHECK (status IN ('requested', 'open', 'closed', 'cancelled', 'declined')),
  request_key uuid NOT NULL CONSTRAINT order_returns_request_key_key UNIQUE,
  request_fingerprint text NOT NULL,
  -- お客様の申し込み（段2）。段1はお店が作るので空のまま
  requested_at timestamptz,
  requested_by uuid,
  -- 承認。お店が作った時は作った時刻と人
  approved_at timestamptz,
  approved_by uuid,
  -- お断り（段2）
  declined_at timestamptz,
  declined_by uuid,
  decline_reason text CHECK (decline_reason IN ('window_passed', 'final_sale', 'other')),
  decline_message text CHECK (pg_catalog.char_length(decline_message) <= 1000),
  return_method text NOT NULL CHECK (return_method IN ('customer_ships', 'shop_label', 'not_required')),
  return_shipping_payer text NOT NULL CHECK (return_shipping_payer IN ('shop', 'customer')),
  return_carrier text CHECK (return_carrier IN ('yamato', 'sagawa', 'japanpost', 'other')),
  return_tracking_number text CHECK (return_tracking_number ~ '^[0-9A-Za-z-]{1,64}$'),
  return_shipping_fee integer NOT NULL DEFAULT 0 CHECK (return_shipping_fee >= 0),
  exchange_fee integer NOT NULL DEFAULT 0 CHECK (exchange_fee >= 0),
  exchange_shipping_fee integer NOT NULL DEFAULT 0 CHECK (exchange_shipping_fee >= 0),
  -- 返金から引けずに、お客様からいただく、まだ決着していない額（受け取りの時に決まる）
  fee_due_amount integer NOT NULL DEFAULT 0 CHECK (fee_due_amount >= 0),
  -- 受け取りを記録した分と、いただかないで終えた分の合計。新しい未収額と分け、二度求めない。
  fee_settled_amount integer NOT NULL DEFAULT 0 CHECK (fee_settled_amount >= 0),
  -- 相談の受け取りで付き、額を決めて返金する時にその返金から引く手数料
  fee_pending_deduction integer NOT NULL DEFAULT 0 CHECK (fee_pending_deduction >= 0),
  restocking_fee_percent integer NOT NULL DEFAULT 0 CHECK (restocking_fee_percent BETWEEN 0 AND 100),
  fee_received_at timestamptz,
  fee_received_by uuid,
  fee_received_note text CHECK (pg_catalog.char_length(fee_received_note) <= 500),
  -- 手数料をいただかないことにした（手数料の画面の「いただかないで終える」。P27）。真の時も fee_received_at・fee_received_by を入れる。
  -- 決着した額は fee_settled_amount に移す。お支払い待ちの決め方（fee_due_amount > 0 で fee_received_at が空）は変えない。
  fee_waived boolean NOT NULL DEFAULT false,
  exchange_released_at timestamptz,
  exchange_released_by uuid,
  notify_customer boolean NOT NULL,
  shop_note text CHECK (pg_catalog.char_length(shop_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid,
  closed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid,
  reopened_at timestamptz,
  reopened_by uuid,
  CONSTRAINT order_returns_order_id_number_key UNIQUE (order_id, number),
  CONSTRAINT order_returns_fee_waived_check CHECK (
    NOT fee_waived OR (fee_received_at IS NOT NULL AND fee_received_by IS NOT NULL)
  )
);

-- 返す品は、どの発送のどの品か（発送の行の組）を指す。返金は今までどおり注文の商品ごと。
-- ここの resolution・exchange_* は作った時の「予定」で、作った後は一切変えない（数も同じ）。
-- 実際に決まった解決（在庫不足で作って送るに変えた・店長が返金に変えた）は、受け取りの商品の扱いに残す。
-- 交換の色・サイズは同じ商品の物だけ、という決まりは関数が確かめる（移行 B）
CREATE TABLE public.order_return_lines (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES public.order_returns (id) ON DELETE RESTRICT,
  fulfillment_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 1),
  reason text NOT NULL CHECK (reason IN (
    'defective', 'wrong_item', 'size_too_small', 'size_too_large', 'color', 'style',
    'not_as_described', 'unwanted', 'other', 'unknown'
  )),
  reason_note text CHECK (pg_catalog.char_length(reason_note) <= 255),
  -- お客様の詳しい内容・ご希望（段2）
  customer_note text CHECK (pg_catalog.char_length(customer_note) <= 300),
  requested_resolution text CHECK (requested_resolution IN ('refund', 'exchange')),
  requested_exchange_variant_id bigint REFERENCES public.item_variants (id) ON DELETE RESTRICT,
  resolution text NOT NULL CHECK (resolution IN ('refund', 'exchange')),
  exchange_variant_id bigint REFERENCES public.item_variants (id) ON DELETE RESTRICT,
  exchange_method text CHECK (exchange_method IN ('stock', 'make')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT order_return_lines_fulfillment_line_fkey FOREIGN KEY (fulfillment_id, order_item_id)
    REFERENCES public.order_fulfillment_lines (fulfillment_id, order_item_id) ON DELETE RESTRICT,
  CONSTRAINT order_return_lines_exchange_check CHECK (
    (resolution = 'exchange') = (exchange_variant_id IS NOT NULL)
    AND (resolution = 'exchange') = (exchange_method IS NOT NULL)
  )
);

-- 2. 受け取りの記録（1回の操作が1行。追記だけ）と、操作ごとの商品の扱い（足していく台帳。直さない）。
--    列の CHECK に自動で付く名前（order_return_receipts_refund_choice_check）は、下の表の CHECK の名前とぶつかって
--    表を作れないので、表の CHECK には別の名前を付ける
CREATE TABLE public.order_return_receipts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES public.order_returns (id) ON DELETE RESTRICT,
  request_key uuid NOT NULL CONSTRAINT order_return_receipts_request_key_key UNIQUE,
  request_fingerprint text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receive', 'inspect', 'close_missing', 'reopen', 'waive_refund')),
  refund_choice text CHECK (refund_choice IN ('now', 'consult', 'none')),
  refund_id uuid REFERENCES public.order_refunds (id) ON DELETE RESTRICT,
  notify_customer boolean NOT NULL DEFAULT false,
  sent_back_message text CHECK (pg_catalog.char_length(sent_back_message) <= 1000),
  sent_back_carrier text CHECK (sent_back_carrier IN ('yamato', 'sagawa', 'japanpost', 'other')),
  sent_back_tracking_number text CHECK (sent_back_tracking_number ~ '^[0-9A-Za-z-]{1,64}$'),
  note text CHECK (pg_catalog.char_length(note) <= 500),
  actor_id uuid,
  actor_can_refund boolean,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT order_return_receipts_kind_choice_check CHECK ((kind = 'receive') = (refund_choice IS NOT NULL))
);

-- 商品の扱い。受け取った品（restocked・not_restocked・pending_inspection）の行だけが、その受け取りで実際に決まった解決
-- （resolution。交換なら送り方 exchange_method）を持つ。検品で決めた数・お返し・届かない・開き直し・返金しないことにした数は
-- 解決を持たない。数え方の交換の数・返金待ち・覆いは、返品の行の予定ではなく、この行の resolution で数える。
-- 3 つめの CHECK（order_return_receipt_lines_method_check）は、解決が空の行に送り方だけがある形を断つ
-- （空との比較は結果が空になって CHECK を通るので、上の 2 つでは断てない）
CREATE TABLE public.order_return_receipt_lines (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES public.order_return_receipts (id) ON DELETE RESTRICT,
  return_line_id uuid NOT NULL REFERENCES public.order_return_lines (id) ON DELETE RESTRICT,
  disposition text NOT NULL CHECK (disposition IN (
    'restocked', 'not_restocked', 'pending_inspection', 'inspected_restocked', 'inspected_not_restocked',
    'sent_back', 'missing', 'missing_reopened', 'refund_waived'
  )),
  quantity integer NOT NULL CHECK (quantity >= 1),
  resolution text CHECK (resolution IN ('refund', 'exchange')),
  exchange_method text CHECK (exchange_method IN ('stock', 'make')),
  CONSTRAINT order_return_receipt_lines_received_check CHECK (
    (disposition IN ('restocked', 'not_restocked', 'pending_inspection')) = (resolution IS NOT NULL)
  ),
  CONSTRAINT order_return_receipt_lines_exchange_check CHECK (
    (resolution = 'exchange') = (exchange_method IS NOT NULL)
  ),
  CONSTRAINT order_return_receipt_lines_method_check CHECK (resolution IS NOT NULL OR exchange_method IS NULL),
  CONSTRAINT order_return_receipt_lines_line_key
    UNIQUE NULLS NOT DISTINCT (receipt_id, return_line_id, disposition, resolution, exchange_method)
);

-- 注文の中の返品を引く索引は、一意の制約 (order_id, number) が兼ねる。受け取りの商品の扱いを受け取りから引く索引は、
-- 一意の制約 (receipt_id, …) が兼ねる
CREATE INDEX order_returns_status_idx ON public.order_returns (status, created_at DESC);
CREATE INDEX order_return_lines_return_idx ON public.order_return_lines (return_id);
CREATE INDEX order_return_lines_fulfillment_line_idx ON public.order_return_lines (fulfillment_id, order_item_id);
CREATE INDEX order_return_lines_requested_exchange_variant_idx ON public.order_return_lines (requested_exchange_variant_id)
  WHERE requested_exchange_variant_id IS NOT NULL;
CREATE INDEX order_return_lines_exchange_variant_idx ON public.order_return_lines (exchange_variant_id)
  WHERE exchange_variant_id IS NOT NULL;
CREATE INDEX order_return_receipts_return_idx ON public.order_return_receipts (return_id, created_at);
CREATE INDEX order_return_receipts_refund_idx ON public.order_return_receipts (refund_id) WHERE refund_id IS NOT NULL;
CREATE INDEX order_return_receipt_lines_line_idx ON public.order_return_receipt_lines (return_line_id);

-- 3. 既存の表に足す物。
--    CHECK を作り直す所は、E-2 の移行 A が列に直接書いた CHECK の自動の名前（<表>_<列>_check）を、手元の DB で確かめてから消す。
--    名前が違えば、ここで止まる（黙って古い CHECK が残らないようにする）

-- 交換の品の行（設計書 4-4）。値段（単価・小計）は 0 で、元の品の支払額を持つ
ALTER TABLE public.order_items
  ADD COLUMN line_kind text NOT NULL DEFAULT 'order' CHECK (line_kind IN ('order', 'exchange'));
ALTER TABLE public.order_items
  ADD COLUMN exchange_return_line_id uuid REFERENCES public.order_return_lines (id) ON DELETE RESTRICT;
ALTER TABLE public.order_items
  ADD COLUMN exchange_paid_amount integer CHECK (exchange_paid_amount >= 0);
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_exchange_check CHECK (
    (line_kind = 'order' AND exchange_return_line_id IS NULL AND exchange_paid_amount IS NULL)
    OR (line_kind = 'exchange' AND exchange_return_line_id IS NOT NULL AND exchange_paid_amount IS NOT NULL
        AND item_price = 0 AND line_total = 0)
  );
CREATE INDEX order_items_exchange_return_line_idx ON public.order_items (exchange_return_line_id)
  WHERE exchange_return_line_id IS NOT NULL;

-- 返金の道に return（返品の返金）を足し、どの返品かを持たせる。道が return の時だけ返品の番号が要る
ALTER TABLE public.order_refunds
  ADD COLUMN return_id uuid REFERENCES public.order_returns (id) ON DELETE RESTRICT;
ALTER TABLE public.order_refunds DROP CONSTRAINT order_refunds_source_check;
ALTER TABLE public.order_refunds
  ADD CONSTRAINT order_refunds_source_check CHECK (source IN (
    'admin', 'order_cancel', 'stripe_dashboard', 'auto_cancelled_order_payment', 'auto_amount_mismatch', 'legacy', 'return'
  ));
ALTER TABLE public.order_refunds
  ADD CONSTRAINT order_refunds_return_check CHECK ((source = 'return') = (return_id IS NOT NULL));
CREATE INDEX order_refunds_return_idx ON public.order_refunds (return_id) WHERE return_id IS NOT NULL;

-- 返金の商品の行の在庫の戻し方に return を足す。return の行は発送後の行だけ（在庫は受け取りで動かすので、返金では動かさない）。
-- 発送前の行は今までどおり cancel か no_restock、発送後の行は no_restock か return
ALTER TABLE public.order_refund_lines DROP CONSTRAINT order_refund_lines_restock_type_check;
ALTER TABLE public.order_refund_lines
  ADD CONSTRAINT order_refund_lines_restock_type_check CHECK (restock_type IN ('cancel', 'no_restock', 'return'));
ALTER TABLE public.order_refund_lines DROP CONSTRAINT order_refund_lines_restock_check;
ALTER TABLE public.order_refund_lines
  ADD CONSTRAINT order_refund_lines_restock_check CHECK (
    (before_shipment AND restock_type IN ('cancel', 'no_restock'))
    OR (NOT before_shipment AND restock_type IN ('no_restock', 'return'))
  );

-- 在庫の台帳に、どの返品で動いたかと、理由 return（返品の受け取り。+n）・exchange（交換の品の確保。−n）を足す
ALTER TABLE public.stock_movements
  ADD COLUMN return_id uuid REFERENCES public.order_returns (id) ON DELETE RESTRICT;
CREATE INDEX stock_movements_return_id_idx ON public.stock_movements (return_id) WHERE return_id IS NOT NULL;
ALTER TABLE public.stock_movements DROP CONSTRAINT stock_movements_reason_check;
ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_reason_check CHECK (reason IN (
    'purchase', 'restock', 'adjustment', 'cancel', 'refund', 'return', 'exchange'
  ));

-- 4. 注文のメールの表（グループ D・E-1・E-2）: 返品の番号の列、種類・書き分けの CHECK、返品のお知らせの一意の決まり。
--    返品の記録は消せない（上の守り）ので、消す時の決まりは RESTRICT。
--    種類・書き分けの CHECK は E-2 の移行 C が付けた名前（order_email_outbox_kind_check・order_email_outbox_variant_check）
--    のまま作り直す。書き方も移行 C に合わせる（tests/unit/lib/orders/email/order-email-types.test.ts が SQL の文字から種類を読む）
ALTER TABLE private.order_email_outbox
  ADD COLUMN return_id uuid REFERENCES public.order_returns (id) ON DELETE RESTRICT;
ALTER TABLE private.order_email_outbox
  ADD COLUMN return_receipt_id uuid REFERENCES public.order_return_receipts (id) ON DELETE RESTRICT;

ALTER TABLE private.order_email_outbox DROP CONSTRAINT order_email_outbox_kind_check;
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_kind_check
  CHECK (kind IN (
    'paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped', 'refund',
    'return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop'
  ));

-- 書き分け: 返金のお知らせ（refund）に return（返品の返金）を足す。返品のお知らせの 4 種類は書き分けが無い
ALTER TABLE private.order_email_outbox DROP CONSTRAINT order_email_outbox_variant_check;
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_variant_check CHECK (
    (kind = 'paid' AND variant IS NOT NULL
      AND variant IN ('order_confirmed', 'payment_received', 'payment_received_after_expiry'))
    OR (kind = 'canceled' AND variant IS NOT NULL AND variant IN ('payment_in_progress', 'pending', 'paid'))
    OR (kind = 'refund' AND variant IS NOT NULL AND variant IN ('standard', 'after_cancel', 'return'))
    OR (kind IN (
      'awaiting_payment', 'payment_expired', 'shipped',
      'return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop'
    ) AND variant IS NULL)
  );

-- 返品の番号と受け取りの番号の持ち方。
--   ・return_accepted: 返品の番号が要り、受け取りの番号は持たない
--   ・return_received・return_sent_back・return_refund_pending_shop: 返品の番号と受け取りの番号の両方が要る
--   ・refund（返金のお知らせ）: 返品の返金のお知らせは、返品の番号を持ち、受け取りと一緒に返した時は受け取りの番号も持つ
--     （移行 C の private.enqueue_order_email が、返金の行から入れる）。受け取りの番号だけを持つ形は断る。
--     ふつうの返金のお知らせは、どちらも空
--   ・ほかの種類（paid・awaiting_payment・payment_expired・canceled・shipped）: どちらも持たない
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_return_check CHECK (
    (kind = 'return_accepted' AND return_id IS NOT NULL AND return_receipt_id IS NULL)
    OR (kind IN ('return_received', 'return_sent_back', 'return_refund_pending_shop')
        AND return_id IS NOT NULL AND return_receipt_id IS NOT NULL)
    OR (kind = 'refund' AND (return_receipt_id IS NULL OR return_id IS NOT NULL)
        AND ((variant = 'return') = (return_id IS NOT NULL)))
    OR (kind NOT IN ('return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop', 'refund')
        AND return_id IS NULL AND return_receipt_id IS NULL)
  );

-- 一意の決まり。自動の行は、
--   ・return_accepted が返品ごとに 1 行（ON CONFLICT (return_id) WHERE origin = 'auto' AND kind = 'return_accepted'）
--   ・return_received・return_sent_back・return_refund_pending_shop が受け取りごと・種類ごとに 1 行
--     （ON CONFLICT (return_receipt_id, kind) WHERE origin = 'auto' AND return_receipt_id IS NOT NULL）
--   ・受け取りの番号を持つ返金のお知らせ（refund）も、同じ索引で受け取りごと・種類ごとに 1 行
--     （1 つの受け取りが持つ返金は order_return_receipts.refund_id の 1 つだけなので、今の作りでは同じ受け取りに 2 通目は来ない）
--   （索引を指定しない ON CONFLICT DO NOTHING でも、この 2 つの索引にぶつかれば何も書かない）
-- 返品のお知らせは 1 注文に何通もあってよい（返品ごと・受け取りごと）ので、今の「1 注文 1 種類 1 行」の索引
-- （order_email_outbox_auto_once_idx）から 4 つの種類を外して作り直す。外さないと、2 つ目の返品のお知らせが
-- 一意の制約で落ちる（グループ E-3 の本計画 P23）
DROP INDEX private.order_email_outbox_auto_once_idx;
CREATE UNIQUE INDEX order_email_outbox_auto_once_idx
  ON private.order_email_outbox (order_id, kind)
  WHERE origin = 'auto' AND kind <> 'shipped' AND refund_id IS NULL
    AND kind NOT IN ('return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop');

CREATE UNIQUE INDEX order_email_outbox_auto_return_idx
  ON private.order_email_outbox (return_id)
  WHERE origin = 'auto' AND kind = 'return_accepted';

CREATE UNIQUE INDEX order_email_outbox_auto_return_receipt_idx
  ON private.order_email_outbox (return_receipt_id, kind)
  WHERE origin = 'auto' AND return_receipt_id IS NOT NULL;

-- 予定を書く関数。本文は移行 C（20261011223453_order_refund_results.sql）のままで、最後の枝の ON CONFLICT の条件だけを
-- 作り直した索引に合わせた（ON CONFLICT の WHERE が索引の条件を含まないと「合う制約が無い」で落ちる）。
-- 引数と答えは変えない。返品のお知らせは private.enqueue_return_email（移行 B）が書く。
-- 移行 C でこの関数を作り直す時は、ここの本文（最後の枝の WHERE）を元にする
CREATE OR REPLACE FUNCTION private.enqueue_order_email(
  _order_id uuid,
  _kind text,
  _variant text DEFAULT NULL,
  _fulfillment_id uuid DEFAULT NULL,
  _refund_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF _kind = 'shipped' THEN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, refund_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id, _refund_id)
    ON CONFLICT (fulfillment_id) WHERE origin = 'auto' AND kind = 'shipped' DO NOTHING;
  ELSIF _refund_id IS NOT NULL THEN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, refund_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id, _refund_id)
    ON CONFLICT (refund_id, kind) WHERE origin = 'auto' AND refund_id IS NOT NULL DO NOTHING;
  ELSE
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, refund_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id, _refund_id)
    ON CONFLICT (order_id, kind)
      WHERE origin = 'auto' AND kind <> 'shipped' AND refund_id IS NULL
        AND kind NOT IN ('return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop')
      DO NOTHING;
  END IF;
  RETURN FOUND;
END;
$$;

-- 5. 守り。書くのは SECURITY DEFINER の関数だけだが、関数の書き間違いも DB で止める（E-1・E-2 の表と同じ考え）。
--    記録は消さない。返品は状態・時刻・する人・手数料の受け取り（fee_waived を含む）・支払いを待たずに送る・手数料の額（決着した合計 fee_settled_amount を含む）だけが進み、
--    返品の行・受け取りの記録・受け取りの商品の扱いは追記だけ（作った後に一切変えない）。
--    エラーの文字は E-2 の ORDER_REFUND_* に揃える

-- 返品: 直せるのは、状態・時刻・する人・手数料の受け取り（fee_waived を含む）・支払いを待たずに送る・手数料の額（決着した合計 fee_settled_amount を含む）の列だけ。消せない
CREATE OR REPLACE FUNCTION private.guard_order_return_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  -- 変えてよい列。ほかの列が変われば止める。
  -- approved_*・declined_*・decline_* は段 2 の承認とお断りが書く（段 1 の関数は書かない）。
  -- fee_waived は手数料を「いただかないで終える」時に、admin_record_return_fee_payment（移行 B）が真にする（P27）
  v_movable CONSTANT text[] := ARRAY[
    'status', 'approved_at', 'approved_by', 'declined_at', 'declined_by', 'decline_reason', 'decline_message',
    'closed_at', 'cancelled_at', 'cancelled_by', 'reopened_at', 'reopened_by',
    'fee_due_amount', 'fee_settled_amount', 'fee_pending_deduction', 'fee_received_at', 'fee_received_by', 'fee_received_note', 'fee_waived',
    'exchange_released_at', 'exchange_released_by'
  ];
BEGIN
  -- DELETE と TRUNCATE。文のトリガーには OLD も NEW も無いので、先に抜ける
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'ORDER_RETURN_APPEND_ONLY' USING ERRCODE = '23514';
  END IF;

  IF (pg_catalog.to_jsonb(NEW) - v_movable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_movable) THEN
    RAISE EXCEPTION 'ORDER_RETURN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  -- 状態の移り方（設計書 3-2）。取消とお断りから先へは進まない。完了から受付中へ戻るのは開き直しだけ
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('open', 'declined'))
    OR (OLD.status = 'open' AND NEW.status IN ('closed', 'cancelled'))
    OR (OLD.status = 'closed' AND NEW.status = 'open')
  ) THEN
    RAISE EXCEPTION 'ORDER_RETURN_INVALID_TRANSITION' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- 返品の行・受け取りの記録・受け取りの商品の扱い: 直せない・消せない（追記だけ）
CREATE OR REPLACE FUNCTION private.reject_order_return_record_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'ORDER_RETURN_APPEND_ONLY' USING ERRCODE = '23514';
END;
$$;

-- 返品の行は、その返品の注文の発送だけを指す（発送の行の組が実在することは外部キーが確かめる）
CREATE OR REPLACE FUNCTION private.check_return_line_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.order_returns AS r
    JOIN public.order_fulfillments AS f ON f.order_id = r.order_id
    WHERE r.id = NEW.return_id
      AND f.id = NEW.fulfillment_id
  ) THEN
    RAISE EXCEPTION 'RETURN_LINE_NOT_IN_ORDER' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

-- 受け取りの商品の扱いは、その受け取りの返品の行だけを指す
CREATE OR REPLACE FUNCTION private.check_receipt_line_return()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.order_return_receipts AS rc
    JOIN public.order_return_lines AS l ON l.return_id = rc.return_id
    WHERE rc.id = NEW.receipt_id
      AND l.id = NEW.return_line_id
  ) THEN
    RAISE EXCEPTION 'RECEIPT_LINE_NOT_IN_RETURN' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_returns_guard
  BEFORE UPDATE OR DELETE ON public.order_returns
  FOR EACH ROW EXECUTE FUNCTION private.guard_order_return_change();
CREATE TRIGGER order_returns_no_truncate
  BEFORE TRUNCATE ON public.order_returns
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_order_return_change();

CREATE TRIGGER order_return_lines_no_change
  BEFORE UPDATE OR DELETE ON public.order_return_lines
  FOR EACH ROW EXECUTE FUNCTION private.reject_order_return_record_change();
CREATE TRIGGER order_return_lines_no_truncate
  BEFORE TRUNCATE ON public.order_return_lines
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_order_return_record_change();
CREATE TRIGGER order_return_lines_order_check
  BEFORE INSERT ON public.order_return_lines
  FOR EACH ROW EXECUTE FUNCTION private.check_return_line_order();

CREATE TRIGGER order_return_receipts_no_change
  BEFORE UPDATE OR DELETE ON public.order_return_receipts
  FOR EACH ROW EXECUTE FUNCTION private.reject_order_return_record_change();
CREATE TRIGGER order_return_receipts_no_truncate
  BEFORE TRUNCATE ON public.order_return_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_order_return_record_change();

CREATE TRIGGER order_return_receipt_lines_no_change
  BEFORE UPDATE OR DELETE ON public.order_return_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION private.reject_order_return_record_change();
CREATE TRIGGER order_return_receipt_lines_no_truncate
  BEFORE TRUNCATE ON public.order_return_receipt_lines
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_order_return_record_change();
CREATE TRIGGER order_return_receipt_lines_return_check
  BEFORE INSERT ON public.order_return_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION private.check_receipt_line_return();

-- 6. ショップの設定の「返品」の欄（設計書 8-3・11-2）。全体の設定（1 行）と、理由ごとの設定（理由ごとに 1 行）。
--    書くのは移行 B の関数だけ（admin.settings.manage）。最初の値は設計書 8-3 のとおり。
--    段 2 の列（申し込みの受付・種類・注意書き・理由ごとの出す／ご希望／写真）も、段 2 で表を直さずに済むよう、ここで作る
CREATE TABLE public.shop_return_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  requests_enabled boolean NOT NULL DEFAULT true,
  request_types text NOT NULL DEFAULT 'returns_only'
    CHECK (request_types IN ('returns_and_cancellations', 'returns_only', 'cancellations_only')),
  notice_text text NOT NULL DEFAULT '' CHECK (pg_catalog.char_length(notice_text) <= 2000),
  -- 受付の日数。空は無制限
  window_days integer DEFAULT 7 CHECK (window_days IS NULL OR window_days BETWEEN 1 AND 365),
  window_start text NOT NULL DEFAULT 'each_item' CHECK (window_start IN ('each_item', 'last_item')),
  delivery_buffer_days integer NOT NULL DEFAULT 3 CHECK (delivery_buffer_days BETWEEN 0 AND 14),
  -- 返送先。4 つとも空か、4 つとも入っている
  return_address_name text CHECK (pg_catalog.char_length(return_address_name) BETWEEN 1 AND 200),
  return_address_postal_code text CHECK (return_address_postal_code ~ '^[0-9]{3}-?[0-9]{4}$'),
  return_address_line text CHECK (pg_catalog.char_length(return_address_line) BETWEEN 1 AND 200),
  return_address_phone text CHECK (return_address_phone ~ '^[0-9+-]{6,20}$'),
  customer_paid_method text NOT NULL DEFAULT 'customer_ships' CHECK (customer_paid_method IN ('customer_ships', 'shop_label')),
  shop_label_fee integer NOT NULL DEFAULT 0 CHECK (shop_label_fee >= 0),
  no_return_needed_enabled boolean NOT NULL DEFAULT false,
  restocking_fee_enabled boolean NOT NULL DEFAULT false,
  restocking_fee_percent integer NOT NULL DEFAULT 0 CHECK (restocking_fee_percent BETWEEN 0 AND 100),
  exchange_fees_enabled boolean NOT NULL DEFAULT false,
  exchange_fee integer NOT NULL DEFAULT 0 CHECK (exchange_fee >= 0),
  exchange_shipping_fee integer NOT NULL DEFAULT 0 CHECK (exchange_shipping_fee >= 0),
  inspection_enabled boolean NOT NULL DEFAULT false,
  -- まとまりごとの、最後に変えた人と時刻（実行した人の列は外部キーにしない）
  requests_updated_at timestamptz,
  requests_updated_by uuid,
  window_updated_at timestamptz,
  window_updated_by uuid,
  shipping_updated_at timestamptz,
  shipping_updated_by uuid,
  reasons_updated_at timestamptz,
  reasons_updated_by uuid,
  fees_updated_at timestamptz,
  fees_updated_by uuid,
  receiving_updated_at timestamptz,
  receiving_updated_by uuid,
  CONSTRAINT shop_return_settings_address_check CHECK (
    (return_address_name IS NULL) = (return_address_postal_code IS NULL)
    AND (return_address_name IS NULL) = (return_address_line IS NULL)
    AND (return_address_name IS NULL) = (return_address_phone IS NULL)
  )
);

INSERT INTO public.shop_return_settings (id) VALUES (1);

CREATE TABLE public.shop_return_reason_settings (
  reason text PRIMARY KEY CHECK (reason IN (
    'defective', 'wrong_item', 'size_too_small', 'size_too_large', 'color', 'style',
    'not_as_described', 'unwanted', 'other', 'unknown'
  )),
  shown boolean NOT NULL,
  resolutions text NOT NULL CHECK (resolutions IN ('refund_and_exchange', 'exchange_only', 'refund_only')),
  out_of_stock_exchange text NOT NULL CHECK (out_of_stock_exchange IN ('make', 'decline')),
  photo text NOT NULL CHECK (photo IN ('none', 'optional', 'required')),
  photo_instructions text NOT NULL DEFAULT '' CHECK (pg_catalog.char_length(photo_instructions) <= 500),
  shipping_payer text NOT NULL CHECK (shipping_payer IN ('shop', 'customer'))
);

-- 最初の値（設計書 8-3）。破損・不良と注文と違う品は、出す・返金と交換・作って送る・写真は必須・返送料はお店。
-- サイズが小さい・大きいは、出す・交換だけ・受けない・写真は任意・返送料はお客様。その他は、出す・返金と交換・受けない・任意・お客様。
-- 色・デザイン・説明と違った・不要になったは出さない。不明（お店が作る時だけ）も出さない
INSERT INTO public.shop_return_reason_settings
  (reason, shown, resolutions, out_of_stock_exchange, photo, photo_instructions, shipping_payer)
VALUES
  ('defective', true, 'refund_and_exchange', 'make', 'required', '傷や不具合の場所がわかる写真をお送りください', 'shop'),
  ('wrong_item', true, 'refund_and_exchange', 'make', 'required', '傷や不具合の場所がわかる写真をお送りください', 'shop'),
  ('size_too_small', true, 'exchange_only', 'decline', 'optional', 'タグの付いた状態がわかる写真をお送りください', 'customer'),
  ('size_too_large', true, 'exchange_only', 'decline', 'optional', 'タグの付いた状態がわかる写真をお送りください', 'customer'),
  ('color', false, 'refund_and_exchange', 'decline', 'optional', '', 'customer'),
  ('style', false, 'refund_and_exchange', 'decline', 'optional', '', 'customer'),
  ('not_as_described', false, 'refund_and_exchange', 'decline', 'optional', '', 'customer'),
  ('unwanted', false, 'refund_and_exchange', 'decline', 'optional', '', 'customer'),
  ('other', true, 'refund_and_exchange', 'decline', 'optional', '', 'customer'),
  ('unknown', false, 'refund_and_exchange', 'decline', 'none', '', 'customer');

-- 7. 行の守りと権限。新しい public の表は anon・authenticated に自動で権限が付くので、まず全部外す。
--    service_role は読むだけ。書くのは SECURITY DEFINER の関数だけ
ALTER TABLE public.order_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_return_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_return_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_return_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_return_reason_settings ENABLE ROW LEVEL SECURITY;

-- 方針は規約（docs/06_Operations/db-migrations.md）の「冪等にする」書き方: DROP POLICY IF EXISTS → CREATE POLICY
DROP POLICY IF EXISTS "deny direct client access" ON public.order_returns;
CREATE POLICY "deny direct client access" ON public.order_returns
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_return_lines;
CREATE POLICY "deny direct client access" ON public.order_return_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_return_receipts;
CREATE POLICY "deny direct client access" ON public.order_return_receipts
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_return_receipt_lines;
CREATE POLICY "deny direct client access" ON public.order_return_receipt_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.shop_return_settings;
CREATE POLICY "deny direct client access" ON public.shop_return_settings
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.shop_return_reason_settings;
CREATE POLICY "deny direct client access" ON public.shop_return_reason_settings
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON public.order_returns FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_return_lines FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_return_receipts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_return_receipt_lines FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.shop_return_settings FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.shop_return_reason_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.order_returns TO service_role;
GRANT SELECT ON public.order_return_lines TO service_role;
GRANT SELECT ON public.order_return_receipts TO service_role;
GRANT SELECT ON public.order_return_receipt_lines TO service_role;
GRANT SELECT ON public.shop_return_settings TO service_role;
GRANT SELECT ON public.shop_return_reason_settings TO service_role;

-- 8. 権限の行。返品を見る・作る・受け取る・取り消す・開き直す・検品する（admin.orders.return）は、店長とサポートの役割に付ける。
--    役割の行が無い手元の DB では、付ける文は何も入れない
INSERT INTO public.permissions (code, name)
VALUES ('admin.orders.return', '注文の返品')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles AS r
JOIN public.permissions AS p ON p.code = 'admin.orders.return'
WHERE r.code IN ('admin', 'supporter')
ON CONFLICT DO NOTHING;

-- 9. 確保中の数（グループ E-2 設計書 7-1）に、交換の品の確保（exchange。−n）を足す。
--    台帳の確保（purchase）・戻し（cancel・refund）・交換の品の確保（exchange）を足して符号を反転する。
--    返品の受け取り（return。+n）は数えない: 受け取った品は発送済みで、確保中の数に戻るものではない
CREATE OR REPLACE FUNCTION private.order_line_reservations(_order_id uuid)
RETURNS TABLE (order_item_id uuid, variant_id bigint, quantity integer, reserved integer)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT oi.id,
         oi.variant_id,
         oi.quantity,
         GREATEST(0, -COALESCE((
           SELECT pg_catalog.sum(m.delta)
           FROM public.stock_movements AS m
           WHERE m.order_item_id = oi.id
             AND m.reason IN ('purchase', 'cancel', 'refund', 'exchange')
         ), 0))::integer
  FROM public.order_items AS oi
  WHERE oi.order_id = _order_id;
$$;

-- 10. 返品の行ごとの数（設計書 4-3・4-8）。窓口・画面・E-2 の返金の数は、全部この数え方を使う（1 か所だけ）。
--     受け取り・検品・届かない・開き直し・返金しないことにした記録（足していく台帳）を足し引きして、行ごとの数を出す。
--       restocked          = 戻した + 検品で戻すと決めた
--       not_restocked      = 戻さない + 検品で戻さないと決めた
--       pending_inspection = 検品待ち − 検品で決めた数
--       sent_back          = お返し
--       missing            = 届かない − 開き直しで打ち消した数
--       processed          = 上の 5 つの和、unprocessed = 返す数 − processed
--       exchanged          = 受け取った品のうち、その受け取りで実際に決まった解決が交換の数（交換の品の行になる数）
--       refund_waived      = 返金しないことにした数（0 円。受け取った返金の品から引く）
--     返金の解決の品は、受け取った品のうち実際の解決が返金の数から、返金しないことにした数を引いた数。解決は返品の行の予定
--     ではなく、受け取りの商品の扱い（resolution）の値で数える（在庫不足で作って送るに変えた・店長が返金に変えた、を反映するため）。
--     覆われた数 refund_covered は、その返品の返金（返事待ち・保留・成功）の行の数を、同じ注文の商品の返金の解決の行に、
--     行を作った順に割り当てる。返金待ち refund_waiting = 返金の解決の品 − 覆われた数。
--     ただし注文の商品ごとに「発送した数 − 返金した数 − (申し込み + 未処理 + 交換 + お返し + 返金しない)」を超えない。
--     超えた分は、ふつうの返金の画面で先に返した品として「覆われた」数に入れる（返品の番号が小さい順、行を作った順）。
--     開き直して受け取った返金の品は、手元に残った品より先に、その品が「届かない」だった間に作った
--     ふつうの発送後の返金（return 以外）だけで覆う（届かないの記録から次の開き直しまで、両端を含む）。
--     開き直した数と、返品の返金・返金しないことで既に終えた分を除く返金待ちの小さい方までを優先する。
--     優先する覆いと上限の超過は大きい方だけを使い、同じ返金を二重に割り当てない。返し足りない時は、
--     減った返金待ちと同じだけ refundable_after_shipment が増えるので、ふつうの返金の画面から補える。
--     お返し・返金しないことにした品をふつうの返金で後から返した時も、その返金は同じ商品の返金待ちの品に当てたものとして
--     数える（上限の式に お返し・返金しない が入っているため。二重の返金を避ける側。C-0 の補足。試験「上限の式の性質」で固める）。
--     完了した返品も数える（返品の返金が失敗すると覆いが外れて、完了した返品でも返金待ちが戻る。本計画 P21）。
--     取消・お断りの返品の行は、受け取りが無いので処理の数は 0（未処理は返す数のまま）。商品ごとの合計には入れない
-- 未保存の受け取り明細も同じ集計に足せるようにし、返金IDを追記専用の記録に書く前にrwの増分を確かめる。
-- 実際の読み出しは下の1引数の関数から空の明細を渡す。rfと開き直した品への優先の覆いは、この本体だけに持つ。
CREATE OR REPLACE FUNCTION private.order_return_line_states_core(_order_id uuid, _receive_lines jsonb)
RETURNS TABLE (
  return_id uuid,
  return_line_id uuid,
  return_number integer,
  return_status text,
  fulfillment_id uuid,
  order_item_id uuid,
  quantity integer,
  restocked integer,
  not_restocked integer,
  pending_inspection integer,
  sent_back integer,
  missing integer,
  processed integer,
  unprocessed integer,
  exchanged integer,
  refund_covered integer,
  refund_waived integer,
  refund_waiting integer
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH base AS (
    SELECT l.id AS line_id,
           l.return_id,
           r.number AS return_number,
           r.status AS return_status,
           l.fulfillment_id,
           l.order_item_id,
           l.quantity,
           l.created_at AS line_created_at
    FROM public.order_return_lines AS l
    JOIN public.order_returns AS r ON r.id = l.return_id
    WHERE r.order_id = _order_id
  ),
  tallied AS (
    SELECT b.*,
           GREATEST(s.restocked + s.inspected_restocked, 0) AS restocked,
           GREATEST(s.not_restocked + s.inspected_not_restocked, 0) AS not_restocked,
           GREATEST(s.pending_inspection - s.inspected_restocked - s.inspected_not_restocked, 0) AS pending_inspection,
           s.sent_back,
           GREATEST(s.missing - s.missing_reopened, 0) AS missing,
           s.received_exchange AS exchanged,
           s.refund_waived,
           s.missing_reopened,
           GREATEST(s.received_refund - s.refund_waived, 0) AS refund_units
    FROM base AS b
    CROSS JOIN LATERAL (
      SELECT COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.disposition = 'restocked'), 0) AS restocked,
             COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.disposition = 'not_restocked'), 0) AS not_restocked,
             COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.disposition = 'pending_inspection'), 0) AS pending_inspection,
             COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.disposition = 'inspected_restocked'), 0) AS inspected_restocked,
             COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.disposition = 'inspected_not_restocked'), 0) AS inspected_not_restocked,
             COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.disposition = 'sent_back'), 0) AS sent_back,
             COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.disposition = 'missing'), 0) AS missing,
             COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.disposition = 'missing_reopened'), 0) AS missing_reopened,
             COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.disposition = 'refund_waived'), 0) AS refund_waived,
             COALESCE(pg_catalog.sum(x.quantity) FILTER (
               WHERE x.disposition IN ('restocked', 'not_restocked', 'pending_inspection') AND x.resolution = 'exchange'
             ), 0) AS received_exchange,
             COALESCE(pg_catalog.sum(x.quantity) FILTER (
               WHERE x.disposition IN ('restocked', 'not_restocked', 'pending_inspection') AND x.resolution = 'refund'
             ), 0) AS received_refund
      FROM (
        SELECT x.quantity, x.disposition, x.resolution
        FROM public.order_return_receipt_lines AS x
        WHERE x.return_line_id = b.line_id
        UNION ALL
        SELECT x.quantity, x.disposition, x.resolution
        FROM pg_catalog.jsonb_to_recordset(_receive_lines)
          AS x(return_line_id uuid, quantity integer, disposition text, resolution text)
        WHERE x.return_line_id = b.line_id
      ) AS x
    ) AS s
  ),
  worked AS (
    SELECT t.*,
           t.restocked + t.not_restocked + t.pending_inspection + t.sent_back + t.missing AS processed,
           COALESCE((
             SELECT pg_catalog.sum(rl.quantity)
             FROM public.order_refund_lines AS rl
             JOIN public.order_refunds AS rf ON rf.id = rl.refund_id
             WHERE rf.return_id = t.return_id
               AND rl.order_item_id = t.order_item_id
               AND NOT rl.before_shipment
               AND rf.status IN ('awaiting_response', 'pending', 'succeeded')
           ), 0) AS return_refunded
    FROM tallied AS t
  ),
  assigned AS (
    SELECT w.*,
           LEAST(
             w.refund_units,
             GREATEST(
               w.return_refunded - COALESCE(pg_catalog.sum(w.refund_units) OVER (
                 PARTITION BY w.return_id, w.order_item_id
                 ORDER BY w.line_created_at, w.line_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ), 0),
               0
             )
           ) AS covered_by_return
    FROM worked AS w
  ),
  line_waiting AS (
    SELECT a.*,
           a.refund_units - a.covered_by_return AS waiting,
           -- 状態の扱いを変える時は、ここ・item_totals・order_line_return_counts の totals・fulfillment_line_returnable の per_line の4か所をそろえる。
           CASE WHEN a.return_status IN ('open', 'closed')
             THEN LEAST(a.missing_reopened, a.refund_units - a.covered_by_return)
             ELSE 0
           END AS reopened_waiting
    FROM assigned AS a
  ),
  item_totals AS (
    -- 状態の扱いを変える時は、ここ・line_waiting の reopened_waiting の CASE・order_line_return_counts の totals・fulfillment_line_returnable の per_line の4か所をそろえる。
    SELECT lw.order_item_id,
           COALESCE(pg_catalog.sum(CASE WHEN lw.return_status = 'requested' THEN lw.quantity ELSE 0 END), 0) AS requested,
           COALESCE(pg_catalog.sum(CASE WHEN lw.return_status = 'open' THEN GREATEST(lw.quantity - lw.processed, 0) ELSE 0 END), 0) AS open_unprocessed,
           COALESCE(pg_catalog.sum(CASE WHEN lw.return_status IN ('open', 'closed') THEN lw.exchanged ELSE 0 END), 0) AS exchanged,
           COALESCE(pg_catalog.sum(CASE WHEN lw.return_status IN ('open', 'closed') THEN lw.sent_back ELSE 0 END), 0) AS sent_back,
           COALESCE(pg_catalog.sum(CASE WHEN lw.return_status IN ('open', 'closed') THEN lw.refund_waived ELSE 0 END), 0) AS refund_waived,
           COALESCE(pg_catalog.sum(CASE WHEN lw.return_status IN ('open', 'closed') THEN lw.waiting ELSE 0 END), 0) AS waiting,
           pg_catalog.sum(lw.reopened_waiting) AS reopened_waiting
    FROM line_waiting AS lw
    GROUP BY lw.order_item_id
  ),
  excess AS (
    SELECT t.order_item_id,
           LEAST(n.quantity, t.reopened_waiting) AS reopened_covered,
           GREATEST(
             t.waiting - GREATEST(
               f.shipped - f.refunded_after_shipment - t.requested - t.open_unprocessed - t.exchanged - t.sent_back - t.refund_waived,
               0
             ),
             LEAST(n.quantity, t.reopened_waiting),
             0
           ) AS excess
    FROM item_totals AS t
    JOIN private.order_line_fulfillment(_order_id) AS f ON f.order_item_id = t.order_item_id
    CROSS JOIN LATERAL (
      -- 手元の品の返金で開き直した品を打ち消さないよう、同じ商品の行の「届かない」から次の開き直しまでに作った返金だけを使う。
      -- 同じ取引では now() が同じになるため窓の両端を含む。開き直しの無い窓は除き、EXISTS で重なる窓も一度だけ数える。
      SELECT COALESCE(pg_catalog.sum(rl.quantity), 0) AS quantity
      FROM public.order_refund_lines AS rl
      JOIN public.order_refunds AS rf ON rf.id = rl.refund_id
      WHERE rl.order_item_id = t.order_item_id
        AND rf.source <> 'return'
        AND NOT rl.before_shipment
        AND rf.status IN ('awaiting_response', 'pending', 'succeeded')
        AND EXISTS (
          SELECT 1
          FROM public.order_return_lines AS l
          JOIN public.order_returns AS rt ON rt.id = l.return_id
          JOIN public.order_return_receipt_lines AS missing ON missing.return_line_id = l.id
          JOIN public.order_return_receipts AS missing_receipt ON missing_receipt.id = missing.receipt_id
          WHERE l.order_item_id = t.order_item_id
            AND rt.order_id = _order_id
            AND rt.status IN ('open', 'closed')
            AND missing.disposition = 'missing'
            AND rf.created_at >= missing_receipt.created_at
            AND rf.created_at <= (
              SELECT pg_catalog.min(reopened_receipt.created_at)
              FROM public.order_return_receipt_lines AS reopened
              JOIN public.order_return_receipts AS reopened_receipt ON reopened_receipt.id = reopened.receipt_id
              WHERE reopened.return_line_id = l.id
                AND reopened.disposition = 'missing_reopened'
                AND reopened_receipt.created_at >= missing_receipt.created_at
            )
        )
    ) AS n
  ),
  prioritized AS (
    -- まず開き直した品へ当てる。複数の返品でも、商品ごとのふつうの返金の数までに抑える。
    SELECT lw.*,
           LEAST(
             lw.reopened_waiting,
             GREATEST(
               e.reopened_covered - COALESCE(pg_catalog.sum(lw.reopened_waiting) OVER (
                 PARTITION BY lw.order_item_id
                 ORDER BY lw.return_number, lw.line_created_at, lw.line_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ), 0),
               0
             )
           ) AS covered_reopened
    FROM line_waiting AS lw
    JOIN excess AS e ON e.order_item_id = lw.order_item_id
  ),
  final AS (
    -- 優先して覆った分を両側から引き、残りの超過だけを従来の順で割り当てる。
    SELECT p.*,
           p.covered_reopened + LEAST(
             p.waiting - p.covered_reopened,
             GREATEST(
               e.excess - e.reopened_covered - COALESCE(pg_catalog.sum(p.waiting - p.covered_reopened) OVER (
                 PARTITION BY p.order_item_id
                 ORDER BY p.return_number, p.line_created_at, p.line_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ), 0),
               0
             )
           ) AS covered_extra
    FROM prioritized AS p
    JOIN excess AS e ON e.order_item_id = p.order_item_id
  )
  SELECT f.return_id,
         f.line_id,
         f.return_number,
         f.return_status,
         f.fulfillment_id,
         f.order_item_id,
         f.quantity,
         f.restocked::integer,
         f.not_restocked::integer,
         f.pending_inspection::integer,
         f.sent_back::integer,
         f.missing::integer,
         f.processed::integer,
         GREATEST(f.quantity - f.processed, 0)::integer,
         f.exchanged::integer,
         (f.covered_by_return + f.covered_extra)::integer,
         f.refund_waived::integer,
         (f.waiting - f.covered_extra)::integer
  FROM final AS f
  ORDER BY f.return_number, f.line_created_at, f.line_id
$$;

-- 呼ぶ側の署名・答えを保ち、保存済みの明細だけを数える。
CREATE OR REPLACE FUNCTION private.order_return_line_states(_order_id uuid)
RETURNS TABLE (
  return_id uuid,
  return_line_id uuid,
  return_number integer,
  return_status text,
  fulfillment_id uuid,
  order_item_id uuid,
  quantity integer,
  restocked integer,
  not_restocked integer,
  pending_inspection integer,
  sent_back integer,
  missing integer,
  processed integer,
  unprocessed integer,
  exchanged integer,
  refund_covered integer,
  refund_waived integer,
  refund_waiting integer
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT * FROM private.order_return_line_states_core(_order_id, '[]'::jsonb)
$$;

-- 1 つの返品の、行ごとの処理の数（C-1 の答えの列）。行を作った順
CREATE OR REPLACE FUNCTION private.order_return_line_progress(_return_id uuid)
RETURNS TABLE (
  return_line_id uuid,
  quantity integer,
  restocked integer,
  not_restocked integer,
  pending_inspection integer,
  sent_back integer,
  missing integer,
  processed integer,
  unprocessed integer,
  exchanged integer,
  refund_covered integer,
  refund_waived integer,
  refund_waiting integer
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT s.return_line_id, s.quantity, s.restocked, s.not_restocked, s.pending_inspection, s.sent_back,
         s.missing, s.processed, s.unprocessed, s.exchanged, s.refund_covered, s.refund_waived, s.refund_waiting
  FROM public.order_returns AS r
  CROSS JOIN LATERAL private.order_return_line_states(r.order_id) AS s
  JOIN public.order_return_lines AS l ON l.id = s.return_line_id
  WHERE r.id = _return_id
    AND s.return_id = r.id
  ORDER BY l.created_at, l.id
$$;

-- 11. 商品ごとの返品の数（Global Constraints の rq・op・rw・ex・sb と返品できる数）。取消・お断りの返品は数えない。
--     返品できる数 = 発送した数 − 返金した数 − 申し込み − 未処理 − 返金待ち − 交換 − お返し − 返金しないことにした数、
--     ふつうの返金の画面で選べる発送済みの数 = 発送した数 − 返金した数 − 申し込み − 未処理 − 返金待ち − 交換
--     （お返しした品と返金しないことにした品はお店の判断で返金できる）。どちらも 0 未満にしない。
--     返金しないことにした品を返品できる数から引くのは、返ってきた品が、返金待ちを 0 円で終えた途端にまた返品できる数に戻らないようにするため。
--     注文の商品は必ず 1 行（返品が無い商品も）
CREATE OR REPLACE FUNCTION private.order_line_return_counts(_order_id uuid)
RETURNS TABLE (
  order_item_id uuid,
  shipped integer,
  refunded_after_shipment integer,
  requested integer,
  open_unprocessed integer,
  refund_waiting integer,
  exchanged integer,
  sent_back integer,
  returnable integer,
  refundable_after_shipment integer
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH totals AS (
    -- 状態の扱いを変える時は、ここ・order_return_line_states_core の item_totals と line_waiting の reopened_waiting の CASE・fulfillment_line_returnable の per_line の4か所をそろえる。
    SELECT s.order_item_id,
           COALESCE(pg_catalog.sum(CASE WHEN s.return_status = 'requested' THEN s.quantity ELSE 0 END), 0)::integer AS requested,
           COALESCE(pg_catalog.sum(CASE WHEN s.return_status = 'open' THEN s.unprocessed ELSE 0 END), 0)::integer AS open_unprocessed,
           COALESCE(pg_catalog.sum(CASE WHEN s.return_status IN ('open', 'closed') THEN s.refund_waiting ELSE 0 END), 0)::integer AS refund_waiting,
           COALESCE(pg_catalog.sum(CASE WHEN s.return_status IN ('open', 'closed') THEN s.exchanged ELSE 0 END), 0)::integer AS exchanged,
           COALESCE(pg_catalog.sum(CASE WHEN s.return_status IN ('open', 'closed') THEN s.sent_back ELSE 0 END), 0)::integer AS sent_back,
           COALESCE(pg_catalog.sum(CASE WHEN s.return_status IN ('open', 'closed') THEN s.refund_waived ELSE 0 END), 0)::integer AS refund_waived
    FROM private.order_return_line_states(_order_id) AS s
    GROUP BY s.order_item_id
  )
  SELECT f.order_item_id,
         f.shipped,
         f.refunded_after_shipment,
         COALESCE(t.requested, 0),
         COALESCE(t.open_unprocessed, 0),
         COALESCE(t.refund_waiting, 0),
         COALESCE(t.exchanged, 0),
         COALESCE(t.sent_back, 0),
         GREATEST(
           f.shipped - f.refunded_after_shipment - COALESCE(t.requested, 0) - COALESCE(t.open_unprocessed, 0)
             - COALESCE(t.refund_waiting, 0) - COALESCE(t.exchanged, 0) - COALESCE(t.sent_back, 0)
             - COALESCE(t.refund_waived, 0),
           0
         ),
         GREATEST(
           f.shipped - f.refunded_after_shipment - COALESCE(t.requested, 0) - COALESCE(t.open_unprocessed, 0)
             - COALESCE(t.refund_waiting, 0) - COALESCE(t.exchanged, 0),
           0
         )
  FROM private.order_line_fulfillment(_order_id) AS f
  LEFT JOIN totals AS t ON t.order_item_id = f.order_item_id
  ORDER BY f.order_item_id
$$;

-- 一覧の 1 ページ分の注文の数を 1 回で読む（list_order_line_fulfillment と同じ作り）。200 件まで
CREATE OR REPLACE FUNCTION public.list_order_line_return_counts(_order_ids uuid[])
RETURNS TABLE (
  order_id uuid,
  order_item_id uuid,
  shipped integer,
  refunded_after_shipment integer,
  requested integer,
  open_unprocessed integer,
  refund_waiting integer,
  exchanged integer,
  sent_back integer,
  returnable integer,
  refundable_after_shipment integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF _order_ids IS NULL OR pg_catalog.cardinality(_order_ids) = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(_order_ids) > 200 THEN
    RAISE EXCEPTION 'TOO_MANY_ORDERS' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT o.id, c.order_item_id, c.shipped, c.refunded_after_shipment, c.requested, c.open_unprocessed,
         c.refund_waiting, c.exchanged, c.sent_back, c.returnable, c.refundable_after_shipment
  FROM public.orders AS o
  CROSS JOIN LATERAL private.order_line_return_counts(o.id) AS c
  WHERE o.id = ANY (_order_ids)
  ORDER BY o.id, c.order_item_id;
END;
$$;

-- 12. 発送の行ごとの返品できる数と期限（設計書 4-9）。取り消していない発送の行だけ（取り消した発送の行は返さない）。
--     返品できる数 = その発送の行の数 − 申し込み・受付中・完了の返品の行の数の合計 + 届かない数（届かない − 開き直し）。0 未満にしない。
--     期限の日付は日本時間。届いた日 = 発送の日（日本時間）+ 目安の日数（配達の記録ができるまで。E-4）、
--     数え始めが「最後の品」の時は、取り消していない発送のうち最も遅い届いた日を全部の発送に使う。
--     期限 = 届いた日 + 日数（日の終わりまで。ここは日付だけ返し、日の終わりは使う側が日本時間で比べる）。無制限の時は NULL
CREATE OR REPLACE FUNCTION private.fulfillment_line_returnable(_order_id uuid)
RETURNS TABLE (
  fulfillment_id uuid,
  fulfillment_number integer,
  shipped_at timestamptz,
  order_item_id uuid,
  quantity integer,
  in_returns integer,
  missing integer,
  returnable integer,
  deadline_date date
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH settings AS (
    SELECT s.window_days, s.window_start, s.delivery_buffer_days
    FROM public.shop_return_settings AS s
    WHERE s.id = 1
  ),
  shipments AS (
    SELECT f.id,
           f.number,
           f.shipped_at,
           ((f.shipped_at AT TIME ZONE 'Asia/Tokyo')::date + s.delivery_buffer_days) AS arrival_date
    FROM public.order_fulfillments AS f
    CROSS JOIN settings AS s
    WHERE f.order_id = _order_id
      AND f.cancelled_at IS NULL
  ),
  per_line AS (
    -- 状態の扱いを変える時は、ここ・order_return_line_states_core の item_totals と line_waiting の reopened_waiting の CASE・order_line_return_counts の totals の4か所をそろえる。
    SELECT st.fulfillment_id,
           st.order_item_id,
           pg_catalog.sum(st.quantity)::integer AS in_returns,
           pg_catalog.sum(st.missing)::integer AS missing
    FROM private.order_return_line_states(_order_id) AS st
    WHERE st.return_status IN ('requested', 'open', 'closed')
    GROUP BY st.fulfillment_id, st.order_item_id
  )
  SELECT sh.id,
         sh.number,
         sh.shipped_at,
         fl.order_item_id,
         fl.quantity,
         COALESCE(p.in_returns, 0),
         COALESCE(p.missing, 0),
         GREATEST(fl.quantity - COALESCE(p.in_returns, 0) + COALESCE(p.missing, 0), 0),
         CASE
           WHEN s.window_days IS NULL THEN NULL
           WHEN s.window_start = 'last_item' THEN (SELECT pg_catalog.max(x.arrival_date) FROM shipments AS x) + s.window_days
           ELSE sh.arrival_date + s.window_days
         END
  FROM shipments AS sh
  JOIN public.order_fulfillment_lines AS fl ON fl.fulfillment_id = sh.id
  CROSS JOIN settings AS s
  LEFT JOIN per_line AS p ON p.fulfillment_id = sh.id AND p.order_item_id = fl.order_item_id
  ORDER BY sh.number, fl.order_item_id
$$;

-- 13. 返品の状態を確かめ直し、完了の条件を満たせば closed にする（設計書 6-7）。答えは今の status（返品が無ければ NULL）。
--     完了の条件: 全部の品が処理され、検品待ち・返金待ち・お支払い待ち（fee_due_amount > 0 で fee_received_at が空）が無い。
--     動かすのは受付中の返品だけ。申し込み・取消・お断りはそのままで、完了した返品を受付中へ戻すこともしない
--     （戻すのは開き直し。返品の返金が失敗して返金待ちが戻っても、記録の状態は完了のまま。本計画 P19・P21）。
--     閉じる時は closed_at を今の時刻に書く。開き直し（移行 B）は closed_at を消さないので、開き直した返品を閉じ直す時は、
--     前の完了の時刻を新しい時刻に書き直す。
--     呼ぶ側（受け取り・額を決めて返金・返金の結果・届かないで終える・手数料の受け取りなど）が、注文の鍵を持っている
CREATE OR REPLACE FUNCTION private.refresh_order_return_status(_return_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_return public.order_returns;
  v_blocked boolean;
BEGIN
  SELECT r.* INTO v_return FROM public.order_returns AS r WHERE r.id = _return_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_return.status <> 'open' THEN
    RETURN v_return.status;
  END IF;

  SELECT EXISTS (
           SELECT 1
           FROM private.order_return_line_states(v_return.order_id) AS s
           WHERE s.return_id = v_return.id
             AND (s.unprocessed > 0 OR s.pending_inspection > 0 OR s.refund_waiting > 0)
         )
         OR (v_return.fee_due_amount > 0 AND v_return.fee_received_at IS NULL)
  INTO v_blocked;

  IF v_blocked THEN
    RETURN v_return.status;
  END IF;

  UPDATE public.order_returns AS r
  SET status = 'closed',
      closed_at = pg_catalog.now()
  WHERE r.id = v_return.id;
  RETURN 'closed';
END;
$$;

-- 14. 返品の設定を読む（設計書 11-2）。答えは TS の ShopReturnSettings（C-2）のキーを snake_case にした JSON。
--     返送先は 4 つとも空なら null。理由ごとの設定は理由の決まった順。最後に変えた人のメールは auth.users から読む
CREATE OR REPLACE FUNCTION public.get_shop_return_settings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'requests_enabled', s.requests_enabled,
    'request_types', s.request_types,
    'notice_text', s.notice_text,
    'window_days', s.window_days,
    'window_start', s.window_start,
    'delivery_buffer_days', s.delivery_buffer_days,
    'return_address', CASE
      WHEN s.return_address_name IS NULL THEN NULL
      ELSE pg_catalog.jsonb_build_object(
        'name', s.return_address_name,
        'postal_code', s.return_address_postal_code,
        'address', s.return_address_line,
        'phone', s.return_address_phone
      )
    END,
    'customer_paid_method', s.customer_paid_method,
    'shop_label_fee', s.shop_label_fee,
    'no_return_needed_enabled', s.no_return_needed_enabled,
    'restocking_fee_enabled', s.restocking_fee_enabled,
    'restocking_fee_percent', s.restocking_fee_percent,
    'exchange_fees_enabled', s.exchange_fees_enabled,
    'exchange_fee', s.exchange_fee,
    'exchange_shipping_fee', s.exchange_shipping_fee,
    'inspection_enabled', s.inspection_enabled,
    'reasons', COALESCE((
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'reason', r.reason,
                 'shown', r.shown,
                 'resolutions', r.resolutions,
                 'out_of_stock_exchange', r.out_of_stock_exchange,
                 'photo', r.photo,
                 'photo_instructions', r.photo_instructions,
                 'shipping_payer', r.shipping_payer
               )
               ORDER BY pg_catalog.array_position(
                 ARRAY['defective', 'wrong_item', 'size_too_small', 'size_too_large', 'color', 'style',
                       'not_as_described', 'unwanted', 'other', 'unknown']::text[],
                 r.reason
               )
             )
      FROM public.shop_return_reason_settings AS r
    ), '[]'::jsonb),
    'updated', pg_catalog.jsonb_build_object(
      'requests', pg_catalog.jsonb_build_object('at', s.requests_updated_at, 'by_email', u1.email::text),
      'window', pg_catalog.jsonb_build_object('at', s.window_updated_at, 'by_email', u2.email::text),
      'shipping', pg_catalog.jsonb_build_object('at', s.shipping_updated_at, 'by_email', u3.email::text),
      'reasons', pg_catalog.jsonb_build_object('at', s.reasons_updated_at, 'by_email', u4.email::text),
      'fees', pg_catalog.jsonb_build_object('at', s.fees_updated_at, 'by_email', u5.email::text),
      'receiving', pg_catalog.jsonb_build_object('at', s.receiving_updated_at, 'by_email', u6.email::text)
    )
  )
  FROM public.shop_return_settings AS s
  LEFT JOIN auth.users AS u1 ON u1.id = s.requests_updated_by
  LEFT JOIN auth.users AS u2 ON u2.id = s.window_updated_by
  LEFT JOIN auth.users AS u3 ON u3.id = s.shipping_updated_by
  LEFT JOIN auth.users AS u4 ON u4.id = s.reasons_updated_by
  LEFT JOIN auth.users AS u5 ON u5.id = s.fees_updated_by
  LEFT JOIN auth.users AS u6 ON u6.id = s.receiving_updated_by
  WHERE s.id = 1
$$;

-- 15. 在庫の履歴に、どの返品で動いたかを出す（設計書 8-1）。最後の列に return_id を足すので消して作り直す。
--     本文は移行 A（20261011222930_order_refund_records.sql）のままで、返品の番号の列を足しただけ。
--     変わった後の数は、今の在庫数からその行より後の動きの合計を引いて出す（今のまま）
DROP FUNCTION public.list_item_stock_history(bigint, integer);

CREATE FUNCTION public.list_item_stock_history(_item_id bigint, _limit integer)
RETURNS TABLE (
  movement_id bigint,
  variant_id bigint,
  delta integer,
  reason text,
  note text,
  created_at timestamptz,
  actor_email text,
  order_id uuid,
  balance_after integer,
  refund_id uuid,
  return_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT h.id, h.variant_id, h.delta, h.reason, h.note, h.created_at, h.actor_email, h.order_id, h.balance_after,
         h.refund_id, h.return_id
  FROM (
    SELECT m.id,
           m.variant_id,
           m.delta,
           m.reason,
           m.note,
           m.created_at,
           u.email::text AS actor_email,
           m.order_id,
           (v.stock_quantity - COALESCE(pg_catalog.sum(m.delta) OVER (
             PARTITION BY m.variant_id
             ORDER BY m.id DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ), 0))::integer AS balance_after,
           m.refund_id,
           m.return_id
    FROM public.stock_movements AS m
    JOIN public.item_variants AS v ON v.id = m.variant_id
    LEFT JOIN auth.users AS u ON u.id = m.created_by
    WHERE v.item_id = _item_id
  ) AS h
  ORDER BY h.id DESC
  LIMIT LEAST(GREATEST(COALESCE(_limit, 50), 1), 200)
$$;

-- 16. 関数の権限。private の関数は PUBLIC から外すだけ。public の関数は service_role だけが実行できる
--     （作り直した関数は権限が初期に戻るので付け直す）
REVOKE ALL ON FUNCTION private.guard_order_return_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.reject_order_return_record_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.check_return_line_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.check_receipt_line_return() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_order_email(uuid, text, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_line_reservations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_return_line_states_core(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_return_line_states(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_return_line_progress(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_line_return_counts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fulfillment_line_returnable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refresh_order_return_status(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.list_order_line_return_counts(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_shop_return_settings() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_item_stock_history(bigint, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.list_order_line_return_counts(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_shop_return_settings() TO service_role;
GRANT EXECUTE ON FUNCTION public.list_item_stock_history(bigint, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
