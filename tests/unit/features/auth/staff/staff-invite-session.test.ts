/** @jest-environment node */
/**
 * DD-AUTH-078 招待された人のセッションを作る部品（src/features/auth/staff/staff-invite-session.ts）。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(), createPublicClient: jest.fn() }));

import { createInviteSession } from '@/features/auth/staff/staff-invite-session';
import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';

const OK_SESSION = { access_token: 'a', refresh_token: 'r' };
const OK_USER = { id: 'u' };

function wire(over: { getUser?: unknown; link?: unknown; verify?: unknown } = {}) {
  (createServiceRoleClient as jest.Mock).mockResolvedValue({
    auth: {
      admin: {
        getUserById: jest.fn().mockResolvedValue(over.getUser ?? { data: { user: { email: 'a@example.com' } }, error: null }),
        generateLink: jest.fn().mockResolvedValue(over.link ?? { data: { properties: { hashed_token: 'h' } }, error: null }),
      },
    },
  });
  (createPublicClient as jest.Mock).mockResolvedValue({
    auth: {
      verifyOtp: jest.fn().mockResolvedValue(over.verify ?? { data: { session: OK_SESSION, user: OK_USER }, error: null }),
    },
  });
}

describe('DD-AUTH-078 createInviteSession', () => {
  test('DD-AUTH-078 通れば session と user を返す', async () => {
    wire();
    expect(await createInviteSession('u')).toEqual({ session: OK_SESSION, user: OK_USER });
  });

  test.each([
    ['getUserById が data を返さない', { getUser: { data: null, error: null } }],
    ['getUserById が誤り', { getUser: { data: { user: { email: 'a@example.com' } }, error: { message: 'x' } } }],
    ['メールが無い', { getUser: { data: { user: {} }, error: null } }],
    ['generateLink が data を返さない', { link: { data: null, error: null } }],
    ['hashed_token が空', { link: { data: { properties: { hashed_token: '' } }, error: null } }],
    ['verifyOtp が data を返さない', { verify: { data: null, error: null } }],
    ['verifyOtp が誤り', { verify: { data: { session: OK_SESSION, user: OK_USER }, error: { message: 'x' } } }],
    ['access_token が無い', { verify: { data: { session: { refresh_token: 'r' }, user: OK_USER }, error: null } }],
    ['refresh_token が無い', { verify: { data: { session: { access_token: 'a' }, user: OK_USER }, error: null } }],
    ['user が無い', { verify: { data: { session: OK_SESSION, user: null }, error: null } }],
  ])('DD-AUTH-078 %s は null', async (_label, over) => {
    wire(over);
    expect(await createInviteSession('u')).toBeNull();
  });

  test('DD-AUTH-078 例外は null', async () => {
    (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('x'));
    expect(await createInviteSession('u')).toBeNull();
  });
});
