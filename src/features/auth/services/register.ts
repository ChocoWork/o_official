import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';

export async function persistSessionAndCookies(res: NextResponse, session: any, user: any) {
  const context = { actor_id: user?.id ?? null, actor_email: user?.email ?? null };

  try {
    if (!session || !user) {
      const msg = 'persistSessionAndCookies: missing session or user';
      console.warn(msg, { sessionPresent: !!session, userPresent: !!user });
      await logAudit({ action: 'auth.session.persist', outcome: 'error', detail: msg, actor_id: context.actor_id, actor_email: context.actor_email });
      return { ok: false, error: msg };
    }

    const {
      refreshCookieName,
      accessCookieName,
      cookieOptionsForRefresh,
      cookieOptionsForAccess,
      csrfCookieName,
      cookieOptionsForCsrf,
    } = await import('@/lib/cookie');
    const { generateCsrfToken } = await import('@/lib/csrf');
    const { tokenHashSha256 } = await import('@/lib/hash');
    const { createServiceRoleClient } = await import('@/lib/supabase/server');

    const service = await createServiceRoleClient();
    const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

    const accessToken = session.access_token ?? '';
    const accessMaxAge = typeof session.expires_in === 'number' ? session.expires_in : 15 * 60;

    // set access cookie (HttpOnly)
    try {
      res.cookies.set({ name: accessCookieName, value: accessToken, ...cookieOptionsForAccess(accessMaxAge) });
    } catch (e) {
      console.error('persistSessionAndCookies: failed to set access cookie', e, context);
      await logAudit({ action: 'auth.session.persist', outcome: 'error', detail: 'Failed to set access cookie', actor_id: context.actor_id, actor_email: context.actor_email });
      return { ok: false, error: 'Failed to set access cookie' };
    }

    // set refresh cookie (HttpOnly)
    try {
      res.cookies.set({ name: refreshCookieName, value: session.refresh_token ?? '', ...cookieOptionsForRefresh(REFRESH_TOKEN_MAX_AGE) });
    } catch (e) {
      console.error('persistSessionAndCookies: failed to set refresh cookie', e, context);
      await logAudit({ action: 'auth.session.persist', outcome: 'error', detail: 'Failed to set refresh cookie', actor_id: context.actor_id, actor_email: context.actor_email });
      return { ok: false, error: 'Failed to set refresh cookie' };
    }

    // generate csrf token and set non-httpOnly cookie
    const csrfToken = generateCsrfToken();
    try {
      res.cookies.set({ name: csrfCookieName, value: csrfToken, ...cookieOptionsForCsrf(REFRESH_TOKEN_MAX_AGE) });
    } catch (e) {
      console.error('persistSessionAndCookies: failed to set csrf cookie', e, context);
      await logAudit({ action: 'auth.session.persist', outcome: 'error', detail: 'Failed to set CSRF cookie', actor_id: context.actor_id, actor_email: context.actor_email });
      return { ok: false, error: 'Failed to set CSRF cookie' };
    }

    // persist hashed refresh & csrf token into sessions table
    const refreshToken = session.refresh_token ?? '';
    const refreshHash = tokenHashSha256(refreshToken);
    const csrfHash = tokenHashSha256(csrfToken);

    const expiresAt = session.expires_at ? new Date(session.expires_at).toISOString() : null;

    try {
      const { data: inserted, error: insertError } = await service.from('sessions').insert([
        {
          user_id: user?.id,
          refresh_token_hash: refreshHash,
          csrf_token_hash: csrfHash,
          expires_at: expiresAt,
          last_seen_at: new Date().toISOString(),
        },
      ]);

      if (insertError) {
        console.error('persistSessionAndCookies: DB insert error', insertError, context);
        const outcome = String(insertError.message || '').toLowerCase().includes('duplicate') ? 'conflict' : 'error';
        await logAudit({ action: 'auth.session.persist', outcome, detail: insertError.message, actor_id: context.actor_id, actor_email: context.actor_email, metadata: { expires_at: expiresAt } });
        return { ok: false, error: insertError.message };
      }

      // success
      await logAudit({ action: 'auth.session.persist', outcome: 'success', actor_id: context.actor_id, actor_email: context.actor_email, metadata: { inserted_count: Array.isArray(inserted) ? inserted.length : 1, expires_at: expiresAt } });
      return { ok: true };
    } catch (dbErr) {
      console.error('persistSessionAndCookies: unexpected DB error', dbErr, context);
      await logAudit({ action: 'auth.session.persist', outcome: 'error', detail: String(dbErr), actor_id: context.actor_id, actor_email: context.actor_email });
      return { ok: false, error: String(dbErr) };
    }
  } catch (e) {
    console.error('persistSessionAndCookies unexpected error:', e, context);
    try {
      await logAudit({ action: 'auth.session.persist', outcome: 'error', detail: String(e), actor_id: context.actor_id, actor_email: context.actor_email });
    } catch (_) {
      // ignore audit logging errors
    }
    return { ok: false, error: String(e) };
  }
}

export default {
  persistSessionAndCookies,
};
