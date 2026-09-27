import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  buildShippingSnapshot,
  checkoutShippingSchema,
} from '@/features/checkout/services/checkout-draft.service';
import { logAudit } from '@/lib/audit';
import { cookieOptionsForCsrf, csrfCookieName } from '@/lib/cookie';

type CsrfDenyResponse = {
  status: number;
  _body: unknown;
  headers?: Headers | Record<string, string>;
};

type CsrfRotateResult = {
  rotatedCsrfToken: string;
};

function isCsrfDenyResponse(value: unknown): value is CsrfDenyResponse {
  return typeof value === 'object' && value !== null && 'status' in value && '_body' in value;
}

function hasRotatedCsrfToken(value: unknown): value is CsrfRotateResult {
  return typeof value === 'object' && value !== null && 'rotatedCsrfToken' in value;
}

function applyRotatedCsrfCookie(response: NextResponse, csrfResult: unknown) {
  if (!hasRotatedCsrfToken(csrfResult)) {
    return response;
  }

  response.cookies.set({
    name: csrfCookieName,
    value: csrfResult.rotatedCsrfToken,
    ...cookieOptionsForCsrf(0),
  });

  return response;
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const updateShippingSchema = z.object({
  checkoutSessionId: z.string().trim().min(1),
  shipping: checkoutShippingSchema,
  // クライアントが最後に見た配送先の版番号。これと一致するときだけ書き込む（FREQ-365）。
  // 配送先はデバウンス同期・確定直前の同期・create-session の再利用から書き換わるため、
  // 無条件に上書きすると、遅れて届いた古い内容が新しい内容を消す（lost update）。
  // 省略は「不正な入力」ではなく「条件付きでの再送が必要」なので、428 で区別して返す。
  expectedRevision: z.number().int().min(0).optional(),
});

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req);
  const userAgent = req.headers.get('user-agent');

  try {
    const sessionId = req.cookies.get('session_id')?.value;
    if (!sessionId) {
      return NextResponse.json({ error: 'Session not found' }, { status: 400 });
    }

    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rateLimitByIp = await enforceRateLimit({
      request: req,
      endpoint: 'checkout:update-shipping',
      limit: 60,
      windowSeconds: 60,
    });
    if (rateLimitByIp) {
      return rateLimitByIp;
    }

    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: 'checkout:update-shipping',
      limit: 30,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      return rateLimitBySession;
    }

    const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
    const csrfResult = await requireCsrfOrDeny();
    if (isCsrfDenyResponse(csrfResult)) {
      const denyResponse = NextResponse.json(csrfResult._body, { status: csrfResult.status });
      if (csrfResult.headers instanceof Headers) {
        csrfResult.headers.forEach((headerValue, headerName) => {
          denyResponse.headers.set(headerName, headerValue);
        });
      } else if (csrfResult.headers) {
        for (const [headerName, headerValue] of Object.entries(csrfResult.headers)) {
          denyResponse.headers.set(headerName, headerValue);
        }
      }

      return denyResponse;
    }

    const parsed = updateShippingSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { checkoutSessionId, shipping, expectedRevision } = parsed.data;

    // 版番号が無い要求は、いまサーバが持っている内容を知らないまま上書きすることになる。
    // これを許すと lost update が戻ってしまうので、条件付きでの再送を求める（RFC 6585 の 428）。
    // 起きるのは、この仕組みが入る前に開いたまま放置されたタブから送られたときなど。
    // 応答には「どうすれば再送できるか」（再読み込み）を入れる。
    if (expectedRevision === undefined) {
      await logAudit({
        action: 'checkout.shipping.update',
        outcome: 'failure',
        detail: 'Shipping update without expected revision',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, checkout_session_id: checkoutSessionId },
      });

      return NextResponse.json(
        {
          error: 'shipping_revision_required',
          message:
            '配送先の反映に失敗しました。ページを再読み込みしてから、もう一度お試しください。',
        },
        { status: 428 }
      );
    }

    const shippingSnapshot = buildShippingSnapshot(shipping);

    // 「読んでから書く」の2段構えにはせず、1文の条件付き更新で版番号を照合する。
    // 同時に走っても Postgres が条件を評価し直すため、勝つのは必ず片方だけになる。
    const { data: updated, error: updateError } = await supabase
      .from('checkout_drafts')
      .update({
        shipping_snapshot: shippingSnapshot,
        shipping_revision: expectedRevision + 1,
      })
      .eq('checkout_session_id', checkoutSessionId)
      .eq('session_id', sessionId)
      .eq('shipping_revision', expectedRevision)
      .neq('status', 'completed')
      .select('shipping_revision')
      .maybeSingle<{ shipping_revision: number }>();

    if (updateError) {
      console.error('Failed to update checkout draft shipping:', updateError);
      await logAudit({
        action: 'checkout.shipping.update',
        outcome: 'error',
        detail: 'Failed to update draft shipping snapshot',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, checkout_session_id: checkoutSessionId },
      });
      return NextResponse.json({ error: 'Failed to update shipping' }, { status: 500 });
    }

    if (!updated) {
      // 更新0件の理由は2つ。版が進んでいた（別タブや遅れて届いた書き込み）か、draft が無いか。
      const { data: currentDraft } = await supabase
        .from('checkout_drafts')
        .select('shipping_revision')
        .eq('checkout_session_id', checkoutSessionId)
        .eq('session_id', sessionId)
        .maybeSingle<{ shipping_revision: number }>();

      if (!currentDraft) {
        return NextResponse.json({ error: 'Checkout draft not found' }, { status: 404 });
      }

      // 画面は現在の版番号を取り込んで、入力中の配送先で書き直す。
      return applyRotatedCsrfCookie(
        NextResponse.json(
          {
            error: 'stale_shipping_revision',
            revision: Number(currentDraft.shipping_revision),
          },
          { status: 409 }
        ),
        csrfResult
      );
    }

    return applyRotatedCsrfCookie(
      NextResponse.json({ ok: true, revision: Number(updated.shipping_revision) }),
      csrfResult
    );
  } catch (error) {
    console.error('Update shipping error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
