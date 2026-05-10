import type { SupabaseClient } from '@supabase/supabase-js';

type AppRole = 'admin' | 'supporter' | 'user';

type AuthLikeUser = {
  id?: string | null;
  app_metadata?: unknown;
};

type AppMetadataObject = Record<string, unknown>;

function isAppRole(value: unknown): value is AppRole {
  return value === 'admin' || value === 'supporter' || value === 'user';
}

function toAppMetadataObject(value: unknown): AppMetadataObject {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return value as AppMetadataObject;
}

function isPrivilegedRole(role: AppRole): boolean {
  return role === 'admin' || role === 'supporter';
}

function resolveRole(user: AuthLikeUser): AppRole {
  const appMetadata = toAppMetadataObject(user.app_metadata);
  const role = appMetadata.role;
  return isAppRole(role) ? role : 'user';
}

export async function resetPrivilegedMfaVerification(
  service: SupabaseClient,
  user: AuthLikeUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!user.id) {
    return { ok: false, error: 'missing_user_id' };
  }

  const role = resolveRole(user);
  if (!isPrivilegedRole(role)) {
    return { ok: true };
  }

  const appMetadata = toAppMetadataObject(user.app_metadata);

  const { error } = await service.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...appMetadata,
      admin_mfa_verified: false,
      mfa_verified: false,
    },
  });

  if (error) {
    return { ok: false, error: error.message || 'failed_to_reset_mfa_metadata' };
  }

  return { ok: true };
}

export async function markPrivilegedMfaVerified(
  service: SupabaseClient,
  user: AuthLikeUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!user.id) {
    return { ok: false, error: 'missing_user_id' };
  }

  const role = resolveRole(user);
  if (!isPrivilegedRole(role)) {
    return { ok: true };
  }

  const appMetadata = toAppMetadataObject(user.app_metadata);

  const { error } = await service.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...appMetadata,
      admin_mfa_verified: true,
      mfa_verified: true,
    },
  });

  if (error) {
    return { ok: false, error: error.message || 'failed_to_mark_mfa_verified' };
  }

  return { ok: true };
}
