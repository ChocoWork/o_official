import { logAudit } from '../../../src/lib/audit';

describe('audit', () => {
  test('logAudit does not throw', async () => {
    await expect(logAudit({ action: 'test', message: 'unit test' })).resolves.not.toThrow();
  });
});
