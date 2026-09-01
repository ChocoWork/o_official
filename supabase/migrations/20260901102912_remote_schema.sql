SET local check_function_bodies = off;

CREATE SCHEMA "private";

CREATE SCHEMA "security";

CREATE EXTENSION "hypopg" SCHEMA "extensions";

CREATE EXTENSION "index_advisor" SCHEMA "extensions";

CREATE SEQUENCE "public"."admin_finance_entry_review_acks_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."admin_finance_entry_revisions_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."admin_finance_expense_templates_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."admin_finance_expenses_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."admin_finance_fixed_assets_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."admin_finance_partners_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."admin_finance_receipts_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."admin_finance_summary_options_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."admin_kpi_targets_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."order_revisions_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."permissions_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."rate_limit_counters_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."roles_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE SEQUENCE "public"."stockists_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

CREATE TABLE "public"."admin_costing_items" (
  "id"                     bigint                   GENERATED ALWAYS AS IDENTITY NOT NULL,
  "season_key"             text                     NOT NULL,
  "category"               text                     NOT NULL,
  "provisional_name"       text                     NOT NULL,
  "planned_quantity"       integer                  NOT NULL DEFAULT 0,
  "selling_price"          bigint                   NOT NULL DEFAULT 0,
  "fabric_meters_per_unit" numeric(12,3)            NOT NULL DEFAULT 0,
  "created_by"             uuid,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "admin_costing_items_category_check" CHECK ((category = ANY (ARRAY['TOPS'::text, 'BOTTOMS'::text, 'OUTERWEAR'::text, 'ACCESSORIES'::text]))),
  CONSTRAINT "admin_costing_items_fabric_meters_per_unit_check" CHECK ((fabric_meters_per_unit >= (0)::numeric)),
  CONSTRAINT "admin_costing_items_id_season_key_key" UNIQUE (id, season_key),
  CONSTRAINT "admin_costing_items_pkey" PRIMARY KEY (id),
  CONSTRAINT "admin_costing_items_planned_quantity_check" CHECK (((planned_quantity >= 0) AND (planned_quantity <= 1000000))),
  CONSTRAINT "admin_costing_items_provisional_name_check" CHECK (((char_length(provisional_name) >= 1) AND (char_length(provisional_name) <= 160))),
  CONSTRAINT "admin_costing_items_selling_price_check" CHECK ((selling_price >= 0))
);

ALTER TABLE "public"."admin_costing_items"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_expense_cost_allocations" (
  "id"          bigint                   GENERATED ALWAYS AS IDENTITY NOT NULL,
  "expense_id"  bigint                   NOT NULL,
  "season_key"  text                     NOT NULL,
  "target_type" text                     NOT NULL,
  "item_id"     bigint,
  "cost_type"   text                     NOT NULL,
  "other_label" text,
  "amount"      bigint                   NOT NULL,
  "created_by"  uuid,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "admin_expense_cost_allocations_amount_check" CHECK ((amount > 0)),
  CONSTRAINT "admin_expense_cost_allocations_cost_type_check"
    CHECK
    ((cost_type = ANY (ARRAY['material'::text, 'sewing'::text, 'pattern'::text, 'planning'::text, 'accessories'::text, 'processing'::text, 'inspection_finishing'::text,
    'logistics'::text, 'advertising'::text, 'photography'::text, 'exhibition'::text, 'other'::text]))),
  CONSTRAINT "admin_expense_cost_allocations_other_cost_type_check" CHECK ((((cost_type = 'other'::text) AND (other_label IS
    NOT NULL)) OR ((cost_type <> 'other'::text) AND (other_label IS NULL)))),
  CONSTRAINT "admin_expense_cost_allocations_other_label_check" CHECK (((other_label IS NULL) OR ((char_length(other_label) >= 1) AND (char_length(other_label) <= 80)))),
  CONSTRAINT "admin_expense_cost_allocations_pkey" PRIMARY KEY (id),
  CONSTRAINT "admin_expense_cost_allocations_target_check" CHECK ((((target_type = 'item'::text) AND (item_id IS
    NOT NULL)) OR ((target_type = 'season_common'::text) AND (item_id IS NULL)))),
  CONSTRAINT "admin_expense_cost_allocations_target_type_check" CHECK ((target_type = ANY (ARRAY['item'::text, 'season_common'::text])))
);

ALTER TABLE "public"."admin_expense_cost_allocations"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_finance_entry_review_acks" (
  "id"          bigint                   NOT NULL DEFAULT nextval('public.admin_finance_entry_review_acks_id_seq'::regclass),
  "entry_ref"   text                     NOT NULL,
  "reason"      text                     NOT NULL,
  "note"        text                     NOT NULL DEFAULT ''::text,
  "reviewed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "reviewed_by" uuid,
  CONSTRAINT "admin_finance_entry_review_acks_entry_ref_check" CHECK ((entry_ref ~ '^(entry|order):.{1,120}$'::text)),
  CONSTRAINT "admin_finance_entry_review_acks_entry_ref_reason_key" UNIQUE (entry_ref, reason),
  CONSTRAINT "admin_finance_entry_review_acks_note_check" CHECK ((char_length(note) <= 500)),
  CONSTRAINT "admin_finance_entry_review_acks_pkey" PRIMARY KEY (id),
  CONSTRAINT "admin_finance_entry_review_acks_reason_check" CHECK ((reason = ANY (ARRAY['duplicate'::text, 'unknownAccount'::text, 'unlinkedAsset'::text, 'revisedEntry'::text])))
);

ALTER TABLE "public"."admin_finance_entry_review_acks"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_finance_entry_revisions" (
  "id"          bigint                   NOT NULL DEFAULT nextval('public.admin_finance_entry_revisions_id_seq'::regclass),
  "entry_id"    bigint                   NOT NULL,
  "operation"   text                     NOT NULL,
  "before_data" jsonb,
  "after_data"  jsonb,
  "changed_by"  uuid,
  "changed_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "admin_finance_entry_revisions_operation_check" CHECK ((operation = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text]))),
  CONSTRAINT "admin_finance_entry_revisions_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."admin_finance_entry_revisions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_finance_evidence_unavailable_records" (
  "entry_id"    bigint                   NOT NULL,
  "reason"      text                     NOT NULL,
  "note"        character varying(500),
  "recorded_at" timestamp with time zone NOT NULL DEFAULT now(),
  "recorded_by" uuid,
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by"  uuid,
  CONSTRAINT "admin_finance_evidence_unavailable_note_required"
    CHECK
    (((reason <> ALL (ARRAY['bank_history_expired'::text, 'other'::text])) OR ((char_length(btrim((COALESCE(note, ''::character varying))::text)) >= 1) AND
    (char_length(btrim((COALESCE(note, ''::character varying))::text)) <= 500)))),
  CONSTRAINT "admin_finance_evidence_unavailable_records_note_check"
    CHECK (((note IS NULL) OR (((note)::text = btrim((note)::text)) AND ((char_length((note)::text) >= 1) AND (char_length((note)::text) <= 500))))),
  CONSTRAINT "admin_finance_evidence_unavailable_records_pkey" PRIMARY KEY (entry_id),
  CONSTRAINT "admin_finance_evidence_unavailable_records_reason_check"
    CHECK ((reason = ANY (ARRAY['bank_history_expired'::text, 'not_issued'::text, 'paper_storage'::text, 'external_electronic_storage'::text, 'other'::text])))
);

ALTER TABLE "public"."admin_finance_evidence_unavailable_records"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_finance_expense_templates" (
  "id"             bigint                   NOT NULL DEFAULT nextval('public.admin_finance_expense_templates_id_seq'::regclass),
  "name"           text                     NOT NULL,
  "category"       text                     NOT NULL,
  "item_name"      text                     NOT NULL,
  "amount"         bigint                   NOT NULL DEFAULT 0,
  "payment_method" text                     NOT NULL,
  "memo"           text                     NOT NULL DEFAULT ''::text,
  "created_by"     uuid,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "entry_type"     text                     NOT NULL DEFAULT 'expense'::text,
  "partner"        text                     NOT NULL DEFAULT ''::text,
  CONSTRAINT "admin_finance_expense_templates_amount_check" CHECK ((amount >= 0)),
  CONSTRAINT "admin_finance_expense_templates_category_check" CHECK (((char_length(category) >= 1) AND (char_length(category) <= 80))),
  CONSTRAINT "admin_finance_expense_templates_entry_type_check" CHECK ((entry_type = ANY (ARRAY['expense'::text, 'income'::text]))),
  CONSTRAINT "admin_finance_expense_templates_item_name_check" CHECK (((char_length(item_name) >= 1) AND (char_length(item_name) <= 160))),
  CONSTRAINT "admin_finance_expense_templates_memo_check" CHECK ((char_length(memo) <= 500)),
  CONSTRAINT "admin_finance_expense_templates_name_check" CHECK (((char_length(name) >= 1) AND (char_length(name) <= 160))),
  CONSTRAINT "admin_finance_expense_templates_name_key" UNIQUE (name),
  CONSTRAINT "admin_finance_expense_templates_partner_check" CHECK ((char_length(partner) <= 160)),
  CONSTRAINT "admin_finance_expense_templates_payment_method_check" CHECK (((char_length(payment_method) >= 1) AND (char_length(payment_method) <= 80))),
  CONSTRAINT "admin_finance_expense_templates_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."admin_finance_expense_templates"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_finance_expenses" (
  "id"                        bigint                   NOT NULL DEFAULT nextval('public.admin_finance_expenses_id_seq'::regclass),
  "season_key"                text,
  "expense_date"              date                     NOT NULL,
  "category"                  text                     NOT NULL,
  "item_name"                 text                     NOT NULL,
  "amount"                    bigint                   NOT NULL,
  "payment_method"            text                     NOT NULL,
  "memo"                      text                     NOT NULL DEFAULT ''::text,
  "created_by"                uuid,
  "created_at"                timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                timestamp with time zone NOT NULL DEFAULT now(),
  "partner"                   text                     NOT NULL DEFAULT ''::text,
  "entry_type"                text                     NOT NULL DEFAULT 'expense'::text,
  "deleted_at"                timestamp with time zone,
  "deleted_by"                uuid,
  "updated_by"                uuid,
  "fixed_asset_exempt"        boolean                  NOT NULL DEFAULT false,
  "fixed_asset_exempt_reason" text,
  "fixed_asset_reviewed_at"   timestamp with time zone,
  "fixed_asset_reviewed_by"   uuid,
  CONSTRAINT "admin_finance_expenses_amount_check" CHECK ((amount > 0)),
  CONSTRAINT "admin_finance_expenses_asset_exempt_reason_required"
    CHECK ((((fixed_asset_exempt = false) AND (fixed_asset_exempt_reason IS NULL)) OR ((fixed_asset_exempt = true) AND (length(btrim(fixed_asset_exempt_reason)) > 0)))),
  CONSTRAINT "admin_finance_expenses_category_check" CHECK (((char_length(category) >= 1) AND (char_length(category) <= 80))),
  CONSTRAINT "admin_finance_expenses_entry_type_check" CHECK ((entry_type = ANY (ARRAY['expense'::text, 'income'::text]))),
  CONSTRAINT "admin_finance_expenses_item_name_check" CHECK (((char_length(item_name) >= 1) AND (char_length(item_name) <= 160))),
  CONSTRAINT "admin_finance_expenses_memo_check" CHECK ((char_length(memo) <= 500)),
  CONSTRAINT "admin_finance_expenses_partner_check" CHECK ((char_length(partner) <= 160)),
  CONSTRAINT "admin_finance_expenses_payment_method_check" CHECK (((char_length(payment_method) >= 1) AND (char_length(payment_method) <= 80))),
  CONSTRAINT "admin_finance_expenses_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."admin_finance_expenses"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_finance_fixed_assets" (
  "id"                 bigint                   NOT NULL DEFAULT nextval('public.admin_finance_fixed_assets_id_seq'::regclass),
  "name"               text                     NOT NULL,
  "account"            text                     NOT NULL,
  "acquired_on"        date                     NOT NULL,
  "acquisition_cost"   bigint                   NOT NULL,
  "useful_life"        integer                  NOT NULL,
  "method"             text                     NOT NULL DEFAULT 'straightLine'::text,
  "business_use_ratio" integer                  NOT NULL DEFAULT 100,
  "disposed_on"        date,
  "memo"               text                     NOT NULL DEFAULT ''::text,
  "created_by"         uuid,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "entry_id"           bigint,
  "service_started_on" date,
  CONSTRAINT "admin_finance_fixed_assets_account_check" CHECK (((char_length(account) >= 1) AND (char_length(account) <= 80))),
  CONSTRAINT "admin_finance_fixed_assets_acquisition_cost_check" CHECK ((acquisition_cost > 0)),
  CONSTRAINT "admin_finance_fixed_assets_business_use_ratio_check" CHECK (((business_use_ratio >= 1) AND (business_use_ratio <= 100))),
  CONSTRAINT "admin_finance_fixed_assets_disposal_after_acquisition" CHECK (((disposed_on IS NULL) OR (disposed_on >= acquired_on))),
  CONSTRAINT "admin_finance_fixed_assets_memo_check" CHECK ((char_length(memo) <= 500)),
  CONSTRAINT "admin_finance_fixed_assets_method_check" CHECK ((method = ANY (ARRAY['straightLine'::text, 'lumpSum3Year'::text, 'immediate'::text]))),
  CONSTRAINT "admin_finance_fixed_assets_name_check" CHECK (((char_length(name) >= 1) AND (char_length(name) <= 160))),
  CONSTRAINT "admin_finance_fixed_assets_pkey" PRIMARY KEY (id),
  CONSTRAINT "admin_finance_fixed_assets_service_after_acquisition" CHECK (((service_started_on IS NULL) OR (service_started_on >= acquired_on))),
  CONSTRAINT "admin_finance_fixed_assets_useful_life_check" CHECK (((useful_life >= 1) AND (useful_life <= 100)))
);

ALTER TABLE "public"."admin_finance_fixed_assets"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_finance_partners" (
  "id"         bigint                   NOT NULL DEFAULT nextval('public.admin_finance_partners_id_seq'::regclass),
  "name"       text                     NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "admin_finance_partners_name_check" CHECK (((char_length(name) >= 1) AND (char_length(name) <= 160))),
  CONSTRAINT "admin_finance_partners_name_key" UNIQUE (name),
  CONSTRAINT "admin_finance_partners_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."admin_finance_partners"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_finance_receipts" (
  "id"           bigint                   NOT NULL DEFAULT nextval('public.admin_finance_receipts_id_seq'::regclass),
  "entry_id"     bigint                   NOT NULL,
  "storage_path" text                     NOT NULL,
  "file_name"    text                     NOT NULL,
  "mime_type"    text                     NOT NULL,
  "file_size"    integer                  NOT NULL,
  "uploaded_by"  uuid,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "admin_finance_receipts_file_name_check" CHECK (((char_length(file_name) >= 1) AND (char_length(file_name) <= 255))),
  CONSTRAINT "admin_finance_receipts_file_size_check" CHECK ((file_size > 0)),
  CONSTRAINT "admin_finance_receipts_mime_type_check" CHECK (((char_length(mime_type) >= 1) AND (char_length(mime_type) <= 120))),
  CONSTRAINT "admin_finance_receipts_pkey" PRIMARY KEY (id),
  CONSTRAINT "admin_finance_receipts_storage_path_check" CHECK (((char_length(storage_path) >= 1) AND (char_length(storage_path) <= 500))),
  CONSTRAINT "admin_finance_receipts_storage_path_key" UNIQUE (storage_path)
);

ALTER TABLE "public"."admin_finance_receipts"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_finance_seasons" (
  "season_key" text                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "admin_finance_seasons_pkey" PRIMARY KEY (season_key),
  CONSTRAINT "admin_finance_seasons_season_key_check" CHECK ((season_key ~ '^[0-9]{4}(SS|AW)$'::text))
);

ALTER TABLE "public"."admin_finance_seasons"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_finance_summary_options" (
  "id"              bigint                   NOT NULL DEFAULT nextval('public.admin_finance_summary_options_id_seq'::regclass),
  "entry_type"      text                     NOT NULL,
  "name"            text                     NOT NULL,
  "normalized_name" text                     NOT NULL,
  "created_by"      uuid,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "admin_finance_summary_options_check"
    CHECK ((((char_length(normalized_name) >= 1) AND (char_length(normalized_name) <= 160)) AND (normalized_name = lower(btrim(name))))),
  CONSTRAINT "admin_finance_summary_options_entry_type_check" CHECK ((entry_type = ANY (ARRAY['expense'::text, 'income'::text]))),
  CONSTRAINT "admin_finance_summary_options_entry_type_normalized_name_key" UNIQUE (entry_type, normalized_name),
  CONSTRAINT "admin_finance_summary_options_name_check" CHECK ((((char_length(name) >= 1) AND (char_length(name) <= 160)) AND (name = btrim(name)))),
  CONSTRAINT "admin_finance_summary_options_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."admin_finance_summary_options"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_finance_year_closings" (
  "fiscal_year"                 integer                  NOT NULL,
  "closing_inventory_goods"     bigint                   NOT NULL DEFAULT 0,
  "closing_inventory_materials" bigint                   NOT NULL DEFAULT 0,
  "allowance_for_doubtful"      bigint                   NOT NULL DEFAULT 0,
  "closing_balances"            jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "closed_at"                   timestamp with time zone,
  "closed_by"                   uuid,
  "created_at"                  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "admin_finance_year_closings_allowance_for_doubtful_check" CHECK ((allowance_for_doubtful >= 0)),
  CONSTRAINT "admin_finance_year_closings_closing_inventory_goods_check" CHECK ((closing_inventory_goods >= 0)),
  CONSTRAINT "admin_finance_year_closings_closing_inventory_materials_check" CHECK ((closing_inventory_materials >= 0)),
  CONSTRAINT "admin_finance_year_closings_pkey" PRIMARY KEY (fiscal_year)
);

