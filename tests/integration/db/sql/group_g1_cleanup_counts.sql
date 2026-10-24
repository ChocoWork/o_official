-- G-1 清掃の前の件数の読取（SELECT だけ。ID・メール・秘密値を出さない）。tests/integration/db/group_g1_cleanup.integration.test.ts の清掃の対象一覧と同じ（試験が突き合わせる）
WITH group_g_cleanup_order_ids AS (SELECT id,checkout_session_id,payment_intent_id FROM public.orders),
group_g_cleanup_payout_ids AS (SELECT DISTINCT payout_id AS id FROM public.stripe_balance_transactions WHERE order_id IN (SELECT id FROM group_g_cleanup_order_ids) AND payout_id IS NOT NULL),
group_g_cleanup_webhook_ids AS (SELECT e.id FROM public.stripe_webhook_events e WHERE e.processing_status IN ('queued','processing','failed')
AND e.next_attempt_at IS NOT NULL
AND (
  EXISTS (
    SELECT 1 FROM group_g_cleanup_order_ids o
    WHERE e.raw_payload #>> '{data,object,metadata,order_id}' = o.id::text
       OR e.raw_payload #>> '{data,object,order_id}' = o.id::text
       OR (o.checkout_session_id IS NOT NULL
           AND e.raw_payload #>> '{data,object,id}' = o.checkout_session_id)
       OR (o.payment_intent_id IS NOT NULL AND (
            e.raw_payload #>> '{data,object,id}' = o.payment_intent_id
         OR e.raw_payload #>> '{data,object,payment_intent}' = o.payment_intent_id
         OR e.raw_payload #>> '{data,object,payment_intent,id}' = o.payment_intent_id
       ))
  )
  OR EXISTS (
    SELECT 1 FROM public.order_revisions r
    JOIN group_g_cleanup_order_ids o ON o.id=r.order_id
    WHERE r.source_event_id=e.id
  )
))
SELECT x.table_name, x.action, x.affected_count, x.total_count, x.quantity_sum
FROM (
  SELECT 'private.order_email_outbox'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM private.order_email_outbox WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'private.order_status_links'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM private.order_status_links WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'private.fulfillment_tracking_registrations'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM private.fulfillment_tracking_registrations WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_fulfillment_attention'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_fulfillment_attention WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_fulfillment_events'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_fulfillment_events WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_fulfillment_tracking_changes'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_fulfillment_tracking_changes WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_return_photos'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_return_photos WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_return_photo_uploads'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_return_photo_uploads WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_cancel_request_lines'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_cancel_request_lines WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_cancel_requests'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_cancel_requests WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_return_receipt_lines'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_return_receipt_lines WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_return_receipts'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_return_receipts WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_refund_lines'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_refund_lines WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.stock_movements'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.stock_movements WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_refunds'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_refunds WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_return_lines'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_return_lines WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_fulfillment_lines'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_fulfillment_lines WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_item_completions'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_item_completions WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_items'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_items WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_fulfillments'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_fulfillments WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_returns'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_returns WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.order_revisions'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.order_revisions WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.payment_exceptions'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.payment_exceptions WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.checkout_drafts'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.checkout_drafts WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.orders'::text AS table_name, 'delete_all'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.orders WHERE TRUE)::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.stripe_refunds'::text AS table_name, 'delete_linked'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.stripe_refunds WHERE order_id IN (SELECT id FROM group_g_cleanup_order_ids))::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.stripe_balance_transactions'::text AS table_name, 'delete_linked'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.stripe_balance_transactions WHERE order_id IN (SELECT id FROM group_g_cleanup_order_ids))::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.contact_inquiries'::text AS table_name, 'unlink'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.contact_inquiries WHERE order_id IN (SELECT id FROM group_g_cleanup_order_ids))::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.item_variants'::text AS table_name, 'reset'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.item_variants WHERE stock_quantity<>0)::text AS affected_count,
    (SELECT pg_catalog.count(*) FROM public.item_variants)::text AS total_count,
    (SELECT COALESCE(pg_catalog.sum(stock_quantity),0) FROM public.item_variants)::text AS quantity_sum
  UNION ALL
  SELECT 'public.stripe_payouts'::text AS table_name, 'recompute'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.stripe_payouts WHERE id IN (SELECT id FROM group_g_cleanup_payout_ids))::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.stripe_webhook_events'::text AS table_name, 'terminalize_webhook'::text AS action,
    (SELECT pg_catalog.count(*) FROM public.stripe_webhook_events WHERE id IN (SELECT id FROM group_g_cleanup_webhook_ids))::text AS affected_count,
    NULL::text AS total_count,
    NULL::text AS quantity_sum
  UNION ALL
  SELECT 'public.stripe_balance_transactions'::text, 'balance_without_payout'::text,
    (SELECT pg_catalog.count(*) FROM public.stripe_balance_transactions b
     WHERE b.order_id IN (SELECT id FROM group_g_cleanup_order_ids)
       AND (b.payout_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.stripe_payouts p WHERE p.id=b.payout_id)))::text,
    NULL::text, NULL::text
) x
ORDER BY x.table_name COLLATE "C", x.action COLLATE "C";
