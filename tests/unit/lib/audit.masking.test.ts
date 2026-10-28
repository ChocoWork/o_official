import { maskAuditEvent } from '@/lib/audit';

describe('maskAuditEvent', () => {
  it('masks sensitive keys in metadata', () => {
    const event = {
      action: 'auth.login.failure',
      outcome: 'failure' as const,
      metadata: {
        password: 'hunter2',
        token: 'abcdefg1234567890',
        safe: 'keepme',
      },
    };

    const masked = maskAuditEvent(event as any);

    expect(masked.metadata?.password).toBe('[REDACTED]');
    expect(masked.metadata?.token).toBe('[REDACTED]');
    expect(masked.metadata?.safe).toBe('keepme');
  });

  it('masks JWTs and long tokens in detail', () => {
    const event = {
      action: 'auth.refresh.failure',
      outcome: 'failure' as const,
      detail: `User attempted refresh with token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef.verylongsignature and with password=pw12345 and longtoken=abcdefghijklmnopqrstuvwxyz0123456789`,
    };

    const masked = maskAuditEvent(event as any);

    expect(masked.detail).toContain('[REDACTED_JWT]');
    expect(masked.detail).toContain('password=[REDACTED]');
    expect(masked.detail).toContain('[REDACTED_TOKEN]');
  });

  describe('DD-STOCKIST-039: 制御文字の除去（行の偽造の防止）', () => {
    it('detail の改行・タブ・NUL・書式文字（ゼロ幅・向きの制御）を空白にする', () => {
      const event = {
        action: 'admin.stockists.update',
        outcome: 'success' as const,
        detail: 'name=A\nB\r\nC\tD\u0000E​F‮G',
      };

      const masked = maskAuditEvent(event);

      expect(masked.detail).toBe('name=A B  C D E F G');
    });

    it('metadata の文字列（入れ子の物・配列の中も）の制御文字を空白にし、キーと文字以外の値は変えない', () => {
      const event = {
        action: 'admin.stockists.update',
        outcome: 'failure' as const,
        metadata: {
          permission: 'admin.stockists.manage\nINJECT',
          nested: { deep: ['a\u0007b', { name: 'x\ty' }], count: 3, flag: true, none: null },
        },
      };

      const masked = maskAuditEvent(event);

      expect(masked.metadata).toEqual({
        permission: 'admin.stockists.manage INJECT',
        nested: { deep: ['a b', { name: 'x y' }], count: 3, flag: true, none: null },
      });
    });

    it('制御文字の無い物は変わらない（日本語・絵文字・通常の空白）', () => {
      const event = {
        action: 'admin.stockists.update',
        outcome: 'success' as const,
        detail: '店舗名 ルフィル 東京 😀',
        metadata: { name: '取扱店 A', list: ['1', '2'] },
      };

      const masked = maskAuditEvent(event);

      expect(masked.detail).toBe('店舗名 ルフィル 東京 😀');
      expect(masked.metadata).toEqual({ name: '取扱店 A', list: ['1', '2'] });
    });

    it('元の event を壊さない', () => {
      const event = {
        action: 'a',
        outcome: 'success' as const,
        detail: 'x\ny',
        metadata: { k: 'v\nw', nested: { s: 'p\tq' } },
      };

      maskAuditEvent(event);

      expect(event.detail).toBe('x\ny');
      expect(event.metadata).toEqual({ k: 'v\nw', nested: { s: 'p\tq' } });
    });

    it('秘匿の対象のキーは制御文字の除去の後も [REDACTED] のまま', () => {
      const event = {
        action: 'a',
        outcome: 'failure' as const,
        metadata: { password: 'x\ny', safe: 's\nt' },
      };

      const masked = maskAuditEvent(event);

      expect(masked.metadata).toEqual({ password: '[REDACTED]', safe: 's t' });
    });
  });
});