ALTER TABLE "public"."admin_finance_year_closings"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_finance_years" (
  "fiscal_year"         integer                  NOT NULL,
  "business_type"       text                     NOT NULL DEFAULT 'soleProprietor'::text,
  "sales_revenue"       bigint                   NOT NULL DEFAULT 0,
  "opening_cash"        bigint                   NOT NULL DEFAULT 0,
  "accounts_receivable" bigint                   NOT NULL DEFAULT 0,
  "fixed_assets"        bigint                   NOT NULL DEFAULT 0,
  "accounts_payable"    bigint                   NOT NULL DEFAULT 0,
  "opening_capital"     bigint                   NOT NULL DEFAULT 0,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "admin_finance_years_accounts_payable_check" CHECK ((accounts_payable >= 0)),
  CONSTRAINT "admin_finance_years_accounts_receivable_check" CHECK ((accounts_receivable >= 0)),
  CONSTRAINT "admin_finance_years_business_type_check" CHECK ((business_type = ANY (ARRAY['soleProprietor'::text, 'corporation'::text]))),
  CONSTRAINT "admin_finance_years_fiscal_year_check" CHECK (((fiscal_year >= 2000) AND (fiscal_year <= 2999))),
  CONSTRAINT "admin_finance_years_fixed_assets_check" CHECK ((fixed_assets >= 0)),
  CONSTRAINT "admin_finance_years_opening_capital_check" CHECK ((opening_capital >= 0)),
  CONSTRAINT "admin_finance_years_opening_cash_check" CHECK ((opening_cash >= 0)),
  CONSTRAINT "admin_finance_years_pkey" PRIMARY KEY (fiscal_year),
  CONSTRAINT "admin_finance_years_sales_revenue_check" CHECK ((sales_revenue >= 0))
);

ALTER TABLE "public"."admin_finance_years"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_kpi_actuals" (
  "id"           bigint                   GENERATED ALWAYS AS IDENTITY NOT NULL,
  "season_key"   text                     NOT NULL,
  "kpi_key"      text                     NOT NULL,
  "month"        integer                  NOT NULL,
  "actual_value" numeric,
  "created_at"   timestamp with time zone DEFAULT now(),
  "updated_at"   timestamp with time zone DEFAULT now(),
  CONSTRAINT "admin_kpi_actuals_month_check" CHECK (((month >= 1) AND (month <= 6))),
  CONSTRAINT "admin_kpi_actuals_pkey" PRIMARY KEY (id),
  CONSTRAINT "admin_kpi_actuals_season_key_kpi_key_month_key" UNIQUE (season_key, kpi_key, month)
);

ALTER TABLE "public"."admin_kpi_actuals"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_kpi_documents" (
  "id"         bigint                   GENERATED ALWAYS AS IDENTITY NOT NULL,
  "season_key" text                     NOT NULL,
  "doc_type"   text                     NOT NULL,
  "file_url"   text                     NOT NULL,
  "file_name"  text                     NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "admin_kpi_documents_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."admin_kpi_documents"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_kpi_target_history" (
  "id"           bigint                   GENERATED ALWAYS AS IDENTITY NOT NULL,
  "season_key"   text                     NOT NULL,
  "kpi_key"      text                     NOT NULL,
  "target_value" numeric                  NOT NULL,
  "created_at"   timestamp with time zone DEFAULT now(),
  CONSTRAINT "admin_kpi_target_history_pkey" PRIMARY KEY (id),
  CONSTRAINT "admin_kpi_target_history_season_key_kpi_key_key" UNIQUE (season_key, kpi_key)
);

ALTER TABLE "public"."admin_kpi_target_history"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_kpi_targets" (
  "id"             bigint                   NOT NULL DEFAULT nextval('public.admin_kpi_targets_id_seq'::regclass),
  "season_key"     text                     NOT NULL,
  "kpi_key"        text                     NOT NULL,
  "target_value"   text                     NOT NULL,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "definition"     text                     DEFAULT ''::text,
  "display_unit"   text                     DEFAULT ''::text,
  "target_numeric" numeric                  DEFAULT 0,
  "kpi_type"       text                     DEFAULT 'number'::text,
  CONSTRAINT "admin_kpi_targets_pkey" PRIMARY KEY (id),
  CONSTRAINT "admin_kpi_targets_season_key_kpi_key_key" UNIQUE (season_key, kpi_key)
);

ALTER TABLE "public"."admin_kpi_targets"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."audit_logs_backups" (
  "id"          uuid,
  "created_at"  timestamp with time zone,
  "action"      text,
  "actor_id"    uuid,
  "actor_email" text,
  "resource"    text,
  "resource_id" text,
  "outcome"     text,
  "detail"      text,
  "ip"          text,
  "user_agent"  text,
  "metadata"    jsonb
);

ALTER TABLE "public"."audit_logs_backups"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."audit_logs" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "action"      text                     NOT NULL,
  "actor_id"    uuid,
  "actor_email" text,
  "resource"    text,
  "resource_id" text,
  "outcome"     text                     NOT NULL,
  "detail"      text,
  "ip"          text,
  "user_agent"  text,
  "metadata"    jsonb,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."audit_logs"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."carts" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    uuid,
  "session_id" text,
  "item_id"    bigint                   NOT NULL,
  "quantity"   integer                  NOT NULL,
  "color"      text,
  "size"       text,
  "added_at"   timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "carts_pkey" PRIMARY KEY (id),
  CONSTRAINT "carts_quantity_check" CHECK ((quantity > 0))
);

ALTER TABLE "public"."carts"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."checkout_drafts" (
  "id"                  uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "session_id"          text                     NOT NULL,
  "checkout_session_id" text,
  "payment_intent_id"   text,
  "payment_method"      text                     NOT NULL,
  "currency"            text                     NOT NULL DEFAULT 'jpy'::text,
  "subtotal_amount"     integer                  NOT NULL,
  "shipping_amount"     integer                  NOT NULL,
  "total_amount"        integer                  NOT NULL,
  "shipping_snapshot"   jsonb,
  "items_snapshot"      jsonb                    NOT NULL,
  "status"              text                     NOT NULL DEFAULT 'created'::text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "checkout_drafts_checkout_session_id_key" UNIQUE (checkout_session_id),
  CONSTRAINT "checkout_drafts_payment_intent_id_key" UNIQUE (payment_intent_id),
  CONSTRAINT "checkout_drafts_pkey" PRIMARY KEY (id),
  CONSTRAINT "checkout_drafts_shipping_amount_check" CHECK ((shipping_amount >= 0)),
  CONSTRAINT "checkout_drafts_status_check" CHECK ((status = ANY (ARRAY['created'::text, 'completed'::text, 'failed'::text]))),
  CONSTRAINT "checkout_drafts_subtotal_amount_check" CHECK ((subtotal_amount >= 0)),
  CONSTRAINT "checkout_drafts_total_amount_check" CHECK ((total_amount >= 0))
);

ALTER TABLE "public"."checkout_drafts"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."contact_inquiries" (
  "id"              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "name"            text                     NOT NULL,
  "email"           text                     NOT NULL,
  "inquiry_type"    text                     NOT NULL,
  "subject"         text                     NOT NULL,
  "message"         text                     NOT NULL,
  "submitted_ip"    text,
  "user_agent"      text,
  "status"          text                     NOT NULL DEFAULT 'open'::text,
  "user_id"         uuid,
  "order_id"        uuid,
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "last_message_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "contact_inquiries_inquiry_type_check" CHECK ((inquiry_type = ANY (ARRAY['product'::text, 'order'::text, 'other'::text]))),
  CONSTRAINT "contact_inquiries_pkey" PRIMARY KEY (id),
  CONSTRAINT "contact_inquiries_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'pending'::text, 'answered'::text, 'closed'::text])))
);

ALTER TABLE "public"."contact_inquiries"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."contact_messages" (
  "id"                  uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "inquiry_id"          uuid                     NOT NULL,
  "sender_role"         text                     NOT NULL,
  "author_id"           uuid,
  "body"                text                     NOT NULL,
  "channel"             text                     NOT NULL DEFAULT 'web'::text,
  "inbound_provider_id" text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "contact_messages_channel_check" CHECK ((channel = ANY (ARRAY['web'::text, 'email'::text]))),
  CONSTRAINT "contact_messages_inbound_provider_id_key" UNIQUE (inbound_provider_id),
  CONSTRAINT "contact_messages_pkey" PRIMARY KEY (id),
  CONSTRAINT "contact_messages_sender_role_check" CHECK ((sender_role = ANY (ARRAY['user'::text, 'admin'::text])))
);

ALTER TABLE "public"."contact_messages"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."contact_reply_templates" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "title"      text                     NOT NULL,
  "category"   text,
  "body"       text                     NOT NULL,
  "sort_order" integer                  NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "contact_reply_templates_category_check" CHECK ((category = ANY (ARRAY['product'::text, 'order'::text, 'other'::text, 'general'::text]))),
  CONSTRAINT "contact_reply_templates_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."contact_reply_templates"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."item_color_presets" (
  "id"         bigint                   GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "name"       text                     NOT NULL,
  "hex"        text                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "item_color_presets_hex_check" CHECK ((hex ~ '^#[0-9A-Fa-f]{6}$'::text)),
  CONSTRAINT "item_color_presets_name_hex_key" UNIQUE (name, hex),
  CONSTRAINT "item_color_presets_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."item_color_presets"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."item_cost_history" (
  "id"                   bigint                   GENERATED ALWAYS AS IDENTITY NOT NULL,
  "item_id"              bigint,
  "season_key"           text                     NOT NULL,
  "pattern_cost"         integer                  DEFAULT 0,
  "mass_production_cost" integer                  DEFAULT 0,
  "pdf_url"              text,
  "created_at"           timestamp with time zone DEFAULT now(),
  "updated_at"           timestamp with time zone DEFAULT now(),
  CONSTRAINT "item_cost_history_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."item_cost_history"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."items" (
  "id"                   bigint                   GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "name"                 text                     NOT NULL,
  "description"          text                     NOT NULL,
  "price"                integer                  NOT NULL,
  "category"             text                     NOT NULL,
  "image_url"            text                     NOT NULL,
  "image_urls"           text[]                   NOT NULL DEFAULT '{}'::text[],
  "colors"               jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  "sizes"                text[]                   NOT NULL DEFAULT '{}'::text[],
  "product_details"      text                     NOT NULL DEFAULT ''::text,
  "status"               text                     NOT NULL DEFAULT 'private'::text,
  "created_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "stock_quantity"       integer,
  "pattern_cost"         integer                  DEFAULT 0,
  "mass_production_cost" integer                  DEFAULT 0,
  "material"             text,
  "origin"               text,
  "sewing_region"        text,
  "care"                 text,
  "season"               text,
  "product_note"         text,
  CONSTRAINT "items_category_check" CHECK ((category = ANY (ARRAY['TOPS'::text, 'BOTTOMS'::text, 'OUTERWEAR'::text, 'ACCESSORIES'::text]))),
  CONSTRAINT "items_pkey" PRIMARY KEY (id),
  CONSTRAINT "items_price_check" CHECK ((price >= 0)),
  CONSTRAINT "items_season_check" CHECK (((season IS NULL) OR (season = ANY (ARRAY['SS'::text, 'AW'::text])))),
  CONSTRAINT "items_status_check" CHECK ((status = ANY (ARRAY['private'::text, 'published'::text])))
);

ALTER TABLE "public"."items"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."legal_archive_runs" (
  "id"              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "archive_date"    date                     NOT NULL,
  "fiscal_year"     integer                  NOT NULL,
  "run_kind"        text                     NOT NULL,
  "status"          text                     NOT NULL,
  "storage_targets" text[]                   NOT NULL DEFAULT '{}'::text[],
  "manifest_path"   text,
  "manifest_sha256" text,
  "started_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at"    timestamp with time zone,
  "error_code"      text,
  CONSTRAINT "legal_archive_runs_archive_date_run_kind_key" UNIQUE (archive_date, run_kind),
  CONSTRAINT "legal_archive_runs_error_code_check" CHECK (((error_code IS NULL) OR (char_length(error_code) <= 100))),
  CONSTRAINT "legal_archive_runs_fiscal_year_check" CHECK (((fiscal_year >= 2000) AND (fiscal_year <= 9999))),
  CONSTRAINT "legal_archive_runs_manifest_sha256_check" CHECK (((manifest_sha256 IS NULL) OR (manifest_sha256 ~ '^[0-9a-f]{64}$'::text))),
  CONSTRAINT "legal_archive_runs_pkey" PRIMARY KEY (id),
  CONSTRAINT "legal_archive_runs_run_kind_check" CHECK ((run_kind = ANY (ARRAY['daily'::text, 'annual'::text, 'restore_check'::text]))),
  CONSTRAINT "legal_archive_runs_status_check" CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])))
);

ALTER TABLE "public"."legal_archive_runs"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."look_items" (
  "look_id"    bigint                   NOT NULL,
  "item_id"    bigint                   NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "look_items_pkey" PRIMARY KEY (look_id, item_id)
);

ALTER TABLE "public"."look_items"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."looks" (
  "id"                bigint                   GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "season_year"       integer                  NOT NULL,
  "season_type"       text                     NOT NULL,
  "theme"             text                     NOT NULL,
  "theme_description" text                     NOT NULL DEFAULT ''::text,
  "image_urls"        text[]                   NOT NULL DEFAULT '{}'::text[],
  "status"            text                     NOT NULL DEFAULT 'private'::text,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "looks_pkey" PRIMARY KEY (id),
  CONSTRAINT "looks_season_type_check" CHECK ((season_type = ANY (ARRAY['SS'::text, 'AW'::text]))),
  CONSTRAINT "looks_season_year_check" CHECK (((season_year >= 2000) AND (season_year <= 2100))),
  CONSTRAINT "looks_status_check" CHECK ((status = ANY (ARRAY['private'::text, 'published'::text])))
);

ALTER TABLE "public"."looks"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."news_articles" (
  "id"               bigint                   GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "title"            text                     NOT NULL,
  "category"         text                     NOT NULL,
  "published_date"   date                     NOT NULL,
  "image_url"        text                     NOT NULL,
  "content"          text                     NOT NULL,
  "detailed_content" text                     NOT NULL,
  "status"           text                     NOT NULL DEFAULT 'draft'::text,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "news_articles_category_check" CHECK ((category = ANY (ARRAY['COLLECTION'::text, 'EVENT'::text, 'COLLABORATION'::text, 'SUSTAINABILITY'::text, 'STORE'::text]))),
  CONSTRAINT "news_articles_pkey" PRIMARY KEY (id),
  CONSTRAINT "news_articles_status_check" CHECK ((status = ANY (ARRAY['private'::text, 'published'::text])))
);

ALTER TABLE "public"."news_articles"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."order_items" (
  "id"             uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "order_id"       uuid                     NOT NULL,
  "item_id"        integer                  NOT NULL,
  "item_name"      text                     NOT NULL,
  "item_price"     integer                  NOT NULL,
  "item_image_url" text,
  "color"          text,
  "size"           text,
  "quantity"       integer                  NOT NULL,
  "line_total"     integer                  NOT NULL,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "order_items_item_price_check" CHECK ((item_price >= 0)),
  CONSTRAINT "order_items_line_total_check" CHECK ((line_total >= 0)),
  CONSTRAINT "order_items_pkey" PRIMARY KEY (id),
  CONSTRAINT "order_items_quantity_check" CHECK ((quantity > 0))
);

