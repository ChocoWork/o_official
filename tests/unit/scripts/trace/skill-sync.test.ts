/** @jest-environment node */
import fs from 'node:fs';

describe('documentation-guide スキル', () => {
  it('documentation-guide の3つの写しは同じ中身', () => {
    const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    const a = read('.claude/skills/documentation-guide/SKILL.md');
    expect(read('.codex/skills/documentation-guide/SKILL.md')).toBe(a);
    expect(read('.github/skills/documentation-guide/SKILL.md')).toBe(a);
    expect(a).toMatch(/^### 9\. コードのコメント$/m);
    expect(a).toContain('@impl');
  });
});
