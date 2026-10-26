/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findMigration, readMigration, resolveSeedPath } from '../../helpers/staged-supabase';

let root: string;

function touch(rel: string, body = '-- x'): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-supabase-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('staged-supabase', () => {
  describe('findMigration', () => {
    it('supabase/migrations と pending-wave2 の両方にあれば、supabase/migrations の物を返す', () => {
      const real = touch('supabase/migrations/20260101000000_sec_x.sql');
      touch('supabase/pending-wave2/20260102000000_sec_x.sql');
      expect(findMigration('sec_x', root)).toBe(real);
    });

    it('pending-wave2 だけにあれば、その物を返す', () => {
      const staged = touch('supabase/pending-wave2/20260102000000_sec_x.sql');
      expect(findMigration('sec_x', root)).toBe(staged);
    });

    it('どこにも無ければ not found を含む例外を投げる', () => {
      touch('supabase/migrations/20260101000000_other.sql');
      expect(() => findMigration('sec_x', root)).toThrow(/not found/);
    });

    it('同じ場所に末尾が同じ移行が 2 本あれば ambiguous を含む例外を投げる', () => {
      touch('supabase/migrations/20260101000000_sec_x.sql');
      touch('supabase/migrations/20260103000000_sec_x.sql');
      expect(() => findMigration('sec_x', root)).toThrow(/ambiguous/);
    });

    it('時刻の接頭辞の直後から全部一致する物だけを数える（別の名前の末尾が偶然同じ物は数えない）', () => {
      touch('supabase/migrations/20260101000000_other_sec_x.sql');
      const staged = touch('supabase/pending-wave2/20260102000000_sec_x.sql');
      expect(findMigration('sec_x', root)).toBe(staged);
    });

    it('別の名前の末尾が同じだけの移行しか無ければ not found を含む例外を投げる', () => {
      touch('supabase/migrations/20260101000000_other_sec_x.sql');
      expect(() => findMigration('sec_x', root)).toThrow(/not found/);
    });

    it('末尾の一致だけを見る（名前の途中に含まれるだけの物は数えない）', () => {
      touch('supabase/pending-wave2/20260102000000_sec_x_more.sql');
      expect(() => findMigration('sec_x', root)).toThrow(/not found/);
    });
  });

  describe('readMigration', () => {
    it('見つけた移行の中身を文字列で返す', () => {
      touch('supabase/pending-wave2/20260102000000_sec_x.sql', 'select 1;');
      expect(readMigration('sec_x', root)).toBe('select 1;');
    });
  });

  describe('resolveSeedPath', () => {
    it('pending-wave2/seed に写しがあれば、写しを返す', () => {
      touch('supabase/seed.sql');
      const staged = touch('supabase/pending-wave2/seed/supabase/seed.sql');
      expect(resolveSeedPath('supabase/seed.sql', root)).toBe(staged);
    });

    it('写しが無ければ、本物を返す', () => {
      const real = touch('supabase/seed.sql');
      expect(resolveSeedPath('supabase/seed.sql', root)).toBe(real);
    });
  });
});
