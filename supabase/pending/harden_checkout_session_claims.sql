-- Checkout Session draft claim の第2段階ハードニング。
--
-- 【保留中・第2段階】互換マイグレーションと対応アプリを本番確認した後、
-- 再度の明示承認を得て昇格する。旧アプリは直接 INSERT できなくなる。

BEGIN;

-- 旧アプリの直接INSERTがバックフィル後・NOT NULL化前へ割り込むのを防ぐ。
-- 先行DMLの完了を待ってから全既存行を補完し、COMMITまで新しい書き込みを止める。
LOCK TABLE public.checkout_drafts IN SHARE ROW EXCLUSIVE MODE;

UPDATE public.checkout_drafts AS d
SET checkout_request_version = 0,
    checkout_request_fingerprint =
      'v0:' || pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(d.id::text, 'UTF8')),
        'hex'
      )
WHERE d.checkout_request_version IS NULL
   OR d.checkout_request_fingerprint IS NULL;

ALTER TABLE public.checkout_drafts
  ALTER COLUMN checkout_request_version SET NOT NULL,
  ALTER COLUMN checkout_request_fingerprint SET NOT NULL;

REVOKE INSERT ON TABLE public.checkout_drafts
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
