import 'server-only';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { sendOnce } from '@/lib/ops/ops-checks';
import { sendOpsAlertMail, siteUrlInvalidMail } from '@/lib/ops/ops-alert-mail';
import type { OpsStore } from '@/lib/ops/ops-store';

/** 認証の2窓口で共通の種類別制限を使う。URL・要求・宛先は受け取らない。 */
export async function notifySiteUrlInvalid(): Promise<void> {
  try {
    const client = await createServiceRoleClient();
    await sendOnce({ store: client as unknown as OpsStore, send: sendOpsAlertMail, now: () => new Date() },
      'site_url_invalid', siteUrlInvalidMail());
  } catch {
    await logAudit({
      action: 'ops.alert_mail', resource: 'ops_alert', outcome: 'error', detail: 'site_url_invalid_alert_failed',
      metadata: { kind: 'site_url_invalid' },
    });
  }
}
