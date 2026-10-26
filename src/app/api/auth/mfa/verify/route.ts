/**
 * 管理者・サポーターの TOTP コードを確かめて aal2 へ上げる窓口（src/app/api/auth/mfa/verify/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-205
 * @design DD-AUTH-031
 * @remarks 確認が通ると Supabase が aal2 のトークン対を返す。Cookie と sessions 行へ書き戻さないとブラウザは aal1 のままで、認可側の判定を通れない。書き戻しの保存に失敗しても、aal2 はトークン自体が持つので配る。
 * 6 桁のコードは総当たりされうるので、IP の枠に加えて利用者単位の枠（5 回 / 600 秒）を置く。枠の鍵は検証済みの claims.sub だけを使う（本文の値だと他人の枠を潰せる）。確かめの結果は成功も失敗も監査に残し、コードと Supabase の誤りの文は残さない。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { findSessionByRefreshHash, persistNewSession } from '@/features/auth/services/session';
import { refreshCookieName } from '@/lib/cookie';
import { logAudit } from '@/lib/audit';

type UserRole = 'admin' | 'supporter' | 'user';

const VerifyRequestSchema = z.object({
  factorId: z.string().uuid(),
  code: z.string().regex(/^\d{6,8}$/, '認証コードは6〜8桁の数字で入力してください。'),
});

const isUserRole = (role: unknown): role is UserRole => role === 'admin' || role === 'supporter' || role === 'user';

export async function POST(request: Request) {
  try {
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:mfa:verify', limit: 20, windowSeconds: 600 });
      if (rl) {
        return rl;
      }
    } catch (error) {
      console.error('[auth.mfa.verify] rate limit middleware error:', error);
    }

    const body = await request.json().catch(() => null);
    const parsed = VerifyRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues.map((issue) => issue.message).join(' ') }, { status: 400 });
    }

    const { factorId, code } = parsed.data;

    const supabase = await createClient(request);
    const auth = await authenticateRequest(request);

    if (!auth.ok) {
      return authFailureResponse(auth.reason);
    }

    // role は JWT のクレームから読む。最大 1 時間古くなりうるが、ここでの用途は
    // 「自分のアカウントに MFA を設定させるか」の判断だけで、管理機能へのアクセスは
    // admin-rbac が DB の ACL で別途判定する。降格直後の利用者が自分の端末で
    // MFA を設定できてしまっても権限は増えないため、ACL を引く必要はない。
    const user = { id: auth.claims.sub, app_metadata: auth.claims.app_metadata };

    // 利用者単位の総当たり対策。subject は検証済みの sub だけにする。
    // 本文の factorId などを使うと、他人の枠を故意に潰せる。役割の確認より前に置くのは、一般の会員にも数えさせるため。
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rlAccount = await enforceRateLimit({
        request,
        endpoint: 'auth:mfa:verify',
        limit: 5,
        windowSeconds: 600,
        subject: user.id,
      });
      if (rlAccount) {
        await logAudit({
          action: 'mfa_verify',
          actor_id: user.id,
          outcome: 'failure',
          detail: 'account_rate_limited',
        });
        return rlAccount;
      }
    } catch (error) {
      console.error('[auth.mfa.verify] account rate limit middleware error:', error);
    }

    const role = isUserRole(user.app_metadata?.role) ? user.app_metadata.role : 'user';
    if (role !== 'admin' && role !== 'supporter') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const challengeResult = await supabase.auth.mfa.challenge({ factorId });
    if (challengeResult.error || !challengeResult.data) {
      console.error('[auth.mfa.verify] failed to create challenge:', challengeResult.error);
      const message = challengeResult.error?.message?.toLowerCase() ?? '';
      if (message.includes('not found')) {
        await logAudit({ action: 'mfa_verify', actor_id: user.id, outcome: 'failure', detail: 'factor_not_found' });
        return NextResponse.json({ error: '対象のMFA要素が見つかりません。' }, { status: 404 });
      }
      await logAudit({ action: 'mfa_verify', actor_id: user.id, outcome: 'failure', detail: 'challenge_failed' });
      return NextResponse.json({ error: 'MFAチャレンジの作成に失敗しました。' }, { status: 400 });
    }

    const verifyResult = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challengeResult.data.id,
      code,
    });

    if (verifyResult.error) {
      console.error('[auth.mfa.verify] challenge verification failed:', verifyResult.error);
      await logAudit({ action: 'mfa_verify', actor_id: user.id, outcome: 'failure', detail: 'invalid_code' });
      return NextResponse.json({ error: '認証コードが正しくありません。' }, { status: 400 });
    }

    const aalResult = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalResult.error) {
      console.error('[auth.mfa.verify] failed to read AAL after verification:', aalResult.error);
    }

    const response = NextResponse.json(
      {
        data: {
          role,
          currentLevel: aalResult.data?.currentLevel ?? null,
          nextLevel: aalResult.data?.nextLevel ?? null,
          verified: true,
        },
      },
      { status: 200 },
    );

    // mfa.verify はセッションを aal2 に昇格した新しいトークン対を返す。
    // これを Cookie に書き戻さないとブラウザは aal1 のままで、認可側の aal2 判定を通れない。
    const previousRefreshToken = (await cookies()).get(refreshCookieName)?.value ?? null;
    const previousSession = previousRefreshToken
      ? await findSessionByRefreshHash(previousRefreshToken)
      : null;

    // DB 記録に失敗しても、発行済みトークンは必ず配る。aal2 はトークン自体が持っており、
    // 認可はトークンを見るので sessions 行が無くても正しく動く。逆にここで 500 を返すと、
    // 既に無効化された旧 refresh token だけがブラウザに残る。
    try {
      await persistNewSession(response, {
        accessToken: verifyResult.data.access_token,
        refreshToken: verifyResult.data.refresh_token,
        userId: user.id,
        previousSessionId: previousSession?.id ?? null,
        previousRefreshToken,
      });
      await logAudit({ action: 'mfa_verify', actor_id: user.id, outcome: 'success', detail: 'verified' });
    } catch (persistError) {
      console.error('[auth.mfa.verify] failed to persist elevated session:', persistError);
      await logAudit({
        action: 'mfa_verify',
        actor_id: user.id,
        outcome: 'error',
        detail: 'session_persist_failed',
      });
    }

    return response;
  } catch (error) {
    console.error('[auth.mfa.verify] unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
