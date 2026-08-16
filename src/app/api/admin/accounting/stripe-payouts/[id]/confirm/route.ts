import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';

const requestSchema = z.object({
  bankArrivalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type PayoutRow = {
  id: string;
  amount: number;
  status: string;
  reconciliation_status: string;
  bank_arrival_date: string | null;
  bank_confirmed_at: string | null;
  bank_confirmed_by: string | null;
};

function confirmedResponse(row: PayoutRow) {
  return NextResponse.json({
    data: {
      payoutId: row.id,
      bankArrivalDate: row.bank_arrival_date,
      bankConfirmedAt: row.bank_confirmed_at,
      bankConfirmedBy: row.bank_confirmed_by,
    },
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const authz = await authorizeAdminPermission('admin.finance.manage', request);
  if (!authz.ok) return authz.response;

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) return csrfResult;

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: '着金日が正しくありません。' }, { status: 400 });
  }
  const { id: payoutId } = await context.params;
  const bankArrivalDate = parsed.data.bankArrivalDate;

  try {
    const supabase = await createServiceRoleClient();
    const { data: payout, error } = await supabase
      .from('stripe_payouts')
      .select('id, amount, status, reconciliation_status, bank_arrival_date, bank_confirmed_at, bank_confirmed_by')
      .eq('id', payoutId)
      .maybeSingle();
    if (error) throw error;
    if (!payout) {
      return NextResponse.json({ error: 'Payoutが見つかりません。' }, { status: 404 });
    }

    const current = payout as PayoutRow;
    if (current.bank_confirmed_at) {
      // 確認済みは書き換えず、同じ着金日の再送だけ成功として返す。
      return current.bank_arrival_date === bankArrivalDate
        ? confirmedResponse(current)
        : NextResponse.json({ error: '既に別の着金日で確認済みです。' }, { status: 409 });
    }
    if (current.status !== 'paid') {
      return NextResponse.json({ error: 'Payoutが送金済みではありません。' }, { status: 409 });
    }
    if (current.reconciliation_status !== 'matched') {
      return NextResponse.json({ error: 'Payoutの照合が完了していません。' }, { status: 409 });
    }

    const confirmedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
      .from('stripe_payouts')
      .update({
        bank_arrival_date: bankArrivalDate,
        bank_confirmed_at: confirmedAt,
        bank_confirmed_by: authz.userId,
      })
      .eq('id', payoutId)
      .eq('status', 'paid')
      .eq('reconciliation_status', 'matched')
      .is('bank_confirmed_at', null)
      .select();
    if (updateError) throw updateError;

    if (!updated?.length) {
      // 競合で他の確認が先に入った場合は再読込し、同じ着金日なら成功として扱う。
      const { data: reread, error: rereadError } = await supabase
        .from('stripe_payouts')
        .select('id, amount, status, reconciliation_status, bank_arrival_date, bank_confirmed_at, bank_confirmed_by')
        .eq('id', payoutId)
        .maybeSingle();
      if (rereadError) throw rereadError;
      const latest = reread as PayoutRow | null;
      if (!latest?.bank_confirmed_at) {
        return NextResponse.json({ error: '銀行着金の確認に失敗しました。' }, { status: 409 });
      }
      return latest.bank_arrival_date === bankArrivalDate
        ? confirmedResponse(latest)
        : NextResponse.json({ error: '既に別の着金日で確認済みです。' }, { status: 409 });
    }

    await logAudit({
      action: 'admin.finance.stripePayout.confirm',
      actor_id: authz.userId,
      actor_email: authz.actorEmail,
      resource: 'stripe-payout',
      resource_id: payoutId,
      outcome: 'success',
      detail: `Confirmed bank arrival on ${bankArrivalDate}`,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata: { payoutId, bankArrivalDate, amount: current.amount },
    });

    return confirmedResponse(updated[0] as PayoutRow);
  } catch (error) {
    console.error('POST /api/admin/accounting/stripe-payouts/[id]/confirm error:', error);
    return NextResponse.json({ error: '銀行着金の確認に失敗しました。' }, { status: 500 });
  }
}
