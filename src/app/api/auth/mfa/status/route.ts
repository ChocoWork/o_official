import { NextResponse } from 'next/server';
import { createClient, resolveRequestUser } from '@/lib/supabase/server';

type UserRole = 'admin' | 'supporter' | 'user';

const isUserRole = (role: unknown): role is UserRole => role === 'admin' || role === 'supporter' || role === 'user';

export async function GET(request: Request) {
  try {
    const supabase = await createClient(request);
    const {
      data: { user },
      error,
    } = await resolveRequestUser(supabase, request);

    if (error || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const role = isUserRole(user.app_metadata?.role) ? user.app_metadata.role : 'user';
    const isPrivileged = role === 'admin' || role === 'supporter';

    const [aalResult, factorsResult] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
    ]);

    if (aalResult.error) {
      console.error('[auth.mfa.status] failed to get AAL:', aalResult.error);
      return NextResponse.json({ error: 'Failed to resolve MFA status' }, { status: 500 });
    }

    if (factorsResult.error) {
      console.error('[auth.mfa.status] failed to list factors:', factorsResult.error);
      return NextResponse.json({ error: 'Failed to resolve MFA status' }, { status: 500 });
    }

    const totpFactors = factorsResult.data.totp ?? [];
    const phoneFactors = factorsResult.data.phone ?? [];
    const allFactors = [...totpFactors, ...phoneFactors];
    const verifiedFactors = allFactors.filter((factor) => factor.status === 'verified');
    const hasVerifiedFactor = verifiedFactors.length > 0;
    const currentLevel = aalResult.data.currentLevel ?? null;
    const nextLevel = aalResult.data.nextLevel ?? null;
    const needsChallenge =
      isPrivileged && hasVerifiedFactor && nextLevel === 'aal2' && currentLevel !== 'aal2';

    return NextResponse.json(
      {
        data: {
          role,
          isPrivileged,
          currentLevel,
          nextLevel,
          hasVerifiedFactor,
          needsChallenge,
          factors: verifiedFactors.map((factor) => ({
            id: factor.id,
            factorType: factor.factor_type,
            friendlyName: factor.friendly_name ?? null,
          })),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[auth.mfa.status] unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
