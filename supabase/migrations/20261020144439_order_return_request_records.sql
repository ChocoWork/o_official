-- 返品の申し込みの記録と守り（グループ E-3 段 2 設計書 4-5・4-6・4-7・10-3・11-1）の移行 D
--
-- 申し込みの写真の送り先と写真（2 つの表）、キャンセルの申し込みとその行（2 つの表）、商品の返品不可の列、
-- 注文のメールの表のキャンセルの申し込みの番号の列・新しい 6 つの種類・番号の組の決まり・一意の索引、
-- 返品の表と返品の行の守りの作り直し（申し込みを承認する 1 回の更新でだけ、承認で決める列を直せる）、
-- 写真の置き場の入れ物 return-photos、定期処理の最後の成功の印 return_photo_purge を足す。
-- あわせて、注文のメールを取り出す関数 claim_order_email の答えの最後に cancel_request_id を足す
-- （worker がキャンセルの申し込みのメールの材料を引くため）。
-- 表は public に置き、書くのは SECURITY DEFINER の関数だけ（service_role は読むだけ）。
-- お客様の申し込みの関数は移行 E、承認・お断り・キャンセルの申し込みの扱い・写真を消す処理の関数は移行 F で作る。
-- 段 1 の移行 A〜C（20261012235910_order_return_records.sql・20261013000456_order_return_actions.sql・
-- 20261013001143_order_return_receipts.sql）の後に当てる。段 1 の移行は本番に当てた物なので直さない。
-- 作り直す関数（guard_order_return_change・enqueue_order_email・claim_order_email）の本文は、段 1 の最後の版
-- （guard_order_return_change は移行 A、enqueue_order_email と claim_order_email は移行 C）を一字ずつ写し、
-- 変えた所に「段 2 で変えた」と印を付けた。
BEGIN;

-- 1. 商品の返品不可の印（設計書 4-7）。印の付いた品は、お客様の申し込みでは理由を破損・不良と注文と違う品の 2 つに絞る
--    （絞る確かめは移行 E の関数が行う）。お店が作る返品では止めず、警告を出すだけ
ALTER TABLE public.items
  ADD COLUMN return_ineligible boolean NOT NULL DEFAULT false;

