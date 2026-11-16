/** @jest-environment node */
/**
 * M-8 パスキーの店員の道具（provisionStaff など）は、DB の接続先が手元でなければ、Auth にも DB にも触る前に投げる（DD-AUTH-046）。
 */
const mockCreateClient = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: (...args: unknown[]) => mockCreateClient(...args) }));

import { addApprovedPasskey, provisionPasskeyUser, provisionStaff } from '../../../scripts/e2e/passkey-staff';
import type { PgClient } from '../../integration/db/helpers/local-db';

const ORIGINAL_ENV = { ...process.env };

function remoteDb(): { db: PgClient; query: jest.Mock } {
  const query = jest.fn();
  return { db: { host: 'db.prodproject.supabase.co', query, end: jest.fn() } as unknown as PgClient, query };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'local-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-service-role-key';
  mockCreateClient.mockReset();
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('M-8 DB の接続先が手元でない時', () => {
  it('DD-AUTH-046 provisionStaff は何も書かず・Auth の利用者も作らずに投げる', async () => {
    const { db, query } = remoteDb();
    await expect(provisionStaff(db, { role: 'admin', approvedPasskeys: 2 })).rejects.toThrow('手元の DB');
    expect(query).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('DD-AUTH-046 provisionPasskeyUser と addApprovedPasskey も同じ', async () => {
    const { db, query } = remoteDb();
    await expect(provisionPasskeyUser(db, { approvedPasskeys: 0 })).rejects.toThrow('手元の DB');
    await expect(addApprovedPasskey(db, { userId: 'u', accessToken: 'a', refreshToken: 'r' })).rejects.toThrow('手元の DB');
    expect(query).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
