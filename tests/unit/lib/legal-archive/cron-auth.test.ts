import { authorizeCronBearer } from '@/lib/legal-archive/cron-auth';

describe('authorizeCronBearer', () => {
  it('accepts the exact configured bearer token', () => {
    expect(authorizeCronBearer('Bearer archive-secret', 'archive-secret')).toBe(true);
  });

  it.each([null, '', 'Bearer wrong', 'Basic archive-secret'])(
    'rejects invalid authorization %p',
    (value) => expect(authorizeCronBearer(value, 'archive-secret')).toBe(false),
  );

  it('rejects an empty configured secret', () => {
    expect(authorizeCronBearer('Bearer ', '')).toBe(false);
  });
});
