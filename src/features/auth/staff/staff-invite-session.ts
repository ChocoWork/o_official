import 'server-only';

import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';

export type InviteSession = { access_token: string; refresh_token: string };
export type InviteSessionUser = { id: string; email?: string | null; app_metadata?: unknown };

/**
 * 招待された人（お客さんの扱いのまま、役割が無い状態）の GoTrue のセッションを作る。
 * 管理 API の `generateLink`（magiclink）の `hashed_token` を、サーバーですぐ `verifyOtp` に渡す（メールは送らない）。
 *
 * @impl IMPL-AUTH-370
 * @design DD-AUTH-078
 * @remarks メールは `getUserById` で引く。どの段で失敗しても例外にせず `null`（呼び手は招待を使用済みのまま 500 にする）。
 * 作ったセッションがあって後段が失敗した時の終わらせ方は、呼び手が `endAuthSession` で行う。
 */
export async function createInviteSession(
  userId: string,
): Promise<{ session: InviteSession; user: InviteSessionUser } | null> {
  try {
    const service = await createServiceRoleClient();
    const found = await service.auth.admin.getUserById(userId);
    const email = found.data?.user?.email;
    if (found.error || !email) return null;

    const link = await service.auth.admin.generateLink({ type: 'magiclink', email });
    const hashed = link.data?.properties?.hashed_token;
    if (link.error || typeof hashed !== 'string' || hashed === '') return null;

    const publicClient = await createPublicClient();
    const verified = await publicClient.auth.verifyOtp({ type: 'magiclink', token_hash: hashed });
    const session = verified.data?.session;
    const user = verified.data?.user;
    if (verified.error || !session?.access_token || !session.refresh_token || !user?.id) return null;
    return { session: session as InviteSession, user: user as InviteSessionUser };
  } catch {
    return null;
  }
}