-- 2. 写真の送り先（出した署名つきの送り先 1 つが 1 行）と、申し込みに付いた写真（設計書 4-5）。
--    お客様の列 customer_id は外部キーにしない（段 1 の「した人」の列と同じ考え。利用者の削除で止まらないように）。
--    場所 storage_path は requests/{注文の番号}/{送り先の番号}。一意の制約と CHECK には、自動で付く名前と同じ名前を明示する
--    （移行 E・F の関数が、制約の名前でぶつかりを見分ける）。
--    attached_at は申し込みに使った時刻、purged_at は置き場から消した時刻。どちらも空から値へ 1 回だけ進む（下の守り）
CREATE TABLE public.order_return_photo_uploads (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders (id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  storage_path text NOT NULL
    CONSTRAINT order_return_photo_uploads_storage_path_key UNIQUE
    CONSTRAINT order_return_photo_uploads_storage_path_check CHECK (storage_path ~ '^requests/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  attached_at timestamptz,
  purged_at timestamptz
);

-- 申し込みに付いた写真。送り先 1 つにつき写真は 1 枚（upload_id の一意の制約）。
-- size_bytes は撮影の情報を消した後の大きさ。1 つの返品の行に 5 枚まで、は移行 E の関数が数える
CREATE TABLE public.order_return_photos (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  return_line_id uuid NOT NULL REFERENCES public.order_return_lines (id) ON DELETE RESTRICT,
  upload_id uuid NOT NULL
    CONSTRAINT order_return_photos_upload_id_key UNIQUE
    REFERENCES public.order_return_photo_uploads (id) ON DELETE RESTRICT,
  storage_path text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  purged_at timestamptz
);

CREATE INDEX order_return_photo_uploads_order_idx ON public.order_return_photo_uploads (order_id, created_at);
CREATE INDEX order_return_photo_uploads_unattached_idx ON public.order_return_photo_uploads (created_at)
  WHERE attached_at IS NULL AND purged_at IS NULL;
CREATE INDEX order_return_photos_line_idx ON public.order_return_photos (return_line_id);

-- 3. キャンセルの申し込み（設計書 4-6）とその行。
--    状態ごとの決まりは表の CHECK order_cancel_requests_state_check が持つ（申し込み中は終わりの時刻を持たない、
--    お断りは時刻・理由・メッセージが要る、解決は返金か取消のどちらか 1 つ、解決済みは時刻が要る）。
--    開いている（申し込み中の）申し込みは注文に 1 つだけ（部分一意の索引 order_cancel_requests_open_idx）。
--    ご連絡事項 customer_note は、前後の空白を外して空なら空にして入れる（移行 E の関数が整える）
CREATE TABLE public.order_cancel_requests (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders (id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('requested', 'resolved', 'declined', 'closed')),
  request_key uuid NOT NULL CONSTRAINT order_cancel_requests_request_key_key UNIQUE,
  request_fingerprint text NOT NULL,
  customer_note text CHECK (pg_catalog.char_length(customer_note) <= 300),
  requested_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  requested_by uuid NOT NULL,
  decline_reason text CHECK (decline_reason IN ('window_passed', 'final_sale', 'other')),
  decline_message text CHECK (pg_catalog.char_length(decline_message) <= 1000),
  declined_at timestamptz,
  declined_by uuid,
  resolved_at timestamptz,
  resolved_by uuid,
  resolved_refund_id uuid REFERENCES public.order_refunds (id) ON DELETE RESTRICT,
  resolved_by_cancel_at timestamptz,
  closed_at timestamptz,
  closed_by uuid,
  CONSTRAINT order_cancel_requests_state_check CHECK (
    (status = 'requested' AND declined_at IS NULL AND resolved_at IS NULL AND closed_at IS NULL)
    OR (status = 'declined' AND declined_at IS NOT NULL AND decline_reason IS NOT NULL AND decline_message IS NOT NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL AND ((resolved_refund_id IS NOT NULL) <> (resolved_by_cancel_at IS NOT NULL)))
    OR (status = 'closed' AND closed_at IS NOT NULL)
  )
);

CREATE TABLE public.order_cancel_request_lines (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  cancel_request_id uuid NOT NULL REFERENCES public.order_cancel_requests (id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL REFERENCES public.order_items (id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity >= 1),
  CONSTRAINT order_cancel_request_lines_request_item_key UNIQUE (cancel_request_id, order_item_id)
);

CREATE UNIQUE INDEX order_cancel_requests_open_idx ON public.order_cancel_requests (order_id)
  WHERE status = 'requested';
CREATE INDEX order_cancel_requests_order_idx ON public.order_cancel_requests (order_id, requested_at DESC);
CREATE INDEX order_cancel_requests_refund_idx ON public.order_cancel_requests (resolved_refund_id)
  WHERE resolved_refund_id IS NOT NULL;
-- 行の order_item_id は外部キーなので索引を付ける（Supabase の助言 0001。申し込みごとの引きは上の一意の制約が兼ねる）
CREATE INDEX order_cancel_request_lines_order_item_idx ON public.order_cancel_request_lines (order_item_id);

-- 4. 守り。書くのは SECURITY DEFINER の関数だけだが、関数の書き間違いも DB で止める（段 1 の表と同じ考え）。
--    エラーの文字は段 1 の ORDER_RETURN_* に揃える。
--    文のトリガー（TRUNCATE）には OLD も NEW も無いので、関数は先に TG_OP を見て抜ける

-- 写真の送り先: 消せない。直せるのは使った時刻と消した時刻だけで、どちらも空から値へ 1 回だけ進む
CREATE OR REPLACE FUNCTION private.guard_return_photo_upload_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_movable CONSTANT text[] := ARRAY['attached_at', 'purged_at'];
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'ORDER_RETURN_APPEND_ONLY' USING ERRCODE = '23514';
  END IF;

  IF (pg_catalog.to_jsonb(NEW) - v_movable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_movable) THEN
    RAISE EXCEPTION 'ORDER_RETURN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  -- 時刻が入った後は、別の値にも空にも戻さない（同じ値への書き直しは通す）
  IF (OLD.attached_at IS NOT NULL AND NEW.attached_at IS DISTINCT FROM OLD.attached_at)
     OR (OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at) THEN
    RAISE EXCEPTION 'ORDER_RETURN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- 写真: 消せない。直せるのは消した時刻だけで、空から値へ 1 回だけ進む
CREATE OR REPLACE FUNCTION private.guard_return_photo_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_movable CONSTANT text[] := ARRAY['purged_at'];
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'ORDER_RETURN_APPEND_ONLY' USING ERRCODE = '23514';
  END IF;

  IF (pg_catalog.to_jsonb(NEW) - v_movable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_movable) THEN
    RAISE EXCEPTION 'ORDER_RETURN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
    RAISE EXCEPTION 'ORDER_RETURN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- キャンセルの申し込み: 消せない。直せるのは状態・時刻・する人・お断り・解決の列だけ。
-- 申し込み中の行だけが、状態を変える更新でお断り・解決・解決済みへ進む。状態を変えない書き直しと、終わった行の更新は断る
CREATE OR REPLACE FUNCTION private.guard_order_cancel_request_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_movable CONSTANT text[] := ARRAY[
    'status', 'decline_reason', 'decline_message', 'declined_at', 'declined_by',
    'resolved_at', 'resolved_by', 'resolved_refund_id', 'resolved_by_cancel_at',
    'closed_at', 'closed_by'
  ];
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'ORDER_CANCEL_REQUEST_APPEND_ONLY' USING ERRCODE = '23514';
  END IF;

  IF (pg_catalog.to_jsonb(NEW) - v_movable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_movable) THEN
    RAISE EXCEPTION 'ORDER_CANCEL_REQUEST_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD.status <> 'requested' THEN
    RAISE EXCEPTION 'ORDER_CANCEL_REQUEST_INVALID_TRANSITION' USING ERRCODE = '23514';
  END IF;

  -- 申し込み中の行が通れるのは、お断り・解決・解決済みへ進む更新だけ（状態を変えない書き直しは、直せる列でも断る）
  IF NEW.status = 'requested' THEN
    RAISE EXCEPTION 'ORDER_CANCEL_REQUEST_INVALID_TRANSITION' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- キャンセルの申し込みの行: 足した後は直せない・消せない
CREATE OR REPLACE FUNCTION private.reject_order_cancel_request_line_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'ORDER_CANCEL_REQUEST_APPEND_ONLY' USING ERRCODE = '23514';
END;
$$;

-- キャンセルの申し込みの行は、その申し込みの注文の品だけを指す
CREATE OR REPLACE FUNCTION private.check_cancel_request_line_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.order_cancel_requests AS r
    JOIN public.order_items AS oi ON oi.order_id = r.order_id
    WHERE r.id = NEW.cancel_request_id
      AND oi.id = NEW.order_item_id
  ) THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_LINE_NOT_IN_ORDER' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_return_photo_uploads_guard
  BEFORE UPDATE OR DELETE ON public.order_return_photo_uploads
  FOR EACH ROW EXECUTE FUNCTION private.guard_return_photo_upload_change();
CREATE TRIGGER order_return_photo_uploads_no_truncate
  BEFORE TRUNCATE ON public.order_return_photo_uploads
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_return_photo_upload_change();

CREATE TRIGGER order_return_photos_guard
  BEFORE UPDATE OR DELETE ON public.order_return_photos
  FOR EACH ROW EXECUTE FUNCTION private.guard_return_photo_change();
CREATE TRIGGER order_return_photos_no_truncate
  BEFORE TRUNCATE ON public.order_return_photos
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_return_photo_change();

CREATE TRIGGER order_cancel_requests_guard
  BEFORE UPDATE OR DELETE ON public.order_cancel_requests
  FOR EACH ROW EXECUTE FUNCTION private.guard_order_cancel_request_change();
CREATE TRIGGER order_cancel_requests_no_truncate
  BEFORE TRUNCATE ON public.order_cancel_requests
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_order_cancel_request_change();

CREATE TRIGGER order_cancel_request_lines_no_change
  BEFORE UPDATE OR DELETE ON public.order_cancel_request_lines
  FOR EACH ROW EXECUTE FUNCTION private.reject_order_cancel_request_line_change();
CREATE TRIGGER order_cancel_request_lines_no_truncate
  BEFORE TRUNCATE ON public.order_cancel_request_lines
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_order_cancel_request_line_change();
CREATE TRIGGER order_cancel_request_lines_order_check
  BEFORE INSERT ON public.order_cancel_request_lines
  FOR EACH ROW EXECUTE FUNCTION private.check_cancel_request_line_order();

-- 5. 返品の表の守りの作り直し（P2）。本文は段 1 の移行 A（20261012235910_order_return_records.sql）のままで、
--    段 2 で変えたのは「申し込み（requested）を承認して受付中（open）に進める 1 回の更新でだけ、承認で決める 10 列
--    （v_approvable）も変えてよい」の枝だけ。お断り（requested → declined）・申し込み中のままの更新・受付中の返品の
--    更新では、10 列は今までどおり変えられない
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
  -- 段 2 で足した: 承認（requested → open）の 1 回の更新でだけ変えてよい列
  v_approvable CONSTANT text[] := ARRAY[
    'return_method', 'return_shipping_payer', 'return_carrier', 'return_tracking_number', 'return_shipping_fee',
    'restocking_fee_percent', 'exchange_fee', 'exchange_shipping_fee', 'notify_customer', 'shop_note'
  ];
BEGIN
  -- DELETE と TRUNCATE。文のトリガーには OLD も NEW も無いので、先に抜ける
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'ORDER_RETURN_APPEND_ONLY' USING ERRCODE = '23514';
  END IF;

  -- 段 2 で変えた: 承認の更新だけ、v_approvable も変えてよい列に数える
  IF OLD.status = 'requested' AND NEW.status = 'open' THEN
    IF (pg_catalog.to_jsonb(NEW) - v_movable - v_approvable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_movable - v_approvable) THEN
      RAISE EXCEPTION 'ORDER_RETURN_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  ELSIF (pg_catalog.to_jsonb(NEW) - v_movable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_movable) THEN
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

-- 返品の行の守り（P2）。段 1 の order_return_lines_no_change（更新・削除を断る）を消し、削除だけを断るトリガーと、
-- 更新を守るトリガーに分ける。更新は、変わる列が resolution・exchange_variant_id・exchange_method の中だけで、
-- 親の返品の状態が requested の間だけ許す（申し込みの時の仮の値を、承認の時に直すため）。
-- 数・理由・詳しい内容・ご希望・発送の行・作った時刻は、申し込み中でも直せない。TRUNCATE を断るトリガーは段 1 のまま。
-- 承認の関数（移行 F）は、行を直してから返品を open にする（返品が open になると、行はもう直せない）
CREATE OR REPLACE FUNCTION private.guard_order_return_line_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_movable CONSTANT text[] := ARRAY['resolution', 'exchange_variant_id', 'exchange_method'];
  v_status text;
BEGIN
  IF (pg_catalog.to_jsonb(NEW) - v_movable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_movable) THEN
    RAISE EXCEPTION 'ORDER_RETURN_APPEND_ONLY' USING ERRCODE = '23514';
  END IF;

  SELECT r.status INTO v_status FROM public.order_returns AS r WHERE r.id = OLD.return_id;
  IF v_status IS DISTINCT FROM 'requested' THEN
    RAISE EXCEPTION 'ORDER_RETURN_APPEND_ONLY' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER order_return_lines_no_change ON public.order_return_lines;
CREATE TRIGGER order_return_lines_no_delete
  BEFORE DELETE ON public.order_return_lines
  FOR EACH ROW EXECUTE FUNCTION private.reject_order_return_record_change();
CREATE TRIGGER order_return_lines_review_guard
  BEFORE UPDATE ON public.order_return_lines
  FOR EACH ROW EXECUTE FUNCTION private.guard_order_return_line_change();

-- 6. 注文のメールの表: キャンセルの申し込みの番号の列、種類・書き分け・番号の組の CHECK、一意の索引（P12）。
--    CHECK と索引を作り直す所は、段 1 の移行 A が付けた名前（order_email_outbox_kind_check・order_email_outbox_variant_check・
--    order_email_outbox_return_check・order_email_outbox_auto_return_idx・order_email_outbox_auto_once_idx）を、
--    手元の DB の pg_constraint・pg_indexes で確かめてから消す。名前が違えば、ここで止まる（黙って古い物が残らないようにする）。
--    返品の記録は消せないので、外部キーの消す時の決まりは RESTRICT。
--    種類・書き分けの CHECK の書き方は段 1 の移行 A に合わせる（tests/unit/lib/orders/email/order-email-types.test.ts が SQL の文字から種類を読む）
ALTER TABLE private.order_email_outbox
  ADD COLUMN cancel_request_id uuid REFERENCES public.order_cancel_requests (id) ON DELETE RESTRICT;

ALTER TABLE private.order_email_outbox DROP CONSTRAINT order_email_outbox_kind_check;
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_kind_check
  CHECK (kind IN (
    'paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped', 'refund',
    'return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop',
    'return_requested', 'return_declined', 'return_request_shop',
    'cancel_request_received', 'cancel_request_declined', 'cancel_request_shop'
  ));

-- 書き分け: 新しい 6 つの種類は書き分けを持たない
ALTER TABLE private.order_email_outbox DROP CONSTRAINT order_email_outbox_variant_check;
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_variant_check CHECK (
    (kind = 'paid' AND variant IS NOT NULL
      AND variant IN ('order_confirmed', 'payment_received', 'payment_received_after_expiry'))
    OR (kind = 'canceled' AND variant IS NOT NULL AND variant IN ('payment_in_progress', 'pending', 'paid'))
    OR (kind = 'refund' AND variant IS NOT NULL AND variant IN ('standard', 'after_cancel', 'return'))
    OR (kind IN (
      'awaiting_payment', 'payment_expired', 'shipped',
      'return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop',
      'return_requested', 'return_declined', 'return_request_shop',
      'cancel_request_received', 'cancel_request_declined', 'cancel_request_shop'
    ) AND variant IS NULL)
  );

-- 返品の番号と受け取りの番号の持ち方。
--   ・return_accepted・return_requested・return_declined・return_request_shop: 返品の番号が要り、受け取りの番号は持たない
--   ・return_received・return_sent_back・return_refund_pending_shop: 返品の番号と受け取りの番号の両方が要る
--   ・refund（返金のお知らせ）: 段 1 のまま（返品の返金は返品の番号を持ち、受け取りと一緒に返した時は受け取りの番号も持つ）
--   ・ほかの種類（キャンセルの申し込みの 3 つを含む）: どちらも持たない
ALTER TABLE private.order_email_outbox DROP CONSTRAINT order_email_outbox_return_check;
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_return_check CHECK (
    (kind IN ('return_accepted', 'return_requested', 'return_declined', 'return_request_shop')
      AND return_id IS NOT NULL AND return_receipt_id IS NULL)
    OR (kind IN ('return_received', 'return_sent_back', 'return_refund_pending_shop')
        AND return_id IS NOT NULL AND return_receipt_id IS NOT NULL)
    OR (kind = 'refund' AND (return_receipt_id IS NULL OR return_id IS NOT NULL)
        AND ((variant = 'return') = (return_id IS NOT NULL)))
    OR (kind NOT IN ('return_accepted', 'return_requested', 'return_declined', 'return_request_shop',
                     'return_received', 'return_sent_back', 'return_refund_pending_shop', 'refund')
        AND return_id IS NULL AND return_receipt_id IS NULL)
  );

-- キャンセルの申し込みの番号は、キャンセルの申し込みの 3 つの種類だけが持ち、3 つは必ず持つ
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_cancel_request_check
  CHECK ((kind IN ('cancel_request_received', 'cancel_request_declined', 'cancel_request_shop')) = (cancel_request_id IS NOT NULL));

-- 一意の決まり。自動の行は、
--   ・返品の 4 つの種類（return_accepted・return_requested・return_declined・return_request_shop）が返品ごと・種類ごとに 1 行
--     （段 1 の索引は return_accepted だけで返品ごとに 1 行だったので、(return_id, kind) の索引に作り直す）
--   ・キャンセルの申し込みの 3 つの種類が申し込みごと・種類ごとに 1 行（新しい索引）
--   ・受け取りの 3 つと受け取りの番号を持つ返金のお知らせは、段 1 の order_email_outbox_auto_return_receipt_idx のまま
-- 1 注文に何通もあってよい種類は、今の「1 注文 1 種類 1 行」の索引（order_email_outbox_auto_once_idx）から外して作り直す。
-- 外さないと、同じ注文の 2 つ目の返品やキャンセルの申し込みのお知らせが一意の制約で落ちる
DROP INDEX private.order_email_outbox_auto_return_idx;
CREATE UNIQUE INDEX order_email_outbox_auto_return_idx
  ON private.order_email_outbox (return_id, kind)
  WHERE origin = 'auto' AND kind IN ('return_accepted', 'return_requested', 'return_declined', 'return_request_shop');

CREATE UNIQUE INDEX order_email_outbox_auto_cancel_request_idx
  ON private.order_email_outbox (cancel_request_id, kind)
  WHERE origin = 'auto' AND cancel_request_id IS NOT NULL;

DROP INDEX private.order_email_outbox_auto_once_idx;
CREATE UNIQUE INDEX order_email_outbox_auto_once_idx
  ON private.order_email_outbox (order_id, kind)
  WHERE origin = 'auto' AND kind <> 'shipped' AND refund_id IS NULL
    AND kind NOT IN ('return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop', 'return_requested', 'return_declined', 'return_request_shop', 'cancel_request_received', 'cancel_request_declined', 'cancel_request_shop');

-- 予定を書く関数の作り直し。引数と答えは段 1 の移行 C（20261013001143_order_return_receipts.sql）のまま。
-- 本文も段 1 の移行 C のままで、段 2 で変えたのは最後の枝の ON CONFLICT の WHERE だけ
-- （上の order_email_outbox_auto_once_idx の述語と同じ字にする。WHERE が索引の述語を含まないと
-- 「there is no unique or exclusion constraint matching the ON CONFLICT specification」で落ち、返品に関係ない
-- 全部のメール（入金済み・取消・入金待ちなど）の予定が書けなくなる）。
-- 返品・キャンセルの申し込みのお知らせは、番号を持つ移行 E の関数（private.enqueue_return_email・
-- private.enqueue_cancel_request_email）で書く。この関数で書くと CHECK で断られる
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
DECLARE v_return uuid; v_receipt uuid;
BEGIN
  SELECT r.return_id INTO v_return FROM public.order_refunds AS r WHERE r.id=_refund_id;
  SELECT rr.id INTO v_receipt FROM public.order_return_receipts AS rr WHERE rr.refund_id=_refund_id;
  IF _kind = 'shipped' THEN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, refund_id, return_id, return_receipt_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id, _refund_id, v_return, v_receipt)
    ON CONFLICT (fulfillment_id) WHERE origin = 'auto' AND kind = 'shipped' DO NOTHING;
  ELSIF _refund_id IS NOT NULL THEN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, refund_id, return_id, return_receipt_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id, _refund_id, v_return, v_receipt)
    ON CONFLICT (refund_id, kind) WHERE origin = 'auto' AND refund_id IS NOT NULL DO NOTHING;
  ELSE
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, refund_id, return_id, return_receipt_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id, _refund_id, v_return, v_receipt)
    ON CONFLICT (order_id, kind)
      WHERE origin = 'auto' AND kind <> 'shipped' AND refund_id IS NULL
        AND kind NOT IN ('return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop', 'return_requested', 'return_declined', 'return_request_shop', 'cancel_request_received', 'cancel_request_declined', 'cancel_request_shop')
      DO NOTHING;
  END IF;
  RETURN FOUND;