ALTER TABLE "public"."order_items"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."order_revisions" (
  "id"              bigint                   NOT NULL DEFAULT nextval('public.order_revisions_id_seq'::regclass),
  "order_id"        uuid                     NOT NULL,
  "operation"       text                     NOT NULL,
  "before_data"     jsonb                    NOT NULL,
  "after_data"      jsonb                    NOT NULL,
  "changed_fields"  text[]                   NOT NULL,
  "changed_by"      uuid,
  "reason"          text,
  "source_event_id" text,
  "changed_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "order_revisions_changed_fields_check" CHECK ((cardinality(changed_fields) > 0)),
  CONSTRAINT "order_revisions_operation_check" CHECK ((operation = ANY (ARRAY['status_update'::text, 'refund_update'::text, 'operational_update'::text]))),
  CONSTRAINT "order_revisions_pkey" PRIMARY KEY (id),
  CONSTRAINT "order_revisions_reason_check" CHECK (((reason IS NULL) OR (char_length(reason) <= 500)))
);

ALTER TABLE "public"."order_revisions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."orders" (
  "id"                        uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "session_id"                text                     NOT NULL,
  "user_id"                   uuid,
  "payment_intent_id"         text                     NOT NULL,
  "subtotal_amount"           integer                  NOT NULL,
  "shipping_amount"           integer                  NOT NULL DEFAULT 500,
  "total_amount"              integer                  NOT NULL,
  "currency"                  text                     NOT NULL DEFAULT 'jpy'::text,
  "shipping_email"            text,
  "shipping_full_name"        text,
  "shipping_postal_code"      text,
  "shipping_prefecture"       text,
  "shipping_city"             text,
  "shipping_address"          text,
  "shipping_building"         text,
  "shipping_phone"            text,
  "created_at"                timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                timestamp with time zone NOT NULL DEFAULT now(),
  "checkout_session_id"       text,
  "discount_amount"           integer                  NOT NULL DEFAULT 0,
  "refunded_amount"           integer                  NOT NULL DEFAULT 0,
  "refunded_at"               timestamp with time zone,
  "payment_status_updated_at" timestamp with time zone,
  "shipped_at"                timestamp with time zone,
  "shipping_carrier"          text,
  "tracking_number"           text,
  CONSTRAINT "orders_payment_intent_id_key" UNIQUE (payment_intent_id),
  CONSTRAINT "orders_pkey" PRIMARY KEY (id),
  CONSTRAINT "orders_refunded_amount_range" CHECK (((refunded_amount >= 0) AND (refunded_amount <= total_amount))),
  CONSTRAINT "orders_shipping_amount_check" CHECK ((shipping_amount >= 0)),
  CONSTRAINT "orders_shipping_carrier_check" CHECK (((shipping_carrier IS NULL) OR (shipping_carrier = ANY (ARRAY['yamato'::text, 'sagawa'::text, 'japanpost'::text])))),
  CONSTRAINT "orders_shipping_info_requires_shipped_at" CHECK (((shipped_at IS NOT NULL) OR ((shipping_carrier IS NULL) AND (tracking_number IS NULL)))),
  CONSTRAINT "orders_subtotal_amount_check" CHECK ((subtotal_amount >= 0)),
  CONSTRAINT "orders_total_amount_check" CHECK ((total_amount > 0)),
  CONSTRAINT "orders_tracking_number_check" CHECK (((tracking_number IS NULL) OR (tracking_number ~ '^[0-9A-Za-z-]{1,64}$'::text)))
);

ALTER TABLE "public"."orders"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."password_reset_tokens" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    uuid,
  "email"      text                     NOT NULL,
  "token_hash" text                     NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used"       boolean                  NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."password_reset_tokens"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."permissions" (
  "id"         bigint                   NOT NULL DEFAULT nextval('public.permissions_id_seq'::regclass),
  "code"       text                     NOT NULL,
  "name"       text                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "permissions_code_key" UNIQUE (code),
  CONSTRAINT "permissions_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."permissions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."postal_code_cache" (
  "postal_code" character(7)             NOT NULL,
  "prefecture"  text                     NOT NULL,
  "city"        text                     NOT NULL,
  "address"     text                     NOT NULL,
  "source"      text                     NOT NULL DEFAULT 'zipcloud'::text,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "postal_code_cache_pkey" PRIMARY KEY (postal_code)
);

ALTER TABLE "public"."postal_code_cache"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."profiles" (
  "user_id"        uuid                     NOT NULL,
  "display_name"   text,
  "kana_name"      text,
  "phone"          text,
  "address"        jsonb,
  "created_at"     timestamp with time zone DEFAULT now(),
  "optional_name"  text,
  "optional_phone" text,
  "updated_at"     timestamp with time zone DEFAULT now(),
  "addresses"      jsonb,
  CONSTRAINT "profiles_pkey" PRIMARY KEY (user_id)
);

ALTER TABLE "public"."profiles"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."rate_limit_counters" (
  "id"           bigint                   NOT NULL DEFAULT nextval('public.rate_limit_counters_id_seq'::regclass),
  "ip"           inet,
  "endpoint"     text                     NOT NULL,
  "bucket"       timestamp with time zone NOT NULL,
  "count"        integer                  NOT NULL DEFAULT 1,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY (id),
  CONSTRAINT "rate_limit_counters_unique" UNIQUE (ip, endpoint, bucket)
);

ALTER TABLE "public"."rate_limit_counters"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."refresh_token_history" (
  "id"                 uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "session_id"         uuid                     NOT NULL,
  "user_id"            uuid                     NOT NULL,
  "refresh_token_hash" text                     NOT NULL,
  "recorded_at"        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "refresh_token_history_pkey" PRIMARY KEY (id),
  CONSTRAINT "refresh_token_history_refresh_token_hash_key" UNIQUE (refresh_token_hash)
);

ALTER TABLE "public"."refresh_token_history"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."role_permissions" (
  "role_id"       bigint                   NOT NULL,
  "permission_id" bigint                   NOT NULL,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "role_permissions_pkey" PRIMARY KEY (role_id, permission_id)
);

ALTER TABLE "public"."role_permissions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."roles" (
  "id"         bigint                   NOT NULL DEFAULT nextval('public.roles_id_seq'::regclass),
  "code"       text                     NOT NULL,
  "name"       text                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "roles_code_key" UNIQUE (code),
  CONSTRAINT "roles_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."roles"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."sessions" (
  "id"                          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"                     uuid                     NOT NULL,
  "refresh_token_hash"          text                     NOT NULL,
  "current_jti"                 text,
  "ip"                          inet,
  "user_agent"                  text,
  "device_name"                 text,
  "created_at"                  timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"                  timestamp with time zone,
  "revoked_at"                  timestamp with time zone,
  "last_seen_at"                timestamp with time zone,
  "previous_refresh_token_hash" text,
  "quarantined"                 boolean                  DEFAULT false,
  "csrf_token_hash"             text,
  "csrf_prev_token_hash"        text,
  CONSTRAINT "sessions_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."sessions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."stockists" (
  "id"         bigint                   NOT NULL DEFAULT nextval('public.stockists_id_seq'::regclass),
  "type"       text                     NOT NULL,
  "name"       text                     NOT NULL,
  "address"    text                     NOT NULL,
  "phone"      text                     NOT NULL,
  "time"       text                     NOT NULL,
  "holiday"    text                     NOT NULL,
  "status"     text                     NOT NULL DEFAULT 'private'::text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "stockists_pkey" PRIMARY KEY (id),
  CONSTRAINT "stockists_status_check" CHECK ((status = ANY (ARRAY['private'::text, 'published'::text]))),
  CONSTRAINT "stockists_type_check" CHECK ((type = ANY (ARRAY['FLAGSHIP STORE'::text, 'STORE'::text, 'SELECT SHOP'::text])))
);

ALTER TABLE "public"."stockists"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."stripe_balance_transactions" (
  "id"                 text                     NOT NULL,
  "source_id"          text                     NOT NULL,
  "payment_intent_id"  text,
  "order_id"           uuid,
  "payout_id"          text,
  "type"               text                     NOT NULL,
  "reporting_category" text                     NOT NULL,
  "amount"             integer                  NOT NULL,
  "fee"                integer                  NOT NULL,
  "net"                integer                  NOT NULL,
  "currency"           text                     NOT NULL,
  "status"             text                     NOT NULL,
  "available_on"       timestamp with time zone,
  "stripe_created_at"  timestamp with time zone NOT NULL,
  "fee_details"        jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  "raw_payload"        jsonb                    NOT NULL,
  "synced_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "stripe_balance_transactions_amount_net_check" CHECK (((amount - fee) = net)),
  CONSTRAINT "stripe_balance_transactions_currency_check" CHECK (((currency = lower(currency)) AND (currency ~ '^[a-z]{3}$'::text))),
  CONSTRAINT "stripe_balance_transactions_pkey" PRIMARY KEY (id),
  CONSTRAINT "stripe_balance_transactions_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'available'::text])))
);

ALTER TABLE "public"."stripe_balance_transactions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."stripe_payouts" (
  "id"                    text                     NOT NULL,
  "amount"                integer                  NOT NULL,
  "currency"              text                     NOT NULL,
  "status"                text                     NOT NULL,
  "automatic"             boolean                  NOT NULL,
  "arrival_date"          date,
  "stripe_created_at"     timestamp with time zone NOT NULL,
  "paid_at"               timestamp with time zone,
  "reconciliation_status" text                     NOT NULL DEFAULT 'pending'::text,
  "reconciled_net"        integer                  NOT NULL DEFAULT 0,
  "bank_arrival_date"     date,
  "bank_confirmed_at"     timestamp with time zone,
  "bank_confirmed_by"     uuid,
  "raw_payload"           jsonb                    NOT NULL,
  "synced_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "stripe_payouts_amount_positive_check" CHECK ((amount > 0)),
  CONSTRAINT "stripe_payouts_bank_confirmation_check"
    CHECK ((((bank_arrival_date IS NULL) AND (bank_confirmed_at IS NULL) AND (bank_confirmed_by IS NULL)) OR ((bank_arrival_date IS NOT NULL) AND (bank_confirmed_at IS
    NOT NULL) AND (bank_confirmed_by IS NOT NULL)))),
  CONSTRAINT "stripe_payouts_currency_check" CHECK (((currency = lower(currency)) AND (currency ~ '^[a-z]{3}$'::text))),
  CONSTRAINT "stripe_payouts_pkey" PRIMARY KEY (id),
  CONSTRAINT "stripe_payouts_reconciliation_status_check" CHECK ((reconciliation_status = ANY (ARRAY['pending'::text, 'matched'::text, 'mismatch'::text]))),
  CONSTRAINT "stripe_payouts_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'in_transit'::text, 'paid'::text, 'failed'::text, 'canceled'::text])))
);

ALTER TABLE "public"."stripe_payouts"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."stripe_refunds" (
  "id"                             text                     NOT NULL,
  "payment_intent_id"              text                     NOT NULL,
  "charge_id"                      text,
  "order_id"                       uuid                     NOT NULL,
  "amount"                         integer                  NOT NULL,
  "currency"                       text                     NOT NULL,
  "status"                         text                     NOT NULL,
  "reason"                         text,
  "balance_transaction_id"         text,
  "failure_balance_transaction_id" text,
  "stripe_created_at"              timestamp with time zone NOT NULL,
  "succeeded_at"                   timestamp with time zone,
  "raw_payload"                    jsonb                    NOT NULL,
  "synced_at"                      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "stripe_refunds_amount_positive_check" CHECK ((amount > 0)),
  CONSTRAINT "stripe_refunds_currency_check" CHECK (((currency = lower(currency)) AND (currency ~ '^[a-z]{3}$'::text))),
  CONSTRAINT "stripe_refunds_pkey" PRIMARY KEY (id),
  CONSTRAINT "stripe_refunds_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'requires_action'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text]))),
  CONSTRAINT "stripe_refunds_succeeded_at_check" CHECK (((status <> 'succeeded'::text) OR (succeeded_at IS NOT NULL)))
);

ALTER TABLE "public"."stripe_refunds"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."stripe_webhook_events" (
  "id"                text                     NOT NULL,
  "event_type"        text                     NOT NULL,
  "processed_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "raw_payload"       jsonb,
  "processing_status" text                     NOT NULL DEFAULT 'completed'::text,
  "attempt_count"     integer                  NOT NULL DEFAULT 1,
  "completed_at"      timestamp with time zone,
  "last_error"        text,
  CONSTRAINT "stripe_webhook_events_attempt_count_check" CHECK ((attempt_count >= 1)),
  CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY (id),
  CONSTRAINT "stripe_webhook_events_processing_status_check" CHECK ((processing_status = ANY (ARRAY['processing'::text, 'completed'::text, 'failed'::text])))
);

ALTER TABLE "public"."stripe_webhook_events"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."user_roles" (
  "user_id"     uuid                     NOT NULL,
  "role_id"     bigint                   NOT NULL,
  "active"      boolean                  NOT NULL DEFAULT true,
  "assigned_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"  timestamp with time zone,
  "assigned_by" uuid,
  CONSTRAINT "user_roles_pkey" PRIMARY KEY (user_id, role_id)
);

ALTER TABLE "public"."user_roles"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."wishlist" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    uuid,
  "session_id" text,
  "item_id"    bigint                   NOT NULL,
  "added_at"   timestamp with time zone DEFAULT now(),
  CONSTRAINT "wishlist_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."wishlist"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "security"."alert_events" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "action"      text                     NOT NULL,
  "detail"      text,
  "ip_address"  text,
  "actor_id"    uuid,
  "actor_email" text,
  "metadata"    jsonb,
  "created_at"  timestamp with time zone DEFAULT now(),
  CONSTRAINT "alert_events_pkey" PRIMARY KEY (id)
);

CREATE TABLE "security"."security_alerts" (
  "id"             uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "key"            text                     NOT NULL,
  "action"         text                     NOT NULL,
  "detail"         text,
  "count"          integer                  NOT NULL,
  "window_minutes" integer                  NOT NULL,
  "created_at"     timestamp with time zone DEFAULT now(),
  CONSTRAINT "security_alerts_pkey" PRIMARY KEY (id)
);

ALTER SEQUENCE "public"."admin_finance_entry_review_acks_id_seq" OWNED BY "public"."admin_finance_entry_review_acks"."id";

ALTER SEQUENCE "public"."admin_finance_entry_revisions_id_seq" OWNED BY "public"."admin_finance_entry_revisions"."id";

ALTER SEQUENCE "public"."admin_finance_expense_templates_id_seq" OWNED BY "public"."admin_finance_expense_templates"."id";

ALTER SEQUENCE "public"."admin_finance_expenses_id_seq" OWNED BY "public"."admin_finance_expenses"."id";

ALTER TABLE "public"."admin_finance_expenses"
  ADD COLUMN "fiscal_year" integer GENERATED ALWAYS AS ((EXTRACT(year FROM expense_date))::integer) STORED;

ALTER SEQUENCE "public"."admin_finance_fixed_assets_id_seq" OWNED BY "public"."admin_finance_fixed_assets"."id";

ALTER SEQUENCE "public"."admin_finance_partners_id_seq" OWNED BY "public"."admin_finance_partners"."id";

ALTER SEQUENCE "public"."admin_finance_receipts_id_seq" OWNED BY "public"."admin_finance_receipts"."id";

ALTER SEQUENCE "public"."admin_finance_summary_options_id_seq" OWNED BY "public"."admin_finance_summary_options"."id";

ALTER SEQUENCE "public"."admin_kpi_targets_id_seq" OWNED BY "public"."admin_kpi_targets"."id";

ALTER SEQUENCE "public"."order_revisions_id_seq" OWNED BY "public"."order_revisions"."id";

ALTER SEQUENCE "public"."permissions_id_seq" OWNED BY "public"."permissions"."id";

ALTER SEQUENCE "public"."rate_limit_counters_id_seq" OWNED BY "public"."rate_limit_counters"."id";

ALTER SEQUENCE "public"."roles_id_seq" OWNED BY "public"."roles"."id";

ALTER SEQUENCE "public"."stockists_id_seq" OWNED BY "public"."stockists"."id";

CREATE TYPE "public"."order_status" AS ENUM (
  'pending',
  'paid',
  'failed',
  'cancelled',
  'shipped'
);

ALTER TABLE "public"."orders"
  ADD COLUMN "status" public.order_status NOT NULL DEFAULT 'pending'::public.order_status;

CREATE OR REPLACE FUNCTION private.protect_legal_order_delete()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'pg_catalog'
  AS $function$
BEGIN
  RAISE EXCEPTION 'legal order records cannot be deleted'
    USING ERRCODE = 'restrict_violation';
END;
$function$;

CREATE OR REPLACE FUNCTION private.protect_legal_order_immutable_fields()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'pg_catalog'
  AS $function$
