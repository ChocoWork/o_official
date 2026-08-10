import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

/**
 * 注文時のメールが一致するゲスト注文を、この会員へ紐付ける。
 *
 * メール確認済みの会員だけを対象にする。未確認のまま紐付けると、
 * 他人のメールアドレスで登録するだけでその注文を奪えてしまう。
 *
 * 呼び出し元はログイン・メール確認のフローなので、失敗しても例外は投げない。
 * user_id IS NULL 条件により冪等なので、失敗しても次回ログインで復旧する。
 *
 * @returns 紐付いた件数。0 は正常（対象が無かった）。
 */
export async function linkGuestOrdersByEmail(params: {
  userId: string;
  email: string;
  emailConfirmedAt: string | null;
}): Promise<number> {
  if (!params.emailConfirmedAt) return 0;

  const normalizedEmail = params.email.trim().toLowerCase();
  if (!normalizedEmail) return 0;

  try {
    const supabase = await createServiceRoleClient();
    // user_id IS NULL が所有権の一方向性を担保する。
    // 既に誰かのものになった注文は決して移さない。
    // ilike はワイルドカードを含まなければ大文字小文字を無視した等値比較になる。
    // 注文時のメールは大文字が混ざりうるので eq では取りこぼす。
    const { data, error } = await supabase
      .from('orders')
      .update({ user_id: params.userId })
      .ilike('shipping_email', normalizedEmail)
      .is('user_id', null)
      .select('id');

    if (error) throw error;

    const linked = data?.length ?? 0;
    if (linked > 0) {
      await logAudit({
        action: 'orders.link_guest_orders',
        outcome: 'success',
        resource: 'orders',
        resource_id: params.userId,
        metadata: { linked_count: linked },
      });
    }
    return linked;
  } catch (error) {
    console.error('Failed to link guest orders to user:', error);
    await logAudit({
      action: 'orders.link_guest_orders',
      outcome: 'error',
      resource: 'orders',
      resource_id: params.userId,
      detail: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
