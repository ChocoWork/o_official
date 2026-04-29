import { logAudit } from '@/lib/audit';

function getRequestUserAgent(request: Request): string | null {
  return request.headers.get('user-agent') || null;
}

export async function logAdminLookAudit(input: {
  request: Request;
  actorId: string;
  actorEmail: string | null;
  action: string;
  outcome: 'success' | 'failure';
  detail: string;
  resourceId?: string | number | null;
  metadata?: Record<string, unknown>;
}) {
  return logAudit({
    action: input.action,
    actor_id: input.actorId,
    actor_email: input.actorEmail,
    resource: 'look',
    resource_id:
      input.resourceId === undefined || input.resourceId === null
        ? null
        : String(input.resourceId),
    outcome: input.outcome,
    detail: input.detail,
    user_agent: getRequestUserAgent(input.request),
    metadata: input.metadata ?? null,
  });
}