BEGIN
  IF ROW(
    OLD.id,
    OLD.session_id,
    OLD.checkout_session_id,
    OLD.payment_intent_id,
    OLD.subtotal_amount,
    OLD.shipping_amount,
    OLD.discount_amount,
    OLD.total_amount,
    OLD.currency,
    OLD.shipping_email,
    OLD.shipping_full_name,
    OLD.shipping_postal_code,
    OLD.shipping_prefecture,
    OLD.shipping_city,
    OLD.shipping_address,
    OLD.shipping_building,
    OLD.shipping_phone,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.session_id,
    NEW.checkout_session_id,
    NEW.payment_intent_id,
    NEW.subtotal_amount,
    NEW.shipping_amount,
    NEW.discount_amount,
    NEW.total_amount,
    NEW.currency,
    NEW.shipping_email,
    NEW.shipping_full_name,
    NEW.shipping_postal_code,
    NEW.shipping_prefecture,
    NEW.shipping_city,
    NEW.shipping_address,
    NEW.shipping_building,
    NEW.shipping_phone,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'immutable legal order fields cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.protect_legal_order_item_delete()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'pg_catalog'
  AS $function$
BEGIN
  RAISE EXCEPTION 'legal order records cannot be deleted'
    USING ERRCODE = 'restrict_violation';
END;
$function$;

CREATE OR REPLACE FUNCTION private.protect_legal_order_item_immutable_fields()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'pg_catalog'
  AS $function$
BEGIN
  IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    RAISE EXCEPTION 'immutable legal order item fields cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.record_order_revision()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'public'
  AS $function$
DECLARE
  changed text[];
  revision_operation text;
  revision_reason text;
  revision_source_event_id text;
BEGIN
  SELECT COALESCE(array_agg(key ORDER BY key), '{}')
  INTO changed
  FROM jsonb_each(to_jsonb(NEW)) AS new_value(key, value)
  WHERE value IS DISTINCT FROM (to_jsonb(OLD) -> key);

  IF cardinality(changed) = 0 THEN
    RETURN NEW;
  END IF;

  IF changed && ARRAY['refunded_amount', 'refunded_at'] THEN
    revision_operation := 'refund_update';
  ELSIF changed && ARRAY['status'] THEN
    revision_operation := 'status_update';
  ELSE
    revision_operation := 'operational_update';
  END IF;

  revision_reason := NULLIF(
    current_setting('app.order_change_reason', true),
    ''
  );
  revision_source_event_id := NULLIF(
    current_setting('app.order_source_event_id', true),
    ''
  );

  INSERT INTO public.order_revisions (
    order_id,
    operation,
    before_data,
    after_data,
    changed_fields,
    changed_by,
    reason,
    source_event_id
  ) VALUES (
    NEW.id,
    revision_operation,
    to_jsonb(OLD),
    to_jsonb(NEW),
    changed,
    auth.uid(),
    revision_reason,
    revision_source_event_id
  );

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.set_request_context()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'public', 'private'
  AS $function$
declare
  request_headers json := coalesce(current_setting('request.headers', true), '{}')::json;
  request_cookies json := coalesce(current_setting('request.cookies', true), '{}')::json;
  header_session_id text := nullif(btrim(coalesce(request_headers->>'x-session-id', '')), '');
  cookie_session_id text := nullif(btrim(coalesce(request_cookies->>'session_id', '')), '');
begin
  perform set_config('app.session_id', coalesce(header_session_id, cookie_session_id, ''), true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.add_guest_cart_item (
  p_session_id text,
  p_item_id    integer,
  p_quantity   integer,
  p_color      text    DEFAULT NULL::text,
  p_size       text    DEFAULT NULL::text
)
  RETURNS TABLE (
    id         uuid,
    item_id    integer,
    quantity   integer,
    color      text,
    size       text,
    added_at   timestamp with time zone,
    updated_at timestamp with time zone
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  v_existing public.carts%ROWTYPE;
  v_stock_quantity integer;
  v_next_quantity integer;
BEGIN
  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RAISE EXCEPTION 'session_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 20 THEN
    RAISE EXCEPTION 'quantity must be between 1 and 20' USING ERRCODE = '22023';
  END IF;

  SELECT i.stock_quantity
    INTO v_stock_quantity
  FROM public.items AS i
  WHERE i.id = p_item_id
    AND i.status = 'published';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'item not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_existing
  FROM public.carts AS c
  WHERE c.user_id IS NULL
    AND c.session_id = p_session_id
    AND c.item_id = p_item_id
    AND COALESCE(c.color, '') = COALESCE(p_color, '')
    AND COALESCE(c.size, '') = COALESCE(p_size, '')
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    v_next_quantity := v_existing.quantity + p_quantity;
  ELSE
    v_next_quantity := p_quantity;
  END IF;

  IF v_stock_quantity IS NOT NULL AND v_next_quantity > v_stock_quantity THEN
    RAISE EXCEPTION 'requested quantity exceeds available stock' USING ERRCODE = '23514';
  END IF;

  IF FOUND THEN
    RETURN QUERY
    UPDATE public.carts AS c
      SET quantity = v_next_quantity,
          updated_at = now()
    WHERE c.id = v_existing.id
    RETURNING c.id, c.item_id, c.quantity, c.color, c.size, c.added_at, c.updated_at;
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.carts (session_id, item_id, quantity, color, size)
  VALUES (p_session_id, p_item_id, p_quantity, NULLIF(btrim(COALESCE(p_color, '')), ''), NULLIF(btrim(COALESCE(p_size, '')), ''))
  RETURNING carts.id, carts.item_id, carts.quantity, carts.color, carts.size, carts.added_at, carts.updated_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.add_guest_wishlist_item (
  p_session_id text,
  p_item_id    integer
)
  RETURNS TABLE (
    id       uuid,
    item_id  integer,
    added_at timestamp with time zone
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
BEGIN
  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RAISE EXCEPTION 'session_id is required' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.items AS i
    WHERE i.id = p_item_id
      AND i.status = 'published'
  ) THEN
    RAISE EXCEPTION 'item not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  INSERT INTO public.wishlist (session_id, item_id)
  VALUES (p_session_id, p_item_id)
  RETURNING wishlist.id, wishlist.item_id, wishlist.added_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cleanup_password_reset_tokens (
  p_retain_days integer DEFAULT 7
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
  deleted integer;
  cutoff timestamptz := now() - make_interval(days => greatest(p_retain_days, 0));
BEGIN
  DELETE FROM public.password_reset_tokens
  WHERE created_at < cutoff
    AND (used = true OR expires_at < now());

  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clear_admin_expense_cost_allocations (
  p_expense_id bigint
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_temp'
  AS $function$
BEGIN
  PERFORM 1 FROM public.admin_finance_expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
  DELETE FROM public.admin_expense_cost_allocations WHERE expense_id = p_expense_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_profile_for_new_auth_user()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
BEGIN
  -- Ensure profiles table exists and insert a row if not present.
  INSERT INTO public.profiles(user_id, created_at)
  VALUES (NEW.id, now())
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.current_app_role()
  RETURNS text
  LANGUAGE sql
  STABLE
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
  SELECT COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), 'user');
$function$;

CREATE OR REPLACE FUNCTION public.delete_cart_item_secure (
  _cart_id    uuid,
  _session_id text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  deleted_count integer;
BEGIN
  IF _cart_id IS NULL OR _session_id IS NULL OR btrim(_session_id) = '' THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  DELETE FROM public.carts
  WHERE id = _cart_id
    AND session_id = _session_id;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  IF deleted_count = 0 THEN
    RAISE EXCEPTION 'CART_ITEM_NOT_FOUND';
  END IF;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_guest_cart_item (
  p_session_id text,
  p_cart_id    uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  v_deleted_count integer;
BEGIN
  DELETE FROM public.carts AS c
  WHERE c.id = p_cart_id
    AND c.user_id IS NULL
    AND c.session_id = p_session_id;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count > 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_guest_wishlist_item (
  p_session_id  text,
  p_wishlist_id uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  v_deleted_count integer;
BEGIN
  DELETE FROM public.wishlist AS w
  WHERE w.id = p_wishlist_id
    AND w.user_id IS NULL
    AND w.session_id = p_session_id;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count > 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_order_from_checkout_draft (
  _draft_id              uuid,
  _payment_intent_id     text,
  _checkout_session_id   text,
  _order_status          public.order_status,
  _expected_total_amount integer,
  _currency              text
)
  RETURNS TABLE (
    order_id     uuid,
    order_status public.order_status
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  draft_row public.checkout_drafts%ROWTYPE;
  item_snapshot jsonb;
  item_id_val integer;
  item_qty integer;
  item_stock integer;
  item_status text;
  inserted_order_id uuid;
  inserted_order_status public.order_status;
BEGIN
  IF _draft_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_CHECKOUT_DRAFT';
  END IF;

  IF _payment_intent_id IS NULL OR btrim(_payment_intent_id) = '' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_REFERENCE';
  END IF;

  -- Idempotency: return existing order if already finalized
  SELECT o.id, o.status
  INTO inserted_order_id, inserted_order_status
  FROM public.orders o
  WHERE o.payment_intent_id = _payment_intent_id
  LIMIT 1;

  IF inserted_order_id IS NOT NULL THEN
    RETURN QUERY SELECT inserted_order_id, inserted_order_status;
    RETURN;
  END IF;

  -- Lock draft row
  SELECT *
  INTO draft_row
  FROM public.checkout_drafts d
  WHERE d.id = _draft_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_CHECKOUT_DRAFT';
  END IF;

  -- Verify total amount matches
  IF _expected_total_amount IS NOT NULL AND draft_row.total_amount <> _expected_total_amount THEN
    RAISE EXCEPTION 'CHECKOUT_TOTAL_MISMATCH:%:%', draft_row.total_amount, _expected_total_amount;
  END IF;

  IF _currency IS NOT NULL AND lower(draft_row.currency) <> lower(_currency) THEN
    RAISE EXCEPTION 'CHECKOUT_CURRENCY_MISMATCH:%:%', draft_row.currency, _currency;
  END IF;

  -- Lock items and verify stock from items_snapshot
  FOR item_snapshot IN
    SELECT jsonb_array_elements(draft_row.items_snapshot)
  LOOP
    item_id_val := (item_snapshot->>'item_id')::integer;
    item_qty    := (item_snapshot->>'quantity')::integer;

    SELECT i.status, i.stock_quantity
    INTO item_status, item_stock
    FROM public.items i
    WHERE i.id = item_id_val
    FOR UPDATE;

    IF item_status <> 'published' THEN
      RAISE EXCEPTION 'ITEM_NOT_PUBLISHED:%', item_id_val;
    END IF;

    IF item_stock IS NOT NULL AND item_qty > item_stock THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%', item_id_val, item_qty, item_stock;
    END IF;
  END LOOP;

  -- Insert order
  BEGIN
    INSERT INTO public.orders (
      session_id,
      checkout_session_id,
      payment_intent_id,
      status,
      subtotal_amount,
      shipping_amount,
      discount_amount,
      total_amount,
      currency,
      shipping_email,
      shipping_full_name,
      shipping_postal_code,
      shipping_prefecture,
      shipping_city,
      shipping_address,
      shipping_building,
      shipping_phone
    ) VALUES (
      draft_row.session_id,
      _checkout_session_id,
      _payment_intent_id,
      _order_status,
      draft_row.subtotal_amount,
      draft_row.shipping_amount,
      0,
      draft_row.total_amount,
      draft_row.currency,
      draft_row.shipping_snapshot->>'email',
      draft_row.shipping_snapshot->>'fullName',
      draft_row.shipping_snapshot->>'postalCode',
      draft_row.shipping_snapshot->>'prefecture',
      draft_row.shipping_snapshot->>'city',
      draft_row.shipping_snapshot->>'address',
      draft_row.shipping_snapshot->>'building',
      draft_row.shipping_snapshot->>'phone'
    )
    RETURNING id, status
    INTO inserted_order_id, inserted_order_status;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT o.id, o.status
      INTO inserted_order_id, inserted_order_status
      FROM public.orders o
      WHERE o.payment_intent_id = _payment_intent_id
      LIMIT 1;
      IF inserted_order_id IS NOT NULL THEN
        RETURN QUERY SELECT inserted_order_id, inserted_order_status;
        RETURN;
      END IF;
      RAISE;
  END;

  -- Insert order_items from items_snapshot
  INSERT INTO public.order_items (
    order_id,
    item_id,
    item_name,
    item_price,
    item_image_url,
    color,
    size,
    quantity,
    line_total
  )
  SELECT
    inserted_order_id,
    (s->>'item_id')::integer,
    s->>'item_name',
    (s->>'item_price')::integer,
    s->>'item_image_url',
    s->>'color',
    s->>'size',
    (s->>'quantity')::integer,
    (s->>'line_total')::integer
  FROM jsonb_array_elements(draft_row.items_snapshot) AS s;

  -- Decrement stock
  UPDATE public.items i
  SET stock_quantity = i.stock_quantity - (s->>'quantity')::integer
  FROM jsonb_array_elements(draft_row.items_snapshot) AS s
  WHERE i.id = (s->>'item_id')::integer
    AND i.stock_quantity IS NOT NULL;

  -- Remove cart items
  DELETE FROM public.carts c
  USING jsonb_array_elements(draft_row.items_snapshot) AS s
  WHERE (s->>'source_cart_id') IS NOT NULL
    AND c.id = (s->>'source_cart_id')::uuid
    AND c.session_id = draft_row.session_id;

  -- Mark draft completed
  UPDATE public.checkout_drafts
  SET status = 'completed',
      checkout_session_id = COALESCE(checkout_session_id, _checkout_session_id),
      payment_intent_id   = COALESCE(payment_intent_id, _payment_intent_id)
  WHERE id = _draft_id;

  RETURN QUERY SELECT inserted_order_id, inserted_order_status;
END;
$function$;

CREATE OR REPLACE FUNCTION public.find_auth_user_id_by_email (
  p_email text
)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  SELECT u.id
  FROM auth.users u
  WHERE u.email = lower(btrim(p_email))
    AND u.deleted_at IS NULL
    AND u.is_sso_user = false
    AND (u.banned_until IS NULL OR u.banned_until < now())
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_popular_items (
  limit_count integer DEFAULT 4
)
  RETURNS TABLE (
    id             bigint,
    name           text,
    description    text,
    category       text,
    image_url      text,
    price          integer,
    purchase_count bigint
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
  SELECT
    i.id::bigint,
    i.name::text,
    i.description::text,
    i.category::text,
    i.image_url::text,
    i.price::int,
    COALESCE(paid.purchase_count, 0)::bigint AS purchase_count
  FROM items AS i
  LEFT JOIN (
    SELECT
      oi.item_id,
      SUM(oi.quantity) AS purchase_count
    FROM order_items AS oi
    JOIN orders AS o ON o.id = oi.order_id
    WHERE o.status = 'paid'
    GROUP BY oi.item_id
  ) AS paid ON paid.item_id = i.id
  WHERE i.status = 'published'
  ORDER BY COALESCE(paid.purchase_count, 0) DESC, i.created_at DESC
  LIMIT limit_count;
$function$;

CREATE OR REPLACE FUNCTION public.has_permission (
  permission_code text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  uid uuid;
  role_code text;
  acl_allowed boolean;
BEGIN
  uid := auth.uid();
  IF uid IS NULL THEN
    RETURN false;
  END IF;

  role_code := public.current_app_role();

  IF role_code = 'admin' THEN
    RETURN true;
  END IF;

  IF role_code = 'supporter' AND permission_code IN ('admin.orders.read', 'admin.orders.manage', 'admin.users.read') THEN
    RETURN true;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = uid
      AND ur.active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
      AND p.code = permission_code
  ) INTO acl_allowed;

  RETURN COALESCE(acl_allowed, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.increment_rate_limit_counter (
  _ip       inet,
  _endpoint text,
  _bucket   timestamp with time zone
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  next_count integer;
BEGIN
  INSERT INTO public.rate_limit_counters (ip, endpoint, bucket, count, created_at, last_seen_at)
  VALUES (_ip, _endpoint, _bucket, 1, now(), now())
  ON CONFLICT (ip, endpoint, bucket)
  DO UPDATE SET
    count = public.rate_limit_counters.count + 1,
    last_seen_at = now()
  RETURNING count INTO next_count;

  RETURN next_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.increment_rate_limit_counter (
  _ip        inet,
  _endpoint  text,
  _bucket    timestamp with time zone,
  _increment integer
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  next_count integer;
  normalized_increment integer;
BEGIN
  normalized_increment := GREATEST(COALESCE(_increment, 1), 1);

  INSERT INTO public.rate_limit_counters (ip, endpoint, bucket, count, created_at, last_seen_at)
  VALUES (_ip, _endpoint, _bucket, normalized_increment, now(), now())
  ON CONFLICT (ip, endpoint, bucket)
  DO UPDATE SET
    count = public.rate_limit_counters.count + normalized_increment,
    last_seen_at = now()
  RETURNING count INTO next_count;

  RETURN next_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_auth_session_active (
  p_session_id uuid
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM auth.sessions s
    WHERE s.id = p_session_id
      AND (s.not_after IS NULL OR s.not_after > now())
  );
$function$;

CREATE OR REPLACE FUNCTION public.list_guest_cart (
  p_session_id text
)
  RETURNS TABLE (
    id         uuid,
    item_id    integer,
    quantity   integer,
    color      text,
    size       text,
    added_at   timestamp with time zone,
    updated_at timestamp with time zone
  )
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  SELECT c.id, c.item_id, c.quantity, c.color, c.size, c.added_at, c.updated_at
  FROM public.carts AS c
  WHERE c.user_id IS NULL
    AND c.session_id = p_session_id
  ORDER BY c.added_at DESC;
$function$;

CREATE OR REPLACE FUNCTION public.list_guest_wishlist (
  p_session_id text
)
  RETURNS TABLE (
    id       uuid,
    item_id  integer,
    added_at timestamp with time zone
  )
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  SELECT w.id, w.item_id, w.added_at
  FROM public.wishlist AS w
  WHERE w.user_id IS NULL
    AND w.session_id = p_session_id
  ORDER BY w.added_at DESC;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_allocated_expense_integrity_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_temp'
  AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.admin_expense_cost_allocations WHERE expense_id = OLD.id
  ) AND (
    NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.season_key IS DISTINCT FROM OLD.season_key
    OR NEW.entry_type IS DISTINCT FROM OLD.entry_type
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  ) THEN
    RAISE EXCEPTION 'Clear product cost allocations before changing or deleting this expense';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_allocated_item_season_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
BEGIN
  IF NEW.season_key IS DISTINCT FROM OLD.season_key
     AND EXISTS (
       SELECT 1
       FROM public.admin_expense_cost_allocations allocation
       WHERE allocation.item_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'Clear the item allocations before changing its season';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_admin_finance_entry_revision()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  actor uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
    VALUES (NEW.id, 'insert', NULL, to_jsonb(NEW), NEW.created_by);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      actor := COALESCE(NEW.deleted_by, NEW.updated_by);
      INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
      VALUES (NEW.id, 'delete', to_jsonb(OLD), to_jsonb(NEW), actor);
      RETURN NEW;
    END IF;

    IF to_jsonb(OLD) - 'updated_at' - 'fixed_asset_exempt' - 'fixed_asset_exempt_reason'
         - 'fixed_asset_reviewed_at' - 'fixed_asset_reviewed_by'
       = to_jsonb(NEW) - 'updated_at' - 'fixed_asset_exempt' - 'fixed_asset_exempt_reason'
         - 'fixed_asset_reviewed_at' - 'fixed_asset_reviewed_by' THEN
      RETURN NEW;
    END IF;

    INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
    VALUES (NEW.id, 'update', to_jsonb(OLD), to_jsonb(NEW), NEW.updated_by);
    RETURN NEW;
  END IF;

  INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
  VALUES (OLD.id, 'delete', to_jsonb(OLD), NULL, OLD.updated_by);
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.replace_admin_expense_cost_allocations (
  p_expense_id bigint,
  p_lines      jsonb,
  p_created_by uuid   DEFAULT NULL::uuid
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_temp'
  AS $function$
DECLARE
  expense_row public.admin_finance_expenses%ROWTYPE;
  line jsonb;
  line_amount bigint;
  total_amount bigint := 0;
  line_target text;
  line_item_id bigint;
  line_cost_type text;
  line_other_label text;
BEGIN
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'At least one allocation line is required';
  END IF;

  SELECT * INTO expense_row
  FROM public.admin_finance_expenses
  WHERE id = p_expense_id
  FOR UPDATE;

  IF NOT FOUND OR expense_row.deleted_at IS NOT NULL OR expense_row.entry_type <> 'expense' THEN
    RAISE EXCEPTION 'Allocation target must be an active expense';
  END IF;
  IF expense_row.season_key IS NULL THEN
    RAISE EXCEPTION 'Allocation target must have a season tag';
  END IF;

  FOR line IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    line_target := line->>'targetType';
    line_cost_type := line->>'costType';
    line_other_label := NULLIF(btrim(line->>'otherLabel'), '');
    line_item_id := CASE
      WHEN line_target = 'item' THEN (line->>'itemId')::bigint
      ELSE NULL
    END;
    line_amount := (line->>'amount')::bigint;

    IF line_target NOT IN ('item', 'season_common') THEN
      RAISE EXCEPTION 'Invalid allocation target type';
    END IF;
    IF line_cost_type NOT IN (
      'material', 'sewing', 'pattern', 'planning', 'accessories', 'processing',
      'inspection_finishing', 'logistics', 'advertising', 'photography',
      'exhibition', 'other'
    ) THEN
      RAISE EXCEPTION 'Invalid allocation cost type';
    END IF;
    IF line_amount <= 0 THEN
      RAISE EXCEPTION 'Allocation amount must be positive';
    END IF;
    IF line_cost_type = 'other' AND line_other_label IS NULL THEN
      RAISE EXCEPTION 'Other allocation requires a label';
    END IF;
    IF line_cost_type <> 'other' THEN
      line_other_label := NULL;
    END IF;
    IF line_target = 'item' AND NOT EXISTS (
      SELECT 1 FROM public.admin_costing_items
      WHERE id = line_item_id AND season_key = expense_row.season_key
    ) THEN
      RAISE EXCEPTION 'Allocation item must belong to the expense season';
    END IF;

    total_amount := total_amount + line_amount;
  END LOOP;

  IF total_amount <> expense_row.amount THEN
    RAISE EXCEPTION 'Allocation total must equal the expense amount';
  END IF;

  DELETE FROM public.admin_expense_cost_allocations WHERE expense_id = p_expense_id;

  FOR line IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    line_target := line->>'targetType';
    line_cost_type := line->>'costType';
    line_other_label := CASE
      WHEN line_cost_type = 'other' THEN NULLIF(btrim(line->>'otherLabel'), '')
      ELSE NULL
    END;
    line_item_id := CASE
      WHEN line_target = 'item' THEN (line->>'itemId')::bigint
      ELSE NULL
    END;
    line_amount := (line->>'amount')::bigint;

    INSERT INTO public.admin_expense_cost_allocations (
      expense_id, season_key, target_type, item_id, cost_type, other_label,
      amount, created_by
    ) VALUES (
      p_expense_id, expense_row.season_key, line_target, line_item_id,
      line_cost_type, line_other_label, line_amount, p_created_by
    );
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_auth_session (
  p_session_id uuid
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM auth.sessions WHERE id = p_session_id;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_auth_sessions_for_user (
  p_user_id uuid
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.search_items (
  search_query text,
  limit_count  integer DEFAULT 8
)
  RETURNS TABLE (
    id          bigint,
    name        text,
    description text,
    category    text,
    image_url   text,
    price       integer
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
  SELECT
    i.id::bigint,
    i.name::text,
    i.description::text,
    i.category::text,
    i.image_url::text,
    i.price::int
  FROM items AS i
  WHERE i.status = 'published'
    AND (
      i.name        ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
      OR i.description ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
      OR i.category   ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
    )
  ORDER BY i.created_at DESC
  LIMIT limit_count;
$function$;

CREATE OR REPLACE FUNCTION public.search_looks (
  search_query text,
  limit_count  integer DEFAULT 8
)
  RETURNS TABLE (
    id                bigint,
    season_year       integer,
    season_type       text,
    theme             text,
    theme_description text,
    image_urls        text[]
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
  SELECT
    l.id::bigint,
    l.season_year::int,
    l.season_type::text,
    l.theme::text,
    l.theme_description::text,
    l.image_urls::text[]
  FROM looks AS l
  WHERE l.status = 'published'
    AND (
      l.theme           ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
      OR l.theme_description ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
    )
  ORDER BY l.created_at DESC
  LIMIT limit_count;
$function$;

CREATE OR REPLACE FUNCTION public.search_news (
  search_query text,
  limit_count  integer DEFAULT 8
)
  RETURNS TABLE (
    id             bigint,
    title          text,
    category       text,
    image_url      text,
    content        text,
    published_date text
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
  SELECT
    a.id::bigint,
    a.title::text,
    a.category::text,
    a.image_url::text,
    a.content::text,
    a.published_date::text
  FROM news_articles AS a
  WHERE a.status = 'published'
    AND (
      a.title    ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
      OR a.content  ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
      OR a.category ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
    )
  ORDER BY a.published_date DESC
  LIMIT limit_count;
$function$;

CREATE OR REPLACE FUNCTION public.search_public_items (
  p_query text,
  p_limit integer DEFAULT 6
)
  RETURNS TABLE (
    id          integer,
    name        text,
    description text,
    category    text,
    image_url   text
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'public'
  AS $function$
  SELECT i.id, i.name, COALESCE(i.description, ''), i.category, i.image_url
  FROM public.items AS i
  WHERE i.status = 'published'
    AND (
      i.name ILIKE '%' || p_query || '%'
      OR COALESCE(i.description, '') ILIKE '%' || p_query || '%'
      OR i.category ILIKE '%' || p_query || '%'
    )
  ORDER BY i.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 6), 20));
$function$;

CREATE OR REPLACE FUNCTION public.search_public_looks (
  p_query text,
  p_limit integer DEFAULT 6
)
  RETURNS TABLE (
    id                integer,
    season_year       integer,
    season_type       text,
    theme             text,
    theme_description text,
    image_urls        jsonb
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'public'
  AS $function$
  SELECT l.id, l.season_year, l.season_type::text, l.theme, COALESCE(l.theme_description, ''), to_jsonb(COALESCE(l.image_urls, ARRAY[]::text[]))
  FROM public.looks AS l
  WHERE l.status = 'published'
    AND (
      l.theme ILIKE '%' || p_query || '%'
      OR COALESCE(l.theme_description, '') ILIKE '%' || p_query || '%'
    )
  ORDER BY l.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 6), 20));
$function$;

CREATE OR REPLACE FUNCTION public.search_public_news (
  p_query text,
  p_limit integer DEFAULT 6
)
  RETURNS TABLE (
    id             bigint,
    title          text,
    category       text,
    image_url      text,
    content        text,
    published_date timestamp with time zone
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'public'
  AS $function$
  SELECT n.id, n.title, n.category, n.image_url, n.content, n.published_date
  FROM public.news_articles AS n
  WHERE n.status = 'published'
    AND (
      n.title ILIKE '%' || p_query || '%'
      OR COALESCE(n.content, '') ILIKE '%' || p_query || '%'
      OR n.category ILIKE '%' || p_query || '%'
    )
  ORDER BY n.published_date DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 6), 20));
$function$;

CREATE OR REPLACE FUNCTION public.set_items_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_looks_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_news_articles_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_admin_finance_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_admin_kpi_targets_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_cart_item_quantity_secure (
  _cart_id    uuid,
  _session_id text,
  _quantity   integer
)
  RETURNS TABLE (
    id         uuid,
    user_id    uuid,
    session_id text,
    item_id    bigint,
    quantity   integer,
    color      text,
    size       text,
    added_at   timestamp with time zone,
    updated_at timestamp with time zone
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  target_cart_item public.carts%ROWTYPE;
  item_row RECORD;
  requested_total_quantity integer;
BEGIN
  IF _cart_id IS NULL OR _session_id IS NULL OR btrim(_session_id) = '' THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  IF _quantity IS NULL OR _quantity < 1 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;

  SELECT c.*
  INTO target_cart_item
  FROM public.carts AS c
  WHERE c.id = _cart_id
    AND c.session_id = _session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CART_ITEM_NOT_FOUND';
  END IF;

  SELECT i.id, i.name, i.stock_quantity, i.status
  INTO item_row
  FROM public.items AS i
  WHERE i.id = target_cart_item.item_id
  FOR SHARE;

  IF NOT FOUND OR item_row.status <> 'published' THEN
    RAISE EXCEPTION 'ITEM_NOT_FOUND';
  END IF;

  SELECT COALESCE(SUM(c.quantity), 0) + _quantity
  INTO requested_total_quantity
  FROM public.carts AS c
  WHERE c.session_id = _session_id
    AND c.item_id = target_cart_item.item_id
    AND c.id <> _cart_id;

  IF item_row.stock_quantity IS NOT NULL AND requested_total_quantity > item_row.stock_quantity THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%', item_row.id, requested_total_quantity, item_row.stock_quantity;
  END IF;

  RETURN QUERY
  UPDATE public.carts AS c
  SET quantity = _quantity,
      updated_at = now()
  WHERE c.id = _cart_id
    AND c.session_id = _session_id
  RETURNING
    c.id,
    c.user_id,
    c.session_id,
    c.item_id,
    c.quantity,
    c.color,
    c.size,
    c.added_at,
    c.updated_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_guest_cart_item_quantity (
  p_session_id text,
  p_cart_id    uuid,
  p_quantity   integer
)
  RETURNS TABLE (
    id         uuid,
    item_id    integer,
    quantity   integer,
    color      text,
    size       text,
    added_at   timestamp with time zone,
    updated_at timestamp with time zone
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  v_cart public.carts%ROWTYPE;
  v_stock_quantity integer;
BEGIN
  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RAISE EXCEPTION 'session_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 20 THEN
    RAISE EXCEPTION 'quantity must be between 1 and 20' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_cart
  FROM public.carts AS c
  WHERE c.id = p_cart_id
    AND c.user_id IS NULL
    AND c.session_id = p_session_id
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cart item not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT i.stock_quantity
    INTO v_stock_quantity
  FROM public.items AS i
  WHERE i.id = v_cart.item_id
    AND i.status = 'published';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'item not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_stock_quantity IS NOT NULL AND p_quantity > v_stock_quantity THEN
    RAISE EXCEPTION 'requested quantity exceeds available stock' USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  UPDATE public.carts AS c
    SET quantity = p_quantity,
        updated_at = now()
  WHERE c.id = v_cart.id
  RETURNING c.id, c.item_id, c.quantity, c.color, c.size, c.added_at, c.updated_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_orders_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_stockists_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_admin_expense_cost_allocation()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_temp'
  AS $function$
DECLARE
  expense_row public.admin_finance_expenses%ROWTYPE;
  item_season text;
BEGIN
  SELECT * INTO expense_row
  FROM public.admin_finance_expenses
  WHERE id = NEW.expense_id;

  IF NOT FOUND OR expense_row.deleted_at IS NOT NULL OR expense_row.entry_type <> 'expense' THEN
    RAISE EXCEPTION 'Allocation target must be an active expense';
  END IF;
  IF expense_row.season_key IS NULL OR expense_row.season_key <> NEW.season_key THEN
    RAISE EXCEPTION 'Allocation season must match the expense season';
  END IF;

  IF NEW.target_type = 'item' THEN
    SELECT season_key INTO item_season
    FROM public.admin_costing_items
    WHERE id = NEW.item_id;
    IF NOT FOUND OR item_season <> NEW.season_key THEN
      RAISE EXCEPTION 'Allocation item must belong to the expense season';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION security.count_recent_events (
  action_text    text,
  detail_text    text,
  ip_text        text    DEFAULT NULL::text,
  actor_text     text    DEFAULT NULL::text,
  window_minutes integer DEFAULT 5
)
  RETURNS TABLE (
    count bigint
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'security', 'public', 'pg_temp'
  AS $function$
  SELECT count(*)::bigint FROM security.alert_events e
  WHERE e.action = action_text
    AND (detail_text IS NULL OR e.detail = detail_text)
    AND e.created_at >= now() - (window_minutes || ' minutes')::interval
    AND (
      (ip_text IS NULL OR (e.ip_address IS NOT NULL AND e.ip_address = ip_text))
      OR (actor_text IS NULL OR (e.actor_id IS NOT NULL AND e.actor_id::text = actor_text))
    );
$function$;

ALTER TABLE "public"."admin_costing_items"
  ADD CONSTRAINT "admin_costing_items_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_expense_cost_allocations"
  ADD CONSTRAINT "admin_expense_cost_allocations_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_expense_cost_allocations"
  ADD CONSTRAINT "admin_expense_cost_allocations_item_id_fkey" FOREIGN KEY (item_id) REFERENCES public.admin_costing_items(id) ON DELETE RESTRICT;

ALTER TABLE "public"."admin_finance_entry_review_acks"
  ADD CONSTRAINT "admin_finance_entry_review_acks_reviewed_by_fkey" FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_entry_revisions"
  ADD CONSTRAINT "admin_finance_entry_revisions_changed_by_fkey" FOREIGN KEY (changed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_evidence_unavailable_records"
  ADD CONSTRAINT "admin_finance_evidence_unavailable_records_recorded_by_fkey" FOREIGN KEY (recorded_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_evidence_unavailable_records"
  ADD CONSTRAINT "admin_finance_evidence_unavailable_records_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_expense_templates"
  ADD CONSTRAINT "admin_finance_expense_templates_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_expenses"
  ADD CONSTRAINT "admin_finance_expenses_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_expenses"
  ADD CONSTRAINT "admin_finance_expenses_deleted_by_fkey" FOREIGN KEY (deleted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_expenses"
  ADD CONSTRAINT "admin_finance_expenses_fixed_asset_reviewed_by_fkey" FOREIGN KEY (fixed_asset_reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_expense_cost_allocations"
  ADD CONSTRAINT "admin_expense_cost_allocations_expense_id_fkey" FOREIGN KEY (expense_id) REFERENCES public.admin_finance_expenses(id) ON DELETE RESTRICT;

ALTER TABLE "public"."admin_finance_evidence_unavailable_records"
  ADD CONSTRAINT "admin_finance_evidence_unavailable_records_entry_id_fkey" FOREIGN KEY (entry_id) REFERENCES public.admin_finance_expenses(id) ON DELETE CASCADE;

ALTER TABLE "public"."admin_finance_expenses"
  ADD CONSTRAINT "admin_finance_expenses_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_fixed_assets"
  ADD CONSTRAINT "admin_finance_fixed_assets_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_fixed_assets"
  ADD CONSTRAINT "admin_finance_fixed_assets_entry_id_fkey" FOREIGN KEY (entry_id) REFERENCES public.admin_finance_expenses(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_partners"
  ADD CONSTRAINT "admin_finance_partners_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_receipts"
  ADD CONSTRAINT "admin_finance_receipts_entry_id_fkey" FOREIGN KEY (entry_id) REFERENCES public.admin_finance_expenses(id) ON DELETE CASCADE;

ALTER TABLE "public"."admin_finance_receipts"
  ADD CONSTRAINT "admin_finance_receipts_uploaded_by_fkey" FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_costing_items"
  ADD CONSTRAINT "admin_costing_items_season_key_fkey" FOREIGN KEY (season_key) REFERENCES public.admin_finance_seasons(season_key) ON DELETE RESTRICT;

ALTER TABLE "public"."admin_expense_cost_allocations"
  ADD CONSTRAINT "admin_expense_cost_allocations_season_key_fkey" FOREIGN KEY (season_key) REFERENCES public.admin_finance_seasons(season_key) ON DELETE RESTRICT;

ALTER TABLE "public"."admin_finance_expenses"
  ADD CONSTRAINT "admin_finance_expenses_season_key_fkey" FOREIGN KEY (season_key) REFERENCES public.admin_finance_seasons(season_key) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_summary_options"
  ADD CONSTRAINT "admin_finance_summary_options_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_year_closings"
  ADD CONSTRAINT "admin_finance_year_closings_closed_by_fkey" FOREIGN KEY (closed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."admin_finance_year_closings"
  ADD CONSTRAINT "admin_finance_year_closings_fiscal_year_fkey" FOREIGN KEY (fiscal_year) REFERENCES public.admin_finance_years(fiscal_year) ON DELETE CASCADE;

ALTER TABLE "public"."contact_messages"
  ADD CONSTRAINT "contact_messages_inquiry_id_fkey" FOREIGN KEY (inquiry_id) REFERENCES public.contact_inquiries(id) ON DELETE CASCADE;

ALTER TABLE "public"."item_cost_history"
  ADD CONSTRAINT "item_cost_history_item_id_fkey" FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;

ALTER TABLE "public"."look_items"
  ADD CONSTRAINT "look_items_item_id_fkey" FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;

ALTER TABLE "public"."look_items"
  ADD CONSTRAINT "look_items_look_id_fkey" FOREIGN KEY (look_id) REFERENCES public.looks(id) ON DELETE CASCADE;

ALTER TABLE "public"."order_items"
  ADD CONSTRAINT "order_items_item_id_fkey" FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE RESTRICT;

ALTER TABLE "public"."order_revisions"
  ADD CONSTRAINT "order_revisions_changed_by_fkey" FOREIGN KEY (changed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."contact_inquiries"
  ADD CONSTRAINT "contact_inquiries_order_id_fkey" FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;

ALTER TABLE "public"."order_items"
  ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE "public"."order_revisions"
  ADD CONSTRAINT "order_revisions_order_id_fkey" FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;

ALTER TABLE "public"."password_reset_tokens"
  ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."carts"
  ADD CONSTRAINT "carts_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;

ALTER TABLE "public"."orders"
  ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE SET NULL;

ALTER TABLE "public"."profiles"
  ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."refresh_token_history"
  ADD CONSTRAINT "refresh_token_history_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."role_permissions"
  ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;

ALTER TABLE "public"."role_permissions"
  ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;

ALTER TABLE "public"."refresh_token_history"
  ADD CONSTRAINT "refresh_token_history_session_id_fkey" FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

ALTER TABLE "public"."sessions"
  ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."stripe_balance_transactions"
  ADD CONSTRAINT "stripe_balance_transactions_order_id_fkey" FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;

ALTER TABLE "public"."stripe_payouts"
  ADD CONSTRAINT "stripe_payouts_bank_confirmed_by_fkey" FOREIGN KEY (bank_confirmed_by) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE "public"."stripe_refunds"
  ADD CONSTRAINT "stripe_refunds_balance_transaction_id_fkey" FOREIGN KEY (balance_transaction_id) REFERENCES public.stripe_balance_transactions(id) ON DELETE RESTRICT;

ALTER TABLE "public"."stripe_refunds"
  ADD CONSTRAINT "stripe_refunds_failure_balance_transaction_id_fkey" FOREIGN KEY (failure_balance_transaction_id) REFERENCES public.stripe_balance_transactions(id)
    ON DELETE RESTRICT;

ALTER TABLE "public"."stripe_refunds"
  ADD CONSTRAINT "stripe_refunds_order_id_fkey" FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;

ALTER TABLE "public"."user_roles"
  ADD CONSTRAINT "user_roles_assigned_by_fkey" FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."user_roles"
  ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE RESTRICT;

ALTER TABLE "public"."user_roles"
  ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."wishlist"
  ADD CONSTRAINT "wishlist_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;

CREATE INDEX audit_logs_action_idx ON public.audit_logs USING btree (action);

CREATE INDEX audit_logs_created_at_idx ON public.audit_logs USING btree (created_at);

CREATE INDEX contact_inquiries_created_at_idx ON public.contact_inquiries USING btree (created_at DESC);

CREATE INDEX contact_inquiries_email_idx ON public.contact_inquiries USING btree (email);

CREATE INDEX contact_inquiries_last_message_at_idx ON public.contact_inquiries USING btree (last_message_at DESC);

CREATE INDEX contact_inquiries_status_idx ON public.contact_inquiries USING btree (status);

CREATE INDEX contact_inquiries_user_id_idx ON public.contact_inquiries USING btree (user_id);

CREATE INDEX contact_messages_inquiry_created_idx ON public.contact_messages USING btree (inquiry_id, created_at);

CREATE INDEX contact_reply_templates_category_idx ON public.contact_reply_templates USING btree (category);

CREATE INDEX contact_reply_templates_sort_order_idx ON public.contact_reply_templates USING btree (sort_order);

CREATE INDEX idx_admin_costing_items_created_by ON public.admin_costing_items USING btree (created_by)
  WHERE (created_by IS NOT NULL);

CREATE INDEX idx_admin_costing_items_season_category ON public.admin_costing_items USING btree (season_key, category, id);

CREATE INDEX idx_admin_expense_cost_allocations_created_by ON public.admin_expense_cost_allocations USING btree (created_by)
  WHERE (created_by IS NOT NULL);

CREATE INDEX idx_admin_expense_cost_allocations_expense ON public.admin_expense_cost_allocations USING btree (expense_id, id);

CREATE INDEX idx_admin_expense_cost_allocations_item ON public.admin_expense_cost_allocations USING btree (item_id, id)
  WHERE (item_id IS NOT NULL);

CREATE INDEX idx_admin_expense_cost_allocations_season ON public.admin_expense_cost_allocations USING btree (season_key, target_type, id);

CREATE INDEX idx_admin_finance_entry_review_acks_ref ON public.admin_finance_entry_review_acks USING btree (entry_ref);

CREATE INDEX idx_admin_finance_entry_revisions_changed_at ON public.admin_finance_entry_revisions USING btree (changed_at DESC);

CREATE INDEX idx_admin_finance_entry_revisions_entry ON public.admin_finance_entry_revisions USING btree (entry_id, changed_at DESC);

CREATE INDEX idx_admin_finance_expenses_active_year ON public.admin_finance_expenses USING btree (fiscal_year, expense_date DESC, id DESC)
  WHERE (deleted_at IS NULL);

CREATE INDEX idx_admin_finance_expenses_season_tag ON public.admin_finance_expenses USING btree (season_key, expense_date DESC)
  WHERE (season_key IS NOT NULL);

CREATE INDEX idx_admin_finance_expenses_year_date ON public.admin_finance_expenses USING btree (fiscal_year, expense_date DESC, id DESC);

CREATE INDEX idx_admin_finance_expenses_year_type_date ON public.admin_finance_expenses USING btree (fiscal_year, entry_type, expense_date DESC, id DESC);

CREATE INDEX idx_admin_finance_fixed_assets_acquired ON public.admin_finance_fixed_assets USING btree (acquired_on);

CREATE UNIQUE INDEX idx_admin_finance_fixed_assets_entry ON public.admin_finance_fixed_assets USING btree (entry_id)
  WHERE (entry_id IS NOT NULL);

CREATE INDEX idx_admin_finance_receipts_entry ON public.admin_finance_receipts USING btree (entry_id, created_at DESC);

CREATE INDEX idx_admin_kpi_targets_kpi_key ON public.admin_kpi_targets USING btree (kpi_key);

CREATE INDEX idx_admin_kpi_targets_season_key ON public.admin_kpi_targets USING btree (season_key);

CREATE INDEX idx_carts_added_at ON public.carts USING btree (added_at);

CREATE INDEX idx_carts_item_id ON public.carts USING btree (item_id);

CREATE INDEX idx_carts_session_id ON public.carts USING btree (session_id);

CREATE UNIQUE INDEX idx_carts_unique_per_user_session_item ON public.carts
  USING btree (COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(session_id, ''::text), item_id, COALESCE(color, ''::text), COALESCE(size, ''::text));

CREATE INDEX idx_carts_user_id ON public.carts USING btree (user_id);

CREATE INDEX idx_checkout_drafts_created_at ON public.checkout_drafts USING btree (created_at DESC);

CREATE INDEX idx_checkout_drafts_session_id ON public.checkout_drafts USING btree (session_id);

CREATE INDEX idx_legal_archive_runs_latest ON public.legal_archive_runs USING btree (fiscal_year, run_kind, completed_at DESC)
  WHERE (status = 'completed'::text);

CREATE INDEX idx_order_items_order_id ON public.order_items USING btree (order_id);

CREATE INDEX idx_order_revisions_changed_at ON public.order_revisions USING btree (changed_at DESC, id DESC);

CREATE INDEX idx_order_revisions_order_changed_at ON public.order_revisions USING btree (order_id, changed_at DESC, id DESC);

CREATE INDEX idx_orders_created_at ON public.orders USING btree (created_at);

CREATE INDEX idx_orders_payment_intent_id ON public.orders USING btree (payment_intent_id);

CREATE INDEX idx_orders_payment_status_updated_at ON public.orders USING btree (payment_status_updated_at DESC);

CREATE INDEX idx_orders_session_id ON public.orders USING btree (session_id);

CREATE INDEX idx_orders_status ON public.orders USING btree (status);

CREATE INDEX idx_orders_user_id ON public.orders USING btree (user_id);

CREATE INDEX idx_password_reset_tokens_email_expires_at ON public.password_reset_tokens USING btree (email, expires_at DESC);

CREATE INDEX idx_password_reset_tokens_email_used ON public.password_reset_tokens USING btree (email, used);

CREATE UNIQUE INDEX idx_password_reset_tokens_token_hash ON public.password_reset_tokens USING btree (token_hash);

CREATE INDEX idx_postal_code_cache_updated_at ON public.postal_code_cache USING btree (updated_at DESC);

CREATE INDEX idx_profiles_updated_at ON public.profiles USING btree (updated_at);

CREATE INDEX idx_profiles_user_id ON public.profiles USING btree (user_id);

CREATE INDEX idx_rate_limit_bucket ON public.rate_limit_counters USING btree (bucket);

CREATE INDEX idx_rate_limit_ip_endpoint_bucket ON public.rate_limit_counters USING btree (ip, endpoint, bucket);

CREATE INDEX idx_refresh_token_history_user_id ON public.refresh_token_history USING btree (user_id, recorded_at DESC);

CREATE INDEX idx_role_permissions_permission_id ON public.role_permissions USING btree (permission_id);

CREATE INDEX idx_role_permissions_role_id ON public.role_permissions USING btree (role_id);

CREATE INDEX idx_sessions_csrf_prev_token_hash ON public.sessions USING btree (csrf_prev_token_hash);

CREATE INDEX idx_sessions_expires_at ON public.sessions USING btree (expires_at);

CREATE INDEX idx_sessions_last_seen_at ON public.sessions USING btree (last_seen_at);

CREATE INDEX idx_sessions_user_id ON public.sessions USING btree (user_id);

CREATE INDEX idx_stockists_status ON public.stockists USING btree (status);

CREATE INDEX idx_stripe_balance_transactions_order_created ON public.stripe_balance_transactions USING btree (order_id, stripe_created_at);

CREATE INDEX idx_stripe_balance_transactions_payment_intent ON public.stripe_balance_transactions USING btree (payment_intent_id);

CREATE INDEX idx_stripe_balance_transactions_payout ON public.stripe_balance_transactions USING btree (payout_id);

CREATE INDEX idx_stripe_payouts_unconfirmed ON public.stripe_payouts USING btree (stripe_created_at)
  WHERE ((status = 'paid'::text) AND (bank_confirmed_at IS NULL));

CREATE INDEX idx_stripe_refunds_order_succeeded ON public.stripe_refunds USING btree (order_id, succeeded_at)
  WHERE (status = 'succeeded'::text);

CREATE INDEX idx_stripe_webhook_events_processing_status ON public.stripe_webhook_events USING btree (processing_status, processed_at DESC);

CREATE INDEX idx_user_roles_role_id ON public.user_roles USING btree (role_id);

CREATE INDEX idx_user_roles_user_id_active ON public.user_roles USING btree (user_id, active);

CREATE INDEX idx_wishlist_added_at ON public.wishlist USING btree (added_at);

CREATE INDEX idx_wishlist_item_id ON public.wishlist USING btree (item_id);

CREATE INDEX idx_wishlist_session_id ON public.wishlist USING btree (session_id);

CREATE UNIQUE INDEX idx_wishlist_unique_per_user_session_item ON public.wishlist
  USING btree (COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(session_id, ''::text), item_id);

CREATE INDEX idx_wishlist_user_id ON public.wishlist USING btree (user_id);

CREATE INDEX items_category_idx ON public.items USING btree (category);

CREATE INDEX items_created_at_idx ON public.items USING btree (created_at DESC);

CREATE INDEX items_status_idx ON public.items USING btree (status);

CREATE INDEX look_items_item_id_idx ON public.look_items USING btree (item_id);

CREATE INDEX looks_created_at_idx ON public.looks USING btree (created_at DESC);

CREATE INDEX looks_status_idx ON public.looks USING btree (status);

CREATE INDEX news_articles_category_idx ON public.news_articles USING btree (category);

CREATE INDEX news_articles_published_date_idx ON public.news_articles USING btree (published_date DESC);

CREATE INDEX news_articles_status_idx ON public.news_articles USING btree (status);

CREATE INDEX sessions_previous_refresh_token_hash_idx ON public.sessions USING btree (previous_refresh_token_hash);

CREATE INDEX idx_alert_events_by_actor ON security.alert_events USING btree (actor_id);

CREATE INDEX idx_alert_events_by_ip ON security.alert_events USING btree (ip_address);

CREATE INDEX idx_alert_events_created_at ON security.alert_events USING btree (created_at);

CREATE TRIGGER tr_create_profile_on_auth_user_insert
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.create_profile_for_new_auth_user();

CREATE TRIGGER trigger_admin_costing_items_updated_at
  BEFORE UPDATE ON public.admin_costing_items
  FOR EACH ROW
  EXECUTE FUNCTION public.update_admin_finance_updated_at();

CREATE TRIGGER trigger_prevent_allocated_item_season_change
  BEFORE UPDATE OF season_key ON public.admin_costing_items
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_allocated_item_season_change();

CREATE TRIGGER trigger_admin_expense_cost_allocations_updated_at
  BEFORE UPDATE ON public.admin_expense_cost_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_admin_finance_updated_at();

CREATE TRIGGER trigger_validate_admin_expense_cost_allocation
  BEFORE INSERT OR UPDATE ON public.admin_expense_cost_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_admin_expense_cost_allocation();

CREATE TRIGGER trigger_admin_finance_expense_templates_updated_at
  BEFORE UPDATE ON public.admin_finance_expense_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.update_admin_finance_updated_at();

CREATE TRIGGER trigger_admin_finance_entry_revisions
  AFTER INSERT OR DELETE OR UPDATE ON public.admin_finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.record_admin_finance_entry_revision();

CREATE TRIGGER trigger_admin_finance_expenses_updated_at
  BEFORE UPDATE ON public.admin_finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.update_admin_finance_updated_at();

CREATE TRIGGER trigger_prevent_allocated_expense_integrity_change
  BEFORE UPDATE ON public.admin_finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_allocated_expense_integrity_change();

CREATE TRIGGER trigger_admin_finance_fixed_assets_updated_at
  BEFORE UPDATE ON public.admin_finance_fixed_assets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_admin_finance_updated_at();

CREATE TRIGGER trigger_admin_finance_partners_updated_at
  BEFORE UPDATE ON public.admin_finance_partners
  FOR EACH ROW
  EXECUTE FUNCTION public.update_admin_finance_updated_at();

CREATE TRIGGER trigger_admin_finance_seasons_updated_at
  BEFORE UPDATE ON public.admin_finance_seasons
  FOR EACH ROW
  EXECUTE FUNCTION public.update_admin_finance_updated_at();

CREATE TRIGGER trigger_admin_finance_year_closings_updated_at
  BEFORE UPDATE ON public.admin_finance_year_closings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_admin_finance_updated_at();

CREATE TRIGGER trigger_admin_finance_years_updated_at
  BEFORE UPDATE ON public.admin_finance_years
  FOR EACH ROW
  EXECUTE FUNCTION public.update_admin_finance_updated_at();

CREATE TRIGGER trigger_admin_kpi_targets_updated_at
  BEFORE UPDATE ON public.admin_kpi_targets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_admin_kpi_targets_updated_at();

CREATE TRIGGER trg_items_updated_at
  BEFORE UPDATE ON public.items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_items_updated_at();

CREATE TRIGGER trg_looks_updated_at
  BEFORE UPDATE ON public.looks
  FOR EACH ROW
  EXECUTE FUNCTION public.set_looks_updated_at();

CREATE TRIGGER trg_news_articles_updated_at
  BEFORE UPDATE ON public.news_articles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_news_articles_updated_at();

CREATE TRIGGER protect_legal_order_item_delete
  BEFORE DELETE ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION private.protect_legal_order_item_delete();

CREATE TRIGGER protect_legal_order_item_immutable_fields
  BEFORE UPDATE ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION private.protect_legal_order_item_immutable_fields();

CREATE TRIGGER protect_legal_order_delete
  BEFORE DELETE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION private.protect_legal_order_delete();

CREATE TRIGGER protect_legal_order_immutable_fields
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION private.protect_legal_order_immutable_fields();

CREATE TRIGGER record_order_revision
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION private.record_order_revision();

CREATE TRIGGER trigger_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_orders_updated_at();

CREATE TRIGGER trigger_stockists_updated_at
  BEFORE UPDATE ON public.stockists
  FOR EACH ROW
  EXECUTE FUNCTION public.update_stockists_updated_at();

CREATE POLICY "admin costing items read" ON "public"."admin_costing_items"
  FOR SELECT
  TO "authenticated"
  USING (( SELECT public.has_permission('admin.finance.read'::text) AS has_permission));

CREATE POLICY "admin expense cost allocations read" ON "public"."admin_expense_cost_allocations"
  FOR SELECT
  TO "authenticated"
  USING (( SELECT public.has_permission('admin.finance.read'::text) AS has_permission));

CREATE POLICY "admin finance entry review acks manage" ON "public"."admin_finance_entry_review_acks"
  FOR ALL
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text))
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance entry review acks read" ON "public"."admin_finance_entry_review_acks"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.finance.read'::text));

CREATE POLICY "admin finance entry revisions read" ON "public"."admin_finance_entry_revisions"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.finance.read'::text));

CREATE POLICY "admin finance evidence unavailable manage" ON "public"."admin_finance_evidence_unavailable_records"
  FOR ALL
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text))
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance evidence unavailable read" ON "public"."admin_finance_evidence_unavailable_records"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.finance.read'::text));

CREATE POLICY "admin finance expense templates manage delete" ON "public"."admin_finance_expense_templates"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance expense templates manage insert" ON "public"."admin_finance_expense_templates"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance expense templates manage update" ON "public"."admin_finance_expense_templates"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text))
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance expense templates read" ON "public"."admin_finance_expense_templates"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.finance.read'::text));

CREATE POLICY "admin finance expenses manage delete" ON "public"."admin_finance_expenses"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance expenses manage insert" ON "public"."admin_finance_expenses"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance expenses manage update" ON "public"."admin_finance_expenses"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text))
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance expenses read" ON "public"."admin_finance_expenses"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.finance.read'::text));

CREATE POLICY "admin finance fixed assets manage delete" ON "public"."admin_finance_fixed_assets"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance fixed assets manage insert" ON "public"."admin_finance_fixed_assets"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance fixed assets manage update" ON "public"."admin_finance_fixed_assets"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text))
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance fixed assets read" ON "public"."admin_finance_fixed_assets"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.finance.read'::text));

CREATE POLICY "admin finance partners manage delete" ON "public"."admin_finance_partners"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance partners manage insert" ON "public"."admin_finance_partners"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance partners manage update" ON "public"."admin_finance_partners"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text))
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance partners read" ON "public"."admin_finance_partners"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.finance.read'::text));

CREATE POLICY "admin finance receipts manage delete" ON "public"."admin_finance_receipts"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance receipts manage insert" ON "public"."admin_finance_receipts"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance receipts manage update" ON "public"."admin_finance_receipts"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text))
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance receipts read" ON "public"."admin_finance_receipts"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.finance.read'::text));

CREATE POLICY "admin finance seasons manage delete" ON "public"."admin_finance_seasons"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance seasons manage insert" ON "public"."admin_finance_seasons"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance seasons manage update" ON "public"."admin_finance_seasons"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text))
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance seasons read" ON "public"."admin_finance_seasons"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.finance.read'::text));

CREATE POLICY "admin finance summary options manage" ON "public"."admin_finance_summary_options"
  FOR ALL
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text))
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance summary options read" ON "public"."admin_finance_summary_options"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.finance.read'::text));

CREATE POLICY "admin finance year closings manage delete" ON "public"."admin_finance_year_closings"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance year closings manage insert" ON "public"."admin_finance_year_closings"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance year closings manage update" ON "public"."admin_finance_year_closings"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text))
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance year closings read" ON "public"."admin_finance_year_closings"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.finance.read'::text));

CREATE POLICY "admin finance years manage delete" ON "public"."admin_finance_years"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance years manage insert" ON "public"."admin_finance_years"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance years manage update" ON "public"."admin_finance_years"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.finance.manage'::text))
  WITH CHECK (public.has_permission('admin.finance.manage'::text));

CREATE POLICY "admin finance years read" ON "public"."admin_finance_years"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.finance.read'::text));

CREATE POLICY "Allow all" ON "public"."admin_kpi_actuals"
  FOR ALL
  TO PUBLIC
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow all" ON "public"."admin_kpi_documents"
  FOR ALL
  TO PUBLIC
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow all" ON "public"."admin_kpi_target_history"
  FOR ALL
  TO PUBLIC
  USING (true)
  WITH CHECK (true);

CREATE POLICY "deny direct client access" ON "public"."admin_kpi_targets"
  AS RESTRICTIVE
  FOR ALL
  TO "anon", "authenticated"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "audit_logs_deny_anon_all" ON "public"."audit_logs"
  FOR ALL
  TO "anon"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "audit_logs_deny_authenticated_all" ON "public"."audit_logs"
  FOR ALL
  TO "authenticated"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "audit_logs_service_role_all" ON "public"."audit_logs"
  FOR ALL
  TO "service_role"
  USING (true)
  WITH CHECK (true);

CREATE POLICY "deny direct client access" ON "public"."audit_logs_backups"
  AS RESTRICTIVE
  FOR ALL
  TO "anon", "authenticated"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Users can delete their own cart items" ON "public"."carts"
  FOR DELETE
  TO PUBLIC
  USING (((auth.uid() = user_id) OR ((user_id IS NULL) AND (session_id = current_setting('app.session_id'::text, true)))));

CREATE POLICY "Users can insert their own cart items" ON "public"."carts"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((auth.uid() = user_id) OR ((user_id IS NULL) AND (session_id = current_setting('app.session_id'::text, true)))));

