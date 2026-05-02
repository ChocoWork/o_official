# File: audit_rls.py
"""
全 public テーブルの RLS 有効状態とポリシー数を監査。
psycopg を使い、読み取り専用接続で実行する想定。
"""

import os
import sys
import psycopg

DSN = os.environ["SUPABASE_DB_URL"]  # postgres://... (read-only role 推奨)

QUERY = """
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  coalesce((
    select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname
  ), 0) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
"""


def main() -> int:
    issues = 0
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(QUERY)
        rows = cur.fetchall()
        print(f"{'TABLE':30} {'RLS':5} {'FORCE':6} {'POLICIES':8}")
        for name, enabled, forced, count in rows:
            flag = ""
            if not enabled:
                flag = "  ❌ RLS DISABLED"
                issues += 1
            elif count == 0:
                flag = "  ⚠️  NO POLICIES (deny-all)"
            print(f"{name:30} {str(enabled):5} {str(forced):6} {count:<8}{flag}")
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())