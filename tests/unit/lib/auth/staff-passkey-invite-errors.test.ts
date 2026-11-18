import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  staffInviteActivateFailureReason,
  staffInviteCancelFailureReason,
  staffInviteIssueFailureReason,
} from '@/lib/auth/staff-passkey-invite-errors';

const dir = path.join(process.cwd(), 'supabase/migrations');
const file = readdirSync(dir).find((f) => f.endsWith('_passkey_staff_invites.sql'));
const sql = file ? readFileSync(path.join(dir, file), 'utf8').replaceAll('\r\n', '\n') : '';

describe('staff invite DB failure reasons', () => {
  it('DD-AUTH-070 発行の失敗の文を理由にし、知らない文・null・undefined は failed にする', () => {
    expect(staffInviteIssueFailureReason('STAFF_INVITE_KIND_FORBIDDEN')).toBe('kind_forbidden');
    expect(staffInviteIssueFailureReason('STAFF_ALREADY_STAFF')).toBe('already_staff');
    expect(staffInviteIssueFailureReason('LAST_ADMIN_REQUIRED')).toBe('last_admin');
    expect(staffInviteIssueFailureReason('SELF_ROLE_CHANGE_FORBIDDEN')).toBe('self');
    expect(staffInviteIssueFailureReason('ROLE_PERMISSION_FORBIDDEN')).toBe('forbidden');
    expect(staffInviteIssueFailureReason('USER_NOT_FOUND')).toBe('not_found');
    expect(staffInviteIssueFailureReason('something else')).toBe('failed');
    expect(staffInviteIssueFailureReason('toString')).toBe('failed');
    expect(staffInviteIssueFailureReason(null)).toBe('failed');
    expect(staffInviteIssueFailureReason(undefined)).toBe('failed');
  });

  it('DD-AUTH-071 結びと有効化の失敗の文を理由にし、知らない文は failed にする', () => {
    expect(staffInviteActivateFailureReason('STAFF_ACTIVATE_INVITE_INVALID')).toBe('invite_invalid');
    expect(staffInviteActivateFailureReason('STAFF_INVITE_INVALID')).toBe('invite_invalid');
    expect(staffInviteActivateFailureReason('STAFF_INVITE_ALREADY_BOUND')).toBe('already_bound');
    expect(staffInviteActivateFailureReason('STAFF_ACTIVATE_NO_WINDOW')).toBe('no_window');
    expect(staffInviteActivateFailureReason('STAFF_ACTIVATE_KEYS_SHORT')).toBe('keys_short');
    expect(staffInviteActivateFailureReason('STAFF_ACTIVATE_KEYS_NOT_WINDOW')).toBe('keys_not_window');
    expect(staffInviteActivateFailureReason('x')).toBe('failed');
    expect(staffInviteActivateFailureReason(undefined)).toBe('failed');
  });

  it('DD-AUTH-072 取り消しは操作者が店長でない時だけ forbidden', () => {
    expect(staffInviteCancelFailureReason('ROLE_PERMISSION_FORBIDDEN')).toBe('forbidden');
    expect(staffInviteCancelFailureReason('USER_NOT_FOUND')).toBe('failed');
    expect(staffInviteCancelFailureReason(null)).toBe('failed');
  });

  it('DD-AUTH-070 理由の文はすべて移行 H の本体にある', () => {
    expect(sql).not.toBe('');
    for (const m of [
      'STAFF_INVITE_KIND_FORBIDDEN', 'STAFF_ALREADY_STAFF', 'LAST_ADMIN_REQUIRED', 'SELF_ROLE_CHANGE_FORBIDDEN',
      'ROLE_PERMISSION_FORBIDDEN', 'USER_NOT_FOUND', 'STAFF_ACTIVATE_INVITE_INVALID', 'STAFF_INVITE_INVALID',
      'STAFF_INVITE_ALREADY_BOUND', 'STAFF_ACTIVATE_NO_WINDOW', 'STAFF_ACTIVATE_KEYS_SHORT', 'STAFF_ACTIVATE_KEYS_NOT_WINDOW',
    ]) {
      expect(sql).toContain(`MESSAGE = '${m}'`);
    }
  });

  it('DD-AUTH-070 錠は全体の190519が先、利用者の鍵が後（発行・結び・有効化・取り消しの順を変えない）', () => {
    const g = 'pg_advisory_xact_lock(190519, 0);';
    const u = "pg_advisory_xact_lock(hashtextextended('passkey_approve:'";
    const names: Array<[string, string]> = [
      ['private.staff_invite_issue_core', 'core'], ['public.staff_invite_bind_window', 'bind'],
      ['public.staff_role_activate', 'activate'], ['public.staff_invite_cancel', 'cancel'],
    ];
    for (const [name] of names) {
      const start = sql.indexOf(`FUNCTION ${name}(`);
      expect(start).toBeGreaterThan(-1);
      const body = sql.slice(start, sql.indexOf('\n$$;', start));
      expect(body.indexOf(g)).toBeGreaterThan(-1);
      expect(body.indexOf(u)).toBeGreaterThan(body.indexOf(g));
    }
  });
});