CREATE POLICY "Users can update their own cart items" ON "public"."carts"
  FOR UPDATE
  TO PUBLIC
  USING (((auth.uid() = user_id) OR ((user_id IS NULL) AND (session_id = current_setting('app.session_id'::text, true)))))
  WITH CHECK (((auth.uid() = user_id) OR ((user_id IS NULL) AND (session_id = current_setting('app.session_id'::text, true)))));

CREATE POLICY "Users can view their own cart" ON "public"."carts"
  FOR SELECT
  TO PUBLIC
  USING (((auth.uid() = user_id) OR ((user_id IS NULL) AND (session_id = current_setting('app.session_id'::text, true)))));

CREATE POLICY "deny direct client access" ON "public"."checkout_drafts"
  AS RESTRICTIVE
  FOR ALL
  TO "anon", "authenticated"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny direct delete on contact_inquiries" ON "public"."contact_inquiries"
  FOR DELETE
  TO PUBLIC
  USING (false);

CREATE POLICY "Deny direct insert on contact_inquiries" ON "public"."contact_inquiries"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (false);

CREATE POLICY "Deny direct select on contact_inquiries" ON "public"."contact_inquiries"
  FOR SELECT
  TO PUBLIC
  USING (false);

CREATE POLICY "Deny direct update on contact_inquiries" ON "public"."contact_inquiries"
  FOR UPDATE
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny direct delete on contact_messages" ON "public"."contact_messages"
  FOR DELETE
  TO PUBLIC
  USING (false);

