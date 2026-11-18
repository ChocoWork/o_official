/**
 * ログインの状態を答える窓口（src/app/api/auth/me/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-185
 * @design DD-AUTH-026
 * @remarks 画面の表示と API の認可が食い違わないよう、認可側と同じ根拠（失効の確認と MFA の判定）で答える。
 * 読み手が使わないメールの住所は、応答に載せて配る理由が無いので返さない（id・役割・MFA の状態だけ）。
 */

import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth/authenticate';
import { approvedCountHint, evaluateStaffEntry } from '@/lib/auth/staff-passkey';
import { checkStaffIdle, staffIdleDeps } from '@/lib/auth/staff-passkey-idle';
import { endAuthSessionById } from '@/lib/auth/passkey-auth-session-end';

type UserRole = 'admin' | 'supporter' | 'user';

const isUserRole = (role: unknown): role is UserRole => {
  return role === 'admin' || role === 'supporter' || role === 'user';
};

// no-store / no-referrer はこの経路の全応答に要る。分岐ごとに書くと、
// 増えた分岐だけ抜ける（実際に 503 を足したときに重複が生まれた）。
const buildResponse = (body: unknown, init?: ResponseInit) => {
  const response = NextResponse.json(body, { status: 200, ...init });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
};

// 「判定できなかった」の応答。画面は 503 を見ると今の状態を保つ（一時障害でログアウトに落とさない）。
const unavailableResponse = () =>
  buildResponse({ authenticated: false, reason: 'unavailable' }, { status: 503, headers: { 'Retry-After': '30' } });

export async function GET(request: Request) {
  try {
    // 失効済みセッションで authenticated:true を返すと、UI は管理メニューを描くのに
    // API は 401 を返すという食い違いが起きる。認可側と同じ根拠で答える。
    const verified = await authenticateRequest(request);

    if (!verified.ok) {
      // 「失効している」と「失効しているか確認できなかった」を分ける。
      // 後者で authenticated:false を返すと、DB の一時障害だけで全利用者の画面が
      // ログアウト状態に落ちる。503 にしてクライアント側に前の状態を維持させる。
      if (verified.reason === 'unavailable') {
        return unavailableResponse();
      }

      return buildResponse({ authenticated: false });
    }

    const { claims } = verified;
    const role = isUserRole(claims.app_metadata?.role) ? claims.app_metadata.role : 'user';

    // 店員の無操作1時間（SR-AUTH-028）。時刻を進めない確かめ（peek）なので、画面を開き直すだけでは無操作が延びない。
    // 失敗は今の unavailable と同じ形（503・Retry-After 30）で返す（画面は今の状態を保つ）。idle は更新の道も閉じる。
    if (role !== 'user') {
      const idle = claims.session_id ? await checkStaffIdle(staffIdleDeps, claims.session_id, claims.sub, 'peek') : 'error';
      if (idle === 'error') return unavailableResponse();
      if (idle === 'idle') {
        // 画面を /login へ送るだけでなく、更新の道も閉じる（admin-rbac の idle と同じ）
        await endAuthSessionById(claims.session_id as string);
        return buildResponse({ authenticated: false, reason: 'idle' });
      }
    }

    // 管理の入口の条件（パスキー・24時間以内・認めた2本以上）を、画面に出す「ヒント」として判定する（SR-AUTH-014）。
    // 認めた本数は DB で数えず JWT の印 staff_passkeys_ok から取る（真なら足りる数、偽なら0）ので、認めた鍵が消えた後は
    // 最長1時間（次の更新まで）枠が見える。権限の判定は admin-rbac が DB で数えて行うので、API は 403 になる。
    // 応答の項目名 mfaVerified は段4まで変えない（ADR-0463）。
    const mfaVerified = evaluateStaffEntry(claims, approvedCountHint(claims), Date.now() / 1000).ok;

    return buildResponse({
      authenticated: true,
      user: {
        id: claims.sub,
        role,
        mfaVerified,
      },
    });
  } catch (error) {
    console.error('Auth me handler error:', error);
    return buildResponse({ authenticated: false });
  }
}
