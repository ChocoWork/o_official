/**
 * 引き金 `passkey_credentials_notify`（移行 20261116232141）が outbox の `kind` に積む3つの種類。
 * DB の CHECK 制約（移行 20261116215034）と同じ並びにする。送る側（段2・3）がこの表で種類を見分ける。
 */
export const PASSKEY_OUTBOX_KINDS = ['passkey_added', 'passkey_removed', 'passkey_key_replaced'] as const;

export type PasskeyOutboxKind = (typeof PASSKEY_OUTBOX_KINDS)[number];

/**
 * outbox の `kind` が、引き金が積む3つの種類のどれかを調べる。
 *
 * @impl IMPL-AUTH-242
 * @design DD-AUTH-045
 * @remarks 送る側が未知の種類を黙って送らないため。DB の CHECK 制約と食い違ったら、単体テストが移行の文と突き合わせて落ちる。
 */
export function isPasskeyOutboxKind(value: unknown): value is PasskeyOutboxKind {
  return typeof value === 'string' && (PASSKEY_OUTBOX_KINDS as readonly string[]).includes(value);
}
