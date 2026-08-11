import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

type LinkedOrderRow = {
  id: string;
  shipping_full_name: string | null;
  shipping_postal_code: string | null;
  shipping_prefecture: string | null;
  shipping_city: string | null;
  shipping_address: string | null;
  shipping_building: string | null;
  created_at: string;
};

/**
 * 紐付いた注文の配送先を profiles へ引き継ぐ。
 *
 * 既に住所や表示名を持つ会員には触れない。上書きすると、会員が自分で
 * 設定した内容を過去の注文で潰すことになる。
 * 失敗しても紐付け自体は成功として扱う（住所は後から入力できる）。
 */
async function copyGuestProfileFromOrder(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  userId: string,
  orders: LinkedOrderRow[],
): Promise<void> {
  // 最も新しい注文の配送先を使う。
  const latest = [...orders].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  if (!latest) return;

  try {
    const { data: profile, error: selectError } = await supabase
      .from('profiles')
      .select('addresses, address, display_name')
      .eq('user_id', userId)
      .maybeSingle<{
        addresses: unknown[] | null;
        address: unknown | null;
        display_name: string | null;
      }>();

    if (selectError) throw selectError;

    const hasAddress =
      (Array.isArray(profile?.addresses) && profile.addresses.length > 0) || Boolean(profile?.address);
    const hasDisplayName = Boolean(profile?.display_name);
    if (hasAddress && hasDisplayName) return;

    const payload: Record<string, unknown> = { user_id: userId };

    if (!hasAddress) {
      const addressItem = {
        id: latest.id,
        postalCode: latest.shipping_postal_code ?? '',
        prefecture: latest.shipping_prefecture ?? '',
        city: latest.shipping_city ?? '',
        address: latest.shipping_address ?? '',
        building: latest.shipping_building ?? '',
        isDefault: true,
      };
      payload.addresses = [addressItem];
      // legacy な単一 address 列もミラーする（既存の書き込み挙動に合わせる）。
      payload.address = addressItem;
    }

    if (!hasDisplayName && latest.shipping_full_name) {
      payload.display_name = latest.shipping_full_name;
    }

    if (Object.keys(payload).length === 1) return;

    const { error: upsertError } = await supabase
      .from('profiles')
      .upsert(payload, { onConflict: 'user_id' });

    if (upsertError) throw upsertError;
  } catch (error) {
    console.error('Failed to copy guest profile from order:', error);
    await logAudit({
      action: 'orders.copy_guest_profile',
      outcome: 'error',
      resource: 'profiles',
      resource_id: userId,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

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
    // 注文時のメールは大文字が混ざりうるので eq では取りこぼす。ilike で
    // 大文字小文字を無視するが、値に含まれる _ と % は ilike のワイルドカード
    // として解釈されるため必ずエスケープする。john_doe@example.com が
    // johnxdoe@example.com の注文にも一致してしまう。
    const escapedEmail = normalizedEmail
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    const { data, error } = await supabase
      .from('orders')
      .update({ user_id: params.userId })
      .ilike('shipping_email', escapedEmail)
      .is('user_id', null)
      .select('id, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_building, created_at');

    if (error) throw error;

    const linked = data?.length ?? 0;
    if (linked > 0) {
      await copyGuestProfileFromOrder(supabase, params.userId, data as LinkedOrderRow[]);
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
