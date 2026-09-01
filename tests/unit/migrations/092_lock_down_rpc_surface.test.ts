import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('092_lock_down_rpc_surface migration', () => {
  const sql = readFileSync(
    join(process.cwd(), 'migrations', '092_lock_down_rpc_surface.sql'),
    'utf8',
  );
  // コメント行に登場する語を数えないよう、-- 以降を落としたものも用意する
  const statements = sql.replace(/--.*$/gm, '');

  it('未使用の http 拡張を落とす（publishable key から SSRF が成立していた）', () => {
    expect(statements).toContain('DROP EXTENSION IF EXISTS http;');
  });

  it('service_role からしか呼ばれない関数の EXECUTE を剥がす', () => {
    // 実 DB のシグネチャそのまま。オーバーロードは個別に指定する必要がある。
    const signatures = [
      'increment_rate_limit_counter(inet, text, timestamptz)',
      'increment_rate_limit_counter(inet, text, timestamptz, integer)',
      'finalize_order_from_checkout_draft(uuid, text, text, public.order_status, integer, text)',
      'create_profile_for_new_auth_user()',
      'record_admin_finance_entry_revision()',
      'add_guest_cart_item(text, integer, integer, text, text)',
      'add_guest_wishlist_item(text, integer)',
      'delete_guest_cart_item(text, uuid)',
      'delete_guest_wishlist_item(text, uuid)',
      'list_guest_cart(text)',
      'list_guest_wishlist(text)',
      'update_guest_cart_item_quantity(text, uuid, integer)',
    ];

    for (const signature of signatures) {
      expect(statements).toContain(
        `REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`,
      );
      expect(statements).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
    }
  });
  // 剥がすと壊れる関数。has_permission は約85本の RLS ポリシーが依存しており、
  // ゲストのカート操作は anon ロールで実行される。
  it('RLS ポリシーとゲスト導線が依存する関数は REVOKE しない', () => {
    for (const fn of [
      'has_permission',
      'delete_cart_item_secure',
      'update_cart_item_quantity_secure',
    ]) {
      expect(statements).not.toContain(`REVOKE ALL ON FUNCTION public.${fn}`);
    }
  });

  it('access token に依存しないログアウト用の失効 RPC を追加する', () => {
    expect(statements).toContain('CREATE OR REPLACE FUNCTION public.revoke_auth_session(p_session_id uuid)');
    expect(statements).toContain('DELETE FROM auth.sessions WHERE id = p_session_id;');
    expect(statements).toContain('REVOKE ALL ON FUNCTION public.revoke_auth_session(uuid) FROM PUBLIC, anon, authenticated;');
    expect(statements).toContain('GRANT EXECUTE ON FUNCTION public.revoke_auth_session(uuid) TO service_role;');
  });

  it('SECURITY DEFINER 関数には search_path を固定する', () => {
    const definer = statements.match(/SECURITY DEFINER/g)?.length ?? 0;
    const searchPath = statements.match(/SET search_path = ''/g)?.length ?? 0;
    expect(definer).toBeGreaterThan(0);
    expect(searchPath).toBe(definer);
  });

  it('認可根拠から外れた MFA メタデータを掃除する', () => {
    expect(statements).toContain('UPDATE auth.users');
    expect(statements).toContain("raw_app_meta_data - 'admin_mfa_verified' - 'mfa_verified'");
    // jsonb の ? 演算子はドライバがプレースホルダと誤読しうるので使わない
    expect(statements).toContain("jsonb_exists(raw_app_meta_data, 'admin_mfa_verified')");
  });
});