END;
$$;

-- 注文のメールを取り出す関数の作り直し。本文は段 1 の移行 C（20261013001143_order_return_receipts.sql）のままで、
-- 段 2 で変えたのは、答えの最後の列に cancel_request_id を足した 3 か所（RETURNS TABLE・RETURNING・最後の SELECT）だけ。
-- worker がキャンセルの申し込みのメールの材料（申し込みの行）を引くのに要る。
-- 答えの列が変わるので、消して作り直す（同じ名前の関数が 2 つ残ると Data API が呼び分けられない）
DROP FUNCTION IF EXISTS public.claim_order_email(integer);
CREATE OR REPLACE FUNCTION public.claim_order_email(_lease_seconds integer)
RETURNS TABLE (
  email_id uuid,
  order_id uuid,
  kind text,
  variant text,
  origin text,
  attempts integer,
  lease_token uuid,
  subject text,
  body_text text,
  payment_expired_sent boolean,
  fulfillment_id uuid,
  refund_id uuid,
  return_id uuid,
  return_receipt_id uuid,
  cancel_request_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_paused boolean;
  v_next_probe_at timestamptz;
BEGIN
  IF _lease_seconds IS NULL OR _lease_seconds < 30 OR _lease_seconds > 900 THEN
    RAISE EXCEPTION 'INVALID_LEASE_SECONDS' USING ERRCODE = '22023';
  END IF;

  UPDATE private.order_email_outbox AS e
  SET status = CASE WHEN e.attempts >= private.order_email_max_attempts() THEN 'dead' ELSE 'retry_wait' END,
      finished_at = CASE WHEN e.attempts >= private.order_email_max_attempts() THEN pg_catalog.now() END,
      subject = CASE WHEN e.attempts >= private.order_email_max_attempts() THEN NULL ELSE e.subject END,
      body_text = CASE WHEN e.attempts >= private.order_email_max_attempts() THEN NULL ELSE e.body_text END,
      body_erased_at = CASE
        WHEN e.attempts >= private.order_email_max_attempts() AND e.subject IS NOT NULL THEN pg_catalog.now()
        ELSE e.body_erased_at
      END,
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error_code = 'lease_expired',
      next_attempt_at = pg_catalog.now() + private.order_email_retry_delay(e.attempts)
  WHERE e.status = 'sending'
    AND e.lease_expires_at <= pg_catalog.now();

  -- 止めていない間は一時停止の行をロックしない（同時に動く worker の取り出しを待たせない）
  SELECT p.paused INTO v_paused FROM private.order_email_send_pause AS p WHERE p.id;
  IF v_paused THEN
    SELECT p.paused, p.next_probe_at INTO v_paused, v_next_probe_at
    FROM private.order_email_send_pause AS p
    WHERE p.id
    FOR UPDATE;

    IF v_paused THEN
      IF v_next_probe_at > pg_catalog.now() THEN
        RETURN;
      END IF;
      UPDATE private.order_email_send_pause AS p
      SET next_probe_at = pg_catalog.now() + interval '15 minutes',
          updated_at = pg_catalog.now()
      WHERE p.id;
    END IF;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT e.id
    FROM private.order_email_outbox AS e
    WHERE e.status IN ('pending', 'retry_wait')
      AND e.next_attempt_at <= pg_catalog.now()
      AND NOT EXISTS (
        SELECT 1
        FROM private.order_email_outbox AS earlier
        WHERE earlier.order_id = e.order_id
          AND earlier.seq < e.seq
          AND earlier.status IN ('pending', 'sending', 'retry_wait')
      )
    ORDER BY e.next_attempt_at, e.seq
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ),
  claimed AS (
    UPDATE private.order_email_outbox AS e
    SET status = 'sending',
        attempts = e.attempts + 1,
        lease_token = pg_catalog.gen_random_uuid(),
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => _lease_seconds),
        last_error_code = NULL
    FROM candidate AS c
    WHERE e.id = c.id
    RETURNING e.id, e.order_id, e.kind, e.variant, e.origin, e.attempts, e.lease_token, e.subject, e.body_text,
              e.fulfillment_id, e.refund_id, e.return_id, e.return_receipt_id, e.cancel_request_id
  )
  SELECT c.id, c.order_id, c.kind, c.variant, c.origin, c.attempts, c.lease_token, c.subject, c.body_text,
         EXISTS (
           SELECT 1
           FROM private.order_email_outbox AS x
           WHERE x.order_id = c.order_id
             AND x.kind = 'payment_expired'
             AND x.status = 'sent'
         ),
         c.fulfillment_id,
         c.refund_id, c.return_id, c.return_receipt_id, c.cancel_request_id
  FROM claimed AS c;