CREATE POLICY "Deny direct insert on contact_messages" ON "public"."contact_messages"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (false);

CREATE POLICY "Deny direct select on contact_messages" ON "public"."contact_messages"
  FOR SELECT
  TO PUBLIC
  USING (false);

CREATE POLICY "Deny direct update on contact_messages" ON "public"."contact_messages"
  FOR UPDATE
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny direct delete on contact_reply_templates" ON "public"."contact_reply_templates"
  FOR DELETE
  TO PUBLIC
  USING (false);

CREATE POLICY "Deny direct insert on contact_reply_templates" ON "public"."contact_reply_templates"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (false);

CREATE POLICY "Deny direct select on contact_reply_templates" ON "public"."contact_reply_templates"
  FOR SELECT
  TO PUBLIC
  USING (false);

CREATE POLICY "Deny direct update on contact_reply_templates" ON "public"."contact_reply_templates"
  FOR UPDATE
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Service role has full access to item color presets" ON "public"."item_color_presets"
  FOR ALL
  TO "service_role"
  USING (true)
  WITH CHECK (true);

CREATE POLICY "admin item_color_presets manage by permission delete" ON "public"."item_color_presets"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.items.manage'::text));

CREATE POLICY "admin item_color_presets manage by permission insert" ON "public"."item_color_presets"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.items.manage'::text));

