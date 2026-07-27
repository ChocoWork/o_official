import { logAudit } from '../../../src/lib/audit';

describe('audit', () => {
  test('logAudit does not throw', async () => {
    await expect(
      logAudit({ action: 'test', outcome: 'success', detail: 'unit test' }),
    ).resolves.not.toThrow();
  });
});
