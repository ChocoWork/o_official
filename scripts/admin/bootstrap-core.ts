/**
 * 最初の店長を作る判断の筋道（外への書き込みは全部 deps に渡し、ここでは副作用を持たない）。
 *
 * @packageDocumentation
 * @remarks 新しい環境で最初の店長を作る。有効な店長が1人でもいれば何も書かずに止まり、役割の書き込みに失敗したら作った利用者を消す。パスワードは監査にも結果にも出さず、Auth の誤りの文（メールを含みうる）は出さずに status と code だけを返す。漏洩の照合先が使えない時は通して、監査に残す。
 */
import { emailSchema, passwordSchema } from '@/features/auth/schemas/common';
import type { PwnedCheckResult } from '@/lib/pwned-password';
import type { AuditEvent } from '@/lib/audit';

export type BootstrapInput = { email: string; password: string; passwordConfirmation: string; displayName?: string };
export type CreateUserResult = { kind: 'created'; id: string } | { kind: 'exists' } | { kind: 'failed'; status?: number; code?: string };
export type BootstrapDeps = {
  countActiveAdmins(): Promise<number>;
  checkPwned(password: string): Promise<PwnedCheckResult>;
  createUser(args: { email: string; password: string; displayName?: string }): Promise<CreateUserResult>;
  grantAdminRole(userId: string): Promise<void>; // 失敗は throw
  deleteUser(userId: string): Promise<void>;
  audit(event: AuditEvent): Promise<void>;
};
export type BootstrapFailureReason =
  | 'invalid_email'
  | 'password_mismatch'
  | 'invalid_password'
  | 'admin_exists'
  | 'pwned_password'
  | 'email_taken'
  | 'create_failed'
  | 'grant_failed';
export type BootstrapResult =
  | { ok: true; userId: string; email: string; pwnedCheck: 'ok' | 'unavailable' }
  | { ok: false; reason: BootstrapFailureReason; message: string };

const fail = (reason: BootstrapFailureReason, message: string): BootstrapResult => ({ ok: false, reason, message });

/**
 * 最初の店長を作る判断。有効な店長が1人でもいれば何も書かずに止まる。
 *
 * @impl IMPL-ADMIN-301
 * @design DD-ADMIN-016
 * @remarks 役割の書き込みが2回の要求で、片方だけ通った利用者を残さないため、失敗したら作った利用者を消す。Auth の誤りの文（メールを含みうる）と、パスワードは、結果にも監査にも出さない。
 */
export async function bootstrapFirstAdmin(input: BootstrapInput, deps: BootstrapDeps): Promise<BootstrapResult> {
  const emailParsed = emailSchema.safeParse(input.email.trim()); // スキーマは形の確認の後に trim するので、前後の空白は先に除く
  if (!emailParsed.success) return fail('invalid_email', 'メールアドレスの形式が正しくありません');
  const email = emailParsed.data;

  if (input.password !== input.passwordConfirmation) {
    return fail('password_mismatch', 'パスワードと確認用のパスワードが一致しません');
  }

  if (/\p{Cc}/u.test(input.password)) {
    return fail('invalid_password', 'パスワードに制御文字（矢印・Tab・Esc など）が入っています。打ち直してください');
  }

  const passwordParsed = passwordSchema.safeParse(input.password);
  if (!passwordParsed.success) {
    return fail('invalid_password', passwordParsed.error.issues[0]?.message ?? 'パスワードが正しくありません');
  }

  if ((await deps.countActiveAdmins()) > 0) {
    return fail('admin_exists', '有効な店長がすでにいるため、作りません');
  }

  const pwned = await deps.checkPwned(input.password);
  if (pwned.status === 'pwned') {
    return fail('pwned_password', 'このパスワードは過去に漏洩しています。別のパスワードにしてください');
  }
  if (pwned.status === 'unavailable') {
    await deps.audit({
      action: 'admin_bootstrap',
      actor_id: null,
      actor_email: null,
      resource: 'users',
      outcome: 'error',
      detail: `pwned_check_unavailable:${pwned.reason}`,
    });
  }

  const created = await deps.createUser({ email, password: input.password, displayName: input.displayName });
  if (created.kind === 'exists') {
    return fail('email_taken', 'このメールアドレスはすでに使われています');
  }
  if (created.kind === 'failed') {
    return fail('create_failed', `利用者を作れませんでした（status: ${created.status ?? '不明'}, code: ${created.code ?? '不明'}）`);
  }

  const userId = created.id;
  try {
    await deps.grantAdminRole(userId);
  } catch {
    // 役割がない利用者を残さない。消すのに失敗しても、grant_failed として返し監査に残す。
    let deleted = true;
    try {
      await deps.deleteUser(userId);
    } catch {
      deleted = false;
    }
    await deps.audit({
      action: 'admin_bootstrap',
      actor_id: null,
      actor_email: null,
      resource: 'users',
      resource_id: userId,
      outcome: 'failure',
      detail: 'grant_failed',
      metadata: { cleanup: deleted ? 'deleted' : 'delete_failed' },
    });
    return fail(
      'grant_failed',
      deleted
        ? '店長の役割を付けられなかったため、作った利用者を消しました'
        : `店長の役割を付けられず、作った利用者も消せませんでした。Auth の利用者 ${userId} を手で消してください`,
    );
  }

  await deps.audit({
    action: 'admin_bootstrap',
    actor_id: null,
    actor_email: null,
    resource: 'users',
    resource_id: userId,
    outcome: 'success',
  });

  return { ok: true, userId, email, pwnedCheck: pwned.status === 'unavailable' ? 'unavailable' : 'ok' };
}
