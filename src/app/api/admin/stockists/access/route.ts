/**
 * 取扱店の作成の頁が入口で呼ぶ、書き込みの権限の確かめの窓口（src/app/api/admin/stockists/access/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-STOCKIST-151
 * @design DD-STOCKIST-040
 * @remarks 作成の頁はフォームを出す前にこれを呼び、書けない人にフォームを見せない（SEC-STOCKIST-019、ADR-0269）。呼んだ利用者が admin.stockists.manage を持つ時だけ本文の無い 204 を返し、それ以外は認可の断り（401・403・503）を返す。表を読まず書かないので、一覧の窓口と同じ読みの枠で数える。順序は他の窓口と同じ「送り元の枠 → 認可 → 操作者の枠」で、操作者が分かる拒否は監査に残す（SEC-STOCKIST-020・021、ADR-0268）。全部の応答を withNoStore に通し、権限の結果をキャッシュさせない（SEC-STOCKIST-010）。
 */
import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { auditAuthzDenial } from '@/lib/auth/audit-authz-denial';
import { withNoStore } from '@/lib/http/no-store';
import { describeErrorForLog } from '@/lib/logging/safe-error';
import {
  enforceAdminStockistActorRateLimit,
  enforceAdminStockistIpRateLimit,
} from '@/features/stockist/services/admin-security';

async function checkAccess(request: Request) {
  try {
    const ipRateLimitResponse = await enforceAdminStockistIpRateLimit(request, 'read');
    if (ipRateLimitResponse) {
      return ipRateLimitResponse;
    }

    const authz = await authorizeAdminPermission('admin.stockists.manage', request);
    if (!authz.ok) {
      await auditAuthzDenial(authz, { request, action: 'admin.stockists.access', resource: 'stockists' });
      return authz.response;
    }

    const rateLimitResponse = await enforceAdminStockistActorRateLimit(request, authz.userId, 'read');
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error('GET /api/admin/stockists/access error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return withNoStore(await checkAccess(request));
}