CREATE POLICY "admin item_color_presets manage by permission update" ON "public"."item_color_presets"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.items.manage'::text))
  WITH CHECK (public.has_permission('admin.items.manage'::text));

CREATE POLICY "admin item_color_presets read by permission" ON "public"."item_color_presets"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.items.read'::text));

CREATE POLICY "Allow all" ON "public"."item_cost_history"
  FOR ALL
  TO PUBLIC
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anyone can view published items" ON "public"."items"
  FOR SELECT
  TO "anon"
  USING ((status = 'published'::text));

CREATE POLICY "Service role has full access to items" ON "public"."items"
  FOR ALL
  TO "service_role"
  USING (true)
  WITH CHECK (true);

CREATE POLICY "admin items manage by permission delete" ON "public"."items"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.items.manage'::text));

CREATE POLICY "admin items manage by permission insert" ON "public"."items"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.items.manage'::text));

CREATE POLICY "admin items manage by permission update" ON "public"."items"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.items.manage'::text))
  WITH CHECK (public.has_permission('admin.items.manage'::text));

CREATE POLICY "authenticated items read" ON "public"."items"
  FOR SELECT
  TO "authenticated"
  USING (((status = 'published'::text) OR public.has_permission('admin.items.read'::text)));

CREATE POLICY "legal archive runs read by finance permission" ON "public"."legal_archive_runs"
  FOR SELECT
  TO "authenticated"
  USING (( SELECT public.has_permission('admin.finance.read'::text) AS has_permission));

CREATE POLICY "Anyone can view look items for published looks" ON "public"."look_items"
  FOR SELECT
  TO "anon"
  USING ((EXISTS ( SELECT 1
   FROM public.looks
  WHERE ((looks.id = look_items.look_id) AND (looks.status = 'published'::text)))));

CREATE POLICY "Service role has full access to look items" ON "public"."look_items"
  FOR ALL
  TO "service_role"
  USING (true)
  WITH CHECK (true);

CREATE POLICY "admin look_items manage by permission delete" ON "public"."look_items"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.looks.manage'::text));

CREATE POLICY "admin look_items manage by permission insert" ON "public"."look_items"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.looks.manage'::text));

CREATE POLICY "admin look_items manage by permission update" ON "public"."look_items"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.looks.manage'::text))
  WITH CHECK (public.has_permission('admin.looks.manage'::text));

CREATE POLICY "authenticated look items read" ON "public"."look_items"
  FOR SELECT
  TO "authenticated"
  USING ((public.has_permission('admin.looks.read'::text) OR (EXISTS ( SELECT 1
   FROM public.looks
  WHERE ((looks.id = look_items.look_id) AND (looks.status = 'published'::text))))));

CREATE POLICY "Anyone can view published looks" ON "public"."looks"
  FOR SELECT
  TO "anon"
  USING ((status = 'published'::text));

CREATE POLICY "Service role has full access to looks" ON "public"."looks"
  FOR ALL
  TO "service_role"
  USING (true)
  WITH CHECK (true);

CREATE POLICY "admin looks manage by permission delete" ON "public"."looks"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.looks.manage'::text));

CREATE POLICY "admin looks manage by permission insert" ON "public"."looks"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.looks.manage'::text));

CREATE POLICY "admin looks manage by permission update" ON "public"."looks"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.looks.manage'::text))
  WITH CHECK (public.has_permission('admin.looks.manage'::text));

CREATE POLICY "authenticated looks read" ON "public"."looks"
  FOR SELECT
  TO "authenticated"
  USING (((status = 'published'::text) OR public.has_permission('admin.looks.read'::text)));

CREATE POLICY "Anyone can view published news articles" ON "public"."news_articles"
  FOR SELECT
  TO "anon"
  USING ((status = 'published'::text));

CREATE POLICY "Service role has full access to news articles" ON "public"."news_articles"
  FOR ALL
  TO "service_role"
  USING (true)
  WITH CHECK (true);

CREATE POLICY "admin news manage by permission delete" ON "public"."news_articles"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.news.manage'::text));

CREATE POLICY "admin news manage by permission insert" ON "public"."news_articles"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.news.manage'::text));

CREATE POLICY "admin news manage by permission update" ON "public"."news_articles"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.news.manage'::text))
  WITH CHECK (public.has_permission('admin.news.manage'::text));

CREATE POLICY "authenticated news read" ON "public"."news_articles"
  FOR SELECT
  TO "authenticated"
  USING (((status = 'published'::text) OR public.has_permission('admin.news.read'::text)));

CREATE POLICY "Users can view their own order items" ON "public"."order_items"
  FOR SELECT
  TO "anon"
  USING ((EXISTS ( SELECT 1
   FROM public.orders own_order
  WHERE ((own_order.id = order_items.order_id) AND (own_order.session_id = current_setting('app.session_id'::text, true))))));

CREATE POLICY "admin order items manage by permission delete" ON "public"."order_items"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.orders.manage'::text));

CREATE POLICY "admin order items manage by permission insert" ON "public"."order_items"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.orders.manage'::text));

CREATE POLICY "admin order items manage by permission update" ON "public"."order_items"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.orders.manage'::text))
  WITH CHECK (public.has_permission('admin.orders.manage'::text));

CREATE POLICY "authenticated order items read" ON "public"."order_items"
  FOR SELECT
  TO "authenticated"
  USING ((public.has_permission('admin.orders.read'::text) OR (EXISTS ( SELECT 1
   FROM public.orders own_order
  WHERE
    ((own_order.id = order_items.order_id) AND ((own_order.user_id = ( SELECT auth.uid() AS uid)) OR (own_order.session_id = current_setting('app.session_id'::text, true))))))));

CREATE POLICY "order revisions read by finance permission" ON "public"."order_revisions"
  FOR SELECT
  TO "authenticated"
  USING (( SELECT public.has_permission('admin.finance.read'::text) AS has_permission));

CREATE POLICY "Users can view their own orders" ON "public"."orders"
  FOR SELECT
  TO "anon"
  USING ((session_id = current_setting('app.session_id'::text, true)));

CREATE POLICY "admin orders manage by permission delete" ON "public"."orders"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.orders.manage'::text));

CREATE POLICY "admin orders manage by permission insert" ON "public"."orders"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.orders.manage'::text));

CREATE POLICY "admin orders manage by permission update" ON "public"."orders"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.orders.manage'::text))
  WITH CHECK (public.has_permission('admin.orders.manage'::text));

