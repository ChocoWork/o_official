import fs from 'node:fs';
import path from 'node:path';

const ADDITIVE_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20260925000218_add_order_state_transition_rpcs.sql',
);
const HARDENING_PATH = path.join(
  process.cwd(),
  'supabase/pending/harden_order_state_transitions.sql',
);
const FULFILLMENT_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261010122320_fulfillment_order_emails.sql',
);

const REFUND_RESULTS_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261011120200_order_refund_results.sql',
);

describe('order state transition migrations', () => {
  it('defines narrow service-role-only RPCs with fixed search paths and CAS projection', () => {
    const sql = fs.readFileSync(ADDITIVE_PATH, 'utf8');

    for (const name of [
      'admin_cancel_failed_order',
      'admin_ship_paid_order',
      'apply_order_refund_projection',
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}`, 'i'));
      expect(sql).toMatch(new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${name}[\\s\\S]+FROM PUBLIC, anon, authenticated`,
        'i',
      ));
      expect(sql).toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${name}[\\s\\S]+TO service_role`,
        'i',
      ));
    }

    expect(sql.match(/SECURITY DEFINER/gi)).toHaveLength(5);
    expect(sql.match(/SET search_path = ''/gi)).toHaveLength(6);
    expect(sql).toContain("current_setting('app.order_actor_id', true)");
    expect(sql).toMatch(/o\.status = _expected_status[\s\S]+o\.refunded_amount = _expected_refunded_amount/i);
    expect(sql).toContain('o.payment_status_updated_at IS NOT DISTINCT FROM _expected_payment_status_updated_at');
    expect(sql).toMatch(/o\.status <> 'cancelled'[\s\S]+o\.refunded_amount >= o\.total_amount/i);
  });

  it('revokes direct updates and installs payment-state invariants', () => {
    const sql = fs.readFileSync(HARDENING_PATH, 'utf8');

    expect(sql).toMatch(/REVOKE UPDATE ON TABLE public\.orders FROM anon, authenticated/i);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "admin orders manage by permission update"/i);
    expect(sql).toMatch(/CREATE TRIGGER enforce_order_payment_invariants/i);
    expect(sql).toContain("OLD.status IN ('paid', 'shipped')");
    // 全額の判定は、受け取った額（空なら注文の合計）。支払額が合計と違う注文でも、返せる額の全部を返せば取消になる（グループ E-2 設計書 11-4）
    expect(sql).toContain('NEW.refunded_amount < COALESCE(NULLIF(NEW.paid_amount, 0), NEW.total_amount)');
    expect(sql).toContain('OLD.refunded_amount >= COALESCE(NULLIF(OLD.paid_amount, 0), OLD.total_amount)');
    expect(sql).toContain("OLD.status = 'cancelled'");
    expect(sql).toContain("NEW.status = 'cancelled'");
    expect(sql).toMatch(/REVOKE INSERT, DELETE, TRUNCATE ON TABLE public\.orders FROM anon, authenticated/i);
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\.order_items FROM anon, authenticated/i);
    expect(sql).toContain('ORDER_STATUS_CHANGE_REQUIRES_REASON');
    expect(sql).toContain('ORDER_STATUS_TRANSITION_NOT_ALLOWED');
    // 発送の取消で未発送の品が戻った注文だけ、発送済みから決済完了へ戻せる（グループ E-1 設計書 7-3・12-3）
    expect(sql).toContain("(OLD.status = 'shipped' AND NEW.status = 'paid'");
    expect(sql).toContain("pg_catalog.current_setting('app.order_change_reason', true) = 'admin_cancel_fulfillment'");
    // 返金の失敗で、発送前に返金した品が戻った注文も、発送済みから支払い済みへ戻せる（グループ E-2 設計書 4-7。入金済みから発送済みへは元から通る）
    expect(sql).toContain("pg_catalog.current_setting('app.order_change_reason', true) = 'refund_failed_reopened'");
  });

  it('replaces the ship RPC with service-role-only fulfillment RPCs that record the change reason', () => {
    const sql = fs.readFileSync(FULFILLMENT_PATH, 'utf8');

    for (const name of ['admin_create_fulfillment', 'admin_cancel_fulfillment']) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role`, 'i'));
      const body = sql.split(`CREATE OR REPLACE FUNCTION public.${name}(`)[1]?.split('$$;')[0];
      expect(body).toBeDefined();
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain("SET search_path = ''");
      expect(body).toContain(`'app.order_change_reason', '${name}'`);
    }
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.admin_ship_paid_order(uuid, uuid, text, text, boolean);');
  });

  it('replaces the refund projection RPC with service-role-only refund result RPCs that record the change reason', () => {
    const sql = fs.readFileSync(REFUND_RESULTS_PATH, 'utf8');

    for (const name of [
      'record_order_refund_result',
      'record_external_order_refund',
      'mark_order_refund_error',
      'list_order_refund_summaries',
      'resolve_payment_exception_by_system',
    ]) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\)\\s+TO service_role`, 'i'));
      const body = sql.split(`CREATE OR REPLACE FUNCTION public.${name}(`)[1]?.split('$$;')[0];
      expect(body).toBeDefined();
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain("SET search_path = ''");
    }

    // 注文の状態を変える所は、変更の理由を付けてから更新する（保留の守りが、その理由で遷移を通す）
    const stateBody = sql.split('CREATE OR REPLACE FUNCTION private.apply_order_refund_state(')[1]?.split('$$;')[0];
    expect(stateBody).toBeDefined();
    expect(stateBody).toContain("'app.order_change_reason'");
    for (const reason of ['refund_projection', 'refund_completed_order', 'refund_failed_reopened']) {
      expect(stateBody).toContain(`'${reason}'`);
    }
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.apply_order_refund_projection(');
    expect(sql).toContain('DROP FUNCTION IF EXISTS private.enqueue_order_email(uuid, text, text, uuid);');
  });
});
