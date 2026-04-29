type AdminUserLite = {
  id?: string | null;
  email?: string | null;
};

export async function findAuthUserIdByEmail(
  service: {
    auth?: {
      admin?: {
        listUsers?: (params?: { page?: number; perPage?: number }) => Promise<{
          data?: { users?: AdminUserLite[] };
          error?: { message?: string } | null;
        }>;
      };
    };
  },
  email: string
): Promise<string | null> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return null;

  const listUsers = service?.auth?.admin?.listUsers;
  if (typeof listUsers !== 'function') return null;

  const perPage = 200;
  const maxPages = 20;

  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await listUsers({ page, perPage });
    if (error) {
      throw new Error(error.message || 'auth admin listUsers failed');
    }

    const users = data?.users ?? [];
    const found = users.find((user) => String(user.email || '').toLowerCase() === normalizedEmail);
    if (found?.id) return found.id;

    if (users.length < perPage) break;
  }

  return null;
}