CREATE POLICY "authenticated orders read" ON "public"."orders"
  FOR SELECT
  TO "authenticated"
  USING ((public.has_permission('admin.orders.read'::text) OR (( SELECT auth.uid() AS uid) = user_id) OR (session_id = current_setting('app.session_id'::text, true))));

CREATE POLICY "password_reset_tokens_deny_anon_all" ON "public"."password_reset_tokens"
  FOR ALL
  TO "anon"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "password_reset_tokens_deny_authenticated_all" ON "public"."password_reset_tokens"
  FOR ALL
  TO "authenticated"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "password_reset_tokens_service_role_all" ON "public"."password_reset_tokens"
  FOR ALL
  TO "service_role"
  USING (true)
  WITH CHECK (true);

CREATE POLICY "acl permissions readable" ON "public"."permissions"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.users.read'::text));

CREATE POLICY "deny direct client access" ON "public"."postal_code_cache"
  AS RESTRICTIVE
  FOR ALL
  TO "anon", "authenticated"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Users can delete own profile" ON "public"."profiles"
  FOR DELETE
  TO PUBLIC
  USING ((auth.uid() = user_id));

CREATE POLICY "Users can insert own profile" ON "public"."profiles"
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can update own profile" ON "public"."profiles"
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can view own profile" ON "public"."profiles"
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));

CREATE POLICY "rate_limit_counters_deny_anon_all" ON "public"."rate_limit_counters"
  FOR ALL
  TO "anon"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "rate_limit_counters_deny_authenticated_all" ON "public"."rate_limit_counters"
  FOR ALL
  TO "authenticated"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "rate_limit_counters_service_role_all" ON "public"."rate_limit_counters"
  FOR ALL
  TO "service_role"
  USING (true)
  WITH CHECK (true);

CREATE POLICY "deny direct client access" ON "public"."refresh_token_history"
  AS RESTRICTIVE
  FOR ALL
  TO "anon", "authenticated"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "acl role_permissions readable" ON "public"."role_permissions"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.users.read'::text));

CREATE POLICY "acl roles readable" ON "public"."roles"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.users.read'::text));

CREATE POLICY "sessions_deny_anon_all" ON "public"."sessions"
  FOR ALL
  TO "anon"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "sessions_deny_authenticated_all" ON "public"."sessions"
  FOR ALL
  TO "authenticated"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "sessions_service_role_all" ON "public"."sessions"
  FOR ALL
  TO "service_role"
  USING (true)
  WITH CHECK (true);

CREATE POLICY "admin stockists manage by permission delete" ON "public"."stockists"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.stockists.manage'::text));

CREATE POLICY "admin stockists manage by permission insert" ON "public"."stockists"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.stockists.manage'::text));

CREATE POLICY "admin stockists manage by permission update" ON "public"."stockists"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.stockists.manage'::text))
  WITH CHECK (public.has_permission('admin.stockists.manage'::text));

CREATE POLICY "authenticated stockists read" ON "public"."stockists"
  FOR SELECT
  TO "authenticated"
  USING (((status = 'published'::text) OR public.has_permission('admin.stockists.read'::text)));

CREATE POLICY "public stockists read published" ON "public"."stockists"
  FOR SELECT
  TO "anon"
  USING ((status = 'published'::text));

CREATE POLICY "deny direct client access" ON "public"."stripe_webhook_events"
  AS RESTRICTIVE
  FOR ALL
  TO "anon", "authenticated"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "acl user_roles managed delete" ON "public"."user_roles"
  FOR DELETE
  TO "authenticated"
  USING (public.has_permission('admin.users.manage'::text));

CREATE POLICY "acl user_roles managed insert" ON "public"."user_roles"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (public.has_permission('admin.users.manage'::text));

CREATE POLICY "acl user_roles managed update" ON "public"."user_roles"
  FOR UPDATE
  TO "authenticated"
  USING (public.has_permission('admin.users.manage'::text))
  WITH CHECK (public.has_permission('admin.users.manage'::text));

CREATE POLICY "acl user_roles readable" ON "public"."user_roles"
  FOR SELECT
  TO "authenticated"
  USING (public.has_permission('admin.users.read'::text));

CREATE POLICY "Users can delete from their wishlist" ON "public"."wishlist"
  FOR DELETE
  TO PUBLIC
  USING (((auth.uid() = user_id) OR ((user_id IS NULL) AND (session_id IS NOT NULL) AND (session_id = current_setting('app.session_id'::text, true)))));

CREATE POLICY "Users can insert items to their wishlist" ON "public"."wishlist"
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((auth.uid() = user_id) OR ((user_id IS NULL) AND (session_id IS NOT NULL) AND (session_id = current_setting('app.session_id'::text, true)))));

CREATE POLICY "Users can view their own wishlist" ON "public"."wishlist"
  FOR SELECT
  TO PUBLIC
  USING (((auth.uid() = user_id) OR ((user_id IS NULL) AND (session_id IS NOT NULL) AND (session_id = current_setting('app.session_id'::text, true)))));

COMMENT ON COLUMN "public"."admin_finance_expenses"."deleted_at" IS '論理削除日時。電子帳簿保存法の真実性の要件のため物理削除しない。';

COMMENT ON COLUMN "public"."admin_finance_expenses"."fixed_asset_exempt" IS '固定資産候補の確認を済ませ、費用として処理すると判断した取引。確認キューから外れる。';

COMMENT ON COLUMN "public"."admin_finance_expenses"."fixed_asset_exempt_reason" IS '固定資産候補を対象外と判断した理由。fixed_asset_exempt=true の場合は必須。';

COMMENT ON COLUMN "public"."admin_finance_expenses"."fixed_asset_reviewed_at" IS '固定資産候補の対象外判断日時。';

COMMENT ON COLUMN "public"."admin_finance_expenses"."fixed_asset_reviewed_by" IS '固定資産候補の対象外判断者。';

COMMENT ON COLUMN "public"."admin_finance_expenses"."season_key" IS 'コレクション別分析用の任意タグ。会計期間は fiscal_year（expense_date 由来）で決まる。';

COMMENT ON COLUMN "public"."admin_finance_fixed_assets"."entry_id" IS '取得の元になった購入取引。NULL は直接登録（期首残高の移行・過去資産・現物発見）。';

COMMENT ON COLUMN "public"."admin_finance_fixed_assets"."service_started_on" IS '事業供用日。NULL は取得日と同じ。減価償却の月割の起点。';

COMMENT ON COLUMN "public"."items"."stock_quantity" IS 'NULL = 在庫情報なし, 0 = SOLD OUT, 1-4 = 残りわずか (LOW STOCK), 5以上 = 在庫あり';

COMMENT ON COLUMN "public"."orders"."refunded_amount" IS 'Cumulative amount of succeeded Stripe refunds in the order currency';

COMMENT ON COLUMN "public"."orders"."shipped_at" IS '発送日時。NULL は未発送。発送の二重実行を防ぐ条件にも使う。';

COMMENT ON COLUMN "public"."orders"."shipping_carrier" IS '配送業者。追跡URLの形式は src/lib/orders/shipping-carriers.ts が持つ。';

COMMENT ON COLUMN "public"."sessions"."csrf_prev_token_hash" IS 'Previous csrf token hash (for rotation grace period)';

COMMENT ON COLUMN "public"."sessions"."csrf_token_hash" IS 'Current csrf token sha256 hash used for double-submit verification';

COMMENT ON COLUMN "public"."sessions"."previous_refresh_token_hash" IS 'Previous refresh token sha256 hash for rotation/replay detection';

COMMENT ON COLUMN "public"."sessions"."quarantined" IS 'If true, session is quarantined due to detected token replay or compromise';

COMMENT ON COLUMN "public"."stripe_webhook_events"."processing_status" IS 'Processing lifecycle; only completed events are skipped as duplicates';

COMMENT ON EXTENSION "hypopg" IS 'Hypothetical indexes for PostgreSQL';

COMMENT ON EXTENSION "index_advisor" IS 'Query index advisor';

COMMENT ON FUNCTION "public"."is_auth_session_active"(uuid) IS 'JWT の session_id が auth.sessions に生存しているかを返す。実質的な保証は「明示的な削除（ログアウト・強制失効）の検出」。time-box / 無操作タイムアウトに達したセッションは即座には消えず24時間かけて掃除されるため、not_after 条件はそこまで強い保証を与えない。';

COMMENT ON TABLE "public"."admin_finance_entry_review_acks" IS '取引の要確認理由を確認済みにした記録。全理由が確認済みになると状態が登録済みへ戻る。';

COMMENT ON TABLE "public"."admin_finance_seasons" IS '商品原価（コレクション）のシーズン登録簿。会計期間は admin_finance_years が持つ。';

COMMENT ON TABLE "public"."audit_logs" IS 'Audit logs for authentication and admin actions';

COMMENT ON TABLE "public"."contact_inquiries" IS 'Raw contact inquiry payload including message body and sender information';

COMMENT ON TABLE "public"."contact_messages" IS 'Individual messages of a contact inquiry thread (customer and admin, web and email channels)';

COMMENT ON TABLE "public"."contact_reply_templates" IS 'Admin-managed canned reply templates for contact inquiries';

COMMENT ON TABLE "public"."news_articles" IS 'News articles managed from admin UI';

COMMENT ON TABLE "public"."stripe_balance_transactions" IS 'Immutable Stripe balance transaction facts used to derive accounting journals';

COMMENT ON TABLE "public"."stripe_payouts" IS 'Stripe payout reconciliation and explicit bank-arrival confirmation';

COMMENT ON TABLE "public"."stripe_refunds" IS 'Stripe refund lifecycle; succeeded_at is the accounting reversal date';

REVOKE ALL ON FUNCTION "private"."protect_legal_order_delete"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."protect_legal_order_delete"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."protect_legal_order_immutable_fields"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."protect_legal_order_immutable_fields"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."protect_legal_order_item_delete"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."protect_legal_order_item_delete"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."protect_legal_order_item_immutable_fields"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."protect_legal_order_item_immutable_fields"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."record_order_revision"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."record_order_revision"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."set_request_context"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."set_request_context"() TO "anon", "authenticated", "authenticator", "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."add_guest_cart_item"(text, integer, integer, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."add_guest_cart_item"(text, integer, integer, text, text) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."add_guest_wishlist_item"(text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."add_guest_wishlist_item"(text, integer) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."cleanup_password_reset_tokens"(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."cleanup_password_reset_tokens"(integer) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."clear_admin_expense_cost_allocations"(bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."clear_admin_expense_cost_allocations"(bigint) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."create_profile_for_new_auth_user"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."create_profile_for_new_auth_user"() TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."current_app_role"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."delete_cart_item_secure"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."delete_cart_item_secure"(uuid, text) TO "anon", "authenticated", "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."delete_guest_cart_item"(text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."delete_guest_cart_item"(text, uuid) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."delete_guest_wishlist_item"(text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."delete_guest_wishlist_item"(text, uuid) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."finalize_order_from_checkout_draft"(uuid, text, text, public.order_status, integer, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."finalize_order_from_checkout_draft"(uuid, text, text, public.order_status, integer, text) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."find_auth_user_id_by_email"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."find_auth_user_id_by_email"(text) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."get_popular_items"(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."get_popular_items"(integer) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."has_permission"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."has_permission"(text) TO "anon", "authenticated", "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."increment_rate_limit_counter"(inet, text, timestamp WITH time zone) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."increment_rate_limit_counter"(inet, text, timestamp WITH time zone) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."increment_rate_limit_counter"(inet, text, timestamp WITH time zone, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."increment_rate_limit_counter"(inet, text, timestamp WITH time zone, integer) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."is_auth_session_active"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."is_auth_session_active"(uuid) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."list_guest_cart"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."list_guest_cart"(text) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."list_guest_wishlist"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."list_guest_wishlist"(text) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."prevent_allocated_expense_integrity_change"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."prevent_allocated_item_season_change"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."record_admin_finance_entry_revision"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."record_admin_finance_entry_revision"() TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."replace_admin_expense_cost_allocations"(bigint, jsonb, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."replace_admin_expense_cost_allocations"(bigint, jsonb, uuid) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."revoke_auth_session"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."revoke_auth_session"(uuid) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."revoke_auth_sessions_for_user"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."revoke_auth_sessions_for_user"(uuid) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."search_items"(text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."search_items"(text, integer) TO "anon", "authenticated", "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."search_looks"(text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."search_looks"(text, integer) TO "anon", "authenticated", "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."search_news"(text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."search_news"(text, integer) TO "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."search_public_items"(text, integer) TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."search_public_looks"(text, integer) TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."search_public_news"(text, integer) TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."set_items_updated_at"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."set_looks_updated_at"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."set_news_articles_updated_at"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."update_admin_finance_updated_at"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."update_admin_kpi_targets_updated_at"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."update_cart_item_quantity_secure"(uuid, text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."update_cart_item_quantity_secure"(uuid, text, integer) TO "anon", "authenticated", "postgres", "service_role";

REVOKE ALL ON FUNCTION "public"."update_guest_cart_item_quantity"(text, uuid, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."update_guest_cart_item_quantity"(text, uuid, integer) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."update_orders_updated_at"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."update_stockists_updated_at"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."validate_admin_expense_cost_allocation"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "security"."count_recent_events"(text, text, text, text, integer) TO "postgres";

GRANT USAGE ON SCHEMA "private" TO "anon", "authenticated", "authenticator";

GRANT CREATE, USAGE ON SCHEMA "private" TO "postgres";

GRANT USAGE ON SCHEMA "private" TO "service_role";

GRANT CREATE, USAGE ON SCHEMA "security" TO "postgres";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."admin_finance_entry_review_acks_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."admin_finance_entry_revisions_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."admin_finance_expense_templates_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."admin_finance_expenses_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."admin_finance_fixed_assets_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."admin_finance_partners_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."admin_finance_receipts_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."admin_finance_summary_options_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."admin_kpi_targets_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."order_revisions_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."permissions_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."rate_limit_counters_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."roles_id_seq" TO "anon", "authenticated", "postgres", "service_role";

GRANT SELECT, UPDATE, USAGE ON SEQUENCE "public"."stockists_id_seq" TO "anon", "authenticated", "postgres", "service_role";

REVOKE ALL ON TABLE "public"."admin_costing_items" FROM "authenticated";

GRANT SELECT ON TABLE "public"."admin_costing_items" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_costing_items" TO "postgres", "service_role";

REVOKE ALL ON TABLE "public"."admin_expense_cost_allocations" FROM "authenticated";

GRANT SELECT ON TABLE "public"."admin_expense_cost_allocations" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_expense_cost_allocations" TO "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
  ON TABLE "public"."admin_finance_entry_review_acks"
  TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
  ON TABLE "public"."admin_finance_entry_revisions"
  TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
  ON TABLE "public"."admin_finance_evidence_unavailable_records"
  TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
  ON TABLE "public"."admin_finance_expense_templates"
  TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_finance_expenses" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_finance_fixed_assets" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_finance_partners" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_finance_receipts" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_finance_seasons" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
  ON TABLE "public"."admin_finance_summary_options"
  TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_finance_year_closings" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_finance_years" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_kpi_actuals" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_kpi_documents" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_kpi_target_history" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."admin_kpi_targets" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."audit_logs" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."audit_logs_backups" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."carts" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."checkout_drafts" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."contact_inquiries" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."contact_messages" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."contact_reply_templates" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."item_color_presets" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."item_cost_history" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."items" TO "anon", "authenticated", "postgres", "service_role";

REVOKE ALL ON TABLE "public"."legal_archive_runs" FROM "authenticated";

GRANT SELECT ON TABLE "public"."legal_archive_runs" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."legal_archive_runs" TO "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."look_items" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."looks" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."news_articles" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."order_items" TO "anon", "authenticated", "postgres", "service_role";

REVOKE ALL ON TABLE "public"."order_revisions" FROM "authenticated";

GRANT SELECT ON TABLE "public"."order_revisions" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."order_revisions" TO "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."orders" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."password_reset_tokens" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."permissions" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."postal_code_cache" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."profiles" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."rate_limit_counters" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."refresh_token_history" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."role_permissions" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."roles" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."sessions" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."stockists" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."stripe_balance_transactions" TO "postgres";

REVOKE ALL ON TABLE "public"."stripe_balance_transactions" FROM "service_role";

GRANT INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE ON TABLE "public"."stripe_balance_transactions" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."stripe_payouts" TO "postgres";

REVOKE ALL ON TABLE "public"."stripe_payouts" FROM "service_role";

GRANT INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE ON TABLE "public"."stripe_payouts" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."stripe_refunds" TO "postgres";

REVOKE ALL ON TABLE "public"."stripe_refunds" FROM "service_role";

GRANT INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE ON TABLE "public"."stripe_refunds" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."stripe_webhook_events" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."user_roles" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."wishlist" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "security"."alert_events" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "security"."security_alerts" TO "postgres";

GRANT USAGE ON TYPE "public"."order_status" TO "postgres";

