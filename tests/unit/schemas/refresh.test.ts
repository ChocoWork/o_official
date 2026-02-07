import { RefreshResponseSchema } from '@/features/auth/schemas/refresh';

describe('RefreshResponseSchema', () => {
  test('valid with access_token only passes', () => {
    const data = { access_token: 'token123' };
    const parsed = RefreshResponseSchema.safeParse(data);
    expect(parsed.success).toBe(true);
  });

  test('valid with user only passes', () => {
    const data = { user: { id: 'user-1', email: 'user@example.com' } };
    const parsed = RefreshResponseSchema.safeParse(data);
    expect(parsed.success).toBe(true);
  });

  test('valid with both access_token and user passes', () => {
    const data = { access_token: 'tok', user: { id: 'u1', email: 'user@example.com' } };
    const parsed = RefreshResponseSchema.safeParse(data);
    expect(parsed.success).toBe(true);
  });

  test('invalid email in user fails with message', () => {
    const data = { user: { id: 'u1', email: 'not-an-email' } };
    const parsed = RefreshResponseSchema.safeParse(data);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path.join('.') === 'user.email');
      expect(issue).toBeDefined();
      // Accept either Japanese or English default messages to avoid brittle locale ordering
      expect(issue!.message).toMatch(/メール|email/i);
    }
  });

  test('missing user id fails', () => {
    const data = { user: { email: 'user@example.com' } };
    const parsed = RefreshResponseSchema.safeParse(data);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const hasIdIssue = parsed.error.issues.some((i) => i.path.join('.') === 'user.id');
      expect(hasIdIssue).toBe(true);
    }
  });
});