END;
$$;

-- 7. 写真の置き場の入れ物（設計書 4-5）。非公開で、1 つの物は 10MiB まで、種類は JPEG と PNG だけ。
--    storage.objects の方針は作らない: 読み書きは service_role と、サーバーが出す署名つきの送り先・リンクだけ。
--    消す処理は置き場の窓口（Storage API の remove）で消す。SQL で storage.objects を消すと、中身（ファイル）が残る
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('return-photos', 'return-photos', false, 10485760, ARRAY['image/jpeg', 'image/png'])
ON CONFLICT (id) DO NOTHING;

-- 8. 定期処理の最後の成功の印に、写真を消す処理を足す（P6）。印が 49 時間より古い時は、見回りが止まった知らせを出す
ALTER TABLE public.ops_job_heartbeats
  DROP CONSTRAINT ops_job_heartbeats_job_check,
  ADD CONSTRAINT ops_job_heartbeats_job_check CHECK (
    job IN ('webhook_worker', 'order_sweep', 'stripe_reconcile', 'order_email_worker', 'order_email_delivery_check', 'return_photo_purge')
  );

-- 9. 行の守りと権限。新しい public の表は anon・authenticated に自動で権限が付くので、まず全部外す。
--    service_role は読むだけ。書くのは SECURITY DEFINER の関数だけ
ALTER TABLE public.order_return_photo_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_return_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_cancel_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_cancel_request_lines ENABLE ROW LEVEL SECURITY;

-- 方針は規約（docs/06_Operations/db-migrations.md）の「冪等にする」書き方: DROP POLICY IF EXISTS → CREATE POLICY
DROP POLICY IF EXISTS "deny direct client access" ON public.order_return_photo_uploads;
CREATE POLICY "deny direct client access" ON public.order_return_photo_uploads
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_return_photos;
CREATE POLICY "deny direct client access" ON public.order_return_photos
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_cancel_requests;
CREATE POLICY "deny direct client access" ON public.order_cancel_requests
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_cancel_request_lines;
CREATE POLICY "deny direct client access" ON public.order_cancel_request_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON public.order_return_photo_uploads FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_return_photos FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_cancel_requests FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_cancel_request_lines FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.order_return_photo_uploads TO service_role;
GRANT SELECT ON public.order_return_photos TO service_role;
GRANT SELECT ON public.order_cancel_requests TO service_role;
GRANT SELECT ON public.order_cancel_request_lines TO service_role;

-- 10. 関数の権限。private の関数は PUBLIC から外すだけ。public の関数は service_role だけが実行できる
--     （作り直した関数は権限が初期に戻る場合があるので付け直す）
REVOKE ALL ON FUNCTION private.guard_order_return_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.guard_order_return_line_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.guard_return_photo_upload_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.guard_return_photo_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.guard_order_cancel_request_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.reject_order_cancel_request_line_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.check_cancel_request_line_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_order_email(uuid, text, text, uuid, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.claim_order_email(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_email(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
