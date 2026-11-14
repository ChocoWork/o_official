/**
 * 最初の店長を作るコマンドの、本物の deps（Supabase への書き込みを持つ）。
 *
 * @packageDocumentation
 * @remarks 判断は bootstrap-core が持つので、ここは Supabase の呼び出しだけを置く。Auth の誤りの文（メールを含みうる）は返さず status と code だけを渡す。監査は logAudit（ALERT_AUDIT_URL の通知も含む）をそのまま使う。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkPwnedPassword } from '@/lib/pwned-password';
import { logAudit } from '@/lib/audit';
import type { BootstrapDeps } from './bootstrap-core';

export function createBootstrapDeps(client: SupabaseClient): BootstrapDeps {
  async function adminRoleId(): Promise<string> {
    const { data, error } = await client.from('roles').select('id').eq('code', 'admin').single();
    if (error || !data) throw new Error('admin role not found');
    return data.id as string;
  }

  return {
    async countActiveAdmins() {
      const { count, error } = await client
        .from('user_roles')
        .select('user_id, roles!inner(code)', { count: 'exact', head: true })
        .eq('roles.code', 'admin')
        .eq('active', true)
        .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
      if (error) throw new Error('count active admins failed');
      return count ?? 0;
    },

    checkPwned: checkPwnedPassword,

    async createUser({ email, password, displayName }) {
      const { data, error } = await client.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { role: 'admin' },
        user_metadata: { display_name: displayName },
      });
      if (error || !data?.user) {
        const code = (error as { code?: string } | null)?.code;
        const message = error?.message ?? '';
        if (code === 'email_exists' || /already/i.test(message)) return { kind: 'exists' };
        return { kind: 'failed', status: (error as { status?: number } | null)?.status, code };
      }
      return { kind: 'created', id: data.user.id };
    },

    async grantAdminRole(userId) {
      const roleId = await adminRoleId();
      const { error: offError } = await client.from('user_roles').update({ active: false }).eq('user_id', userId);
      if (offError) throw new Error('deactivate roles failed');
      const { error: upsertError } = await client.from('user_roles').upsert(
        { user_id: userId, role_id: roleId, active: true, expires_at: null, assigned_by: null, assigned_at: new Date().toISOString() },
        { onConflict: 'user_id,role_id' },
      );
      if (upsertError) throw new Error('grant admin role failed');
    },

    async deleteUser(userId) {
      const { error } = await client.auth.admin.deleteUser(userId);
      if (error) throw new Error('delete user failed');
    },

    audit: logAudit,
  };
}
