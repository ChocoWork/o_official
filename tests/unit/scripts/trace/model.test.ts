/** @jest-environment node */
import { kindOf } from '@/../scripts/trace/model';

describe('kindOf', () => {
  it('kindOf は ID の形から種類を返す', () => {
    expect(kindOf('FR-NEWS-ALL-001-AC-01')).toBe('AC');
    expect(kindOf('FREQ-31-AC-01')).toBe('AC');
    expect(kindOf('FREQ-31')).toBe('REQUEST');
    expect(kindOf('SR-NEWS-001')).toBe('REQUEST');
    expect(kindOf('FR-NEWS-ALL-001')).toBe('REQ');
    expect(kindOf('SEC-001')).toBe('SEC');
    expect(kindOf('DD-NEWS-003')).toBe('DD');
    expect(kindOf('ADR-0001')).toBe('ADR');
    expect(kindOf('IMPL-NEWS-LIST-001')).toBe('IMPL');
    expect(kindOf('NEWS')).toBeNull();
  });

  it('残りの形も種類を返す', () => {
    expect(kindOf('FREQ-31-REQ-02')).toBe('REQ');
    expect(kindOf('NFR-PERF-001')).toBe('REQ');
    expect(kindOf('SEC-NEWS-001')).toBe('SEC');
    for (const k of ['DRV', 'THR', 'ARC', 'SCR', 'FLOW', 'STATE', 'API', 'DATA'] as const) {
      expect(kindOf(`${k}-NEWS-002`)).toBe(k);
    }
  });

  it('既にある A11Y・I18N のように数字を含む領域も読む', () => {
    expect(kindOf('NFR-A11Y-001')).toBe('REQ');
    expect(kindOf('NFR-I18N-003')).toBe('REQ');
  });

  it('形に合わない語は null を返す', () => {
    expect(kindOf('DD-NEWS')).toBeNull();
    expect(kindOf('FOO-NEWS-001')).toBeNull();
    expect(kindOf('dd-news-003')).toBeNull();
    expect(kindOf('ADR-01')).toBeNull();
    expect(kindOf('')).toBeNull();
  });
});
