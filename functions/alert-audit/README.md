# Alert-audit Edge Function

Purpose: receive audit insert events (from Supabase Event Trigger), record them to `security.alert_events`, check recent counts via RPC `security.count_recent_events`, and send notification when threshold exceeded.

Environment variables (set in Supabase project secrets for Functions):
- PROJECT_URL (preferred) OR SUPABASE_URL (project URL, e.g. https://<project-ref>.supabase.co)
- SERVICE_ROLE_KEY (preferred) OR SUPABASE_SERVICE_ROLE_KEY (service role secret; **private**)
- ALERT_WEBHOOK_URL (required for real notifications; e.g., Slack incoming webhook)
- ALERT_WINDOW_MINUTES (default 5)
- ALERT_THRESHOLD (default 3)
- ALERT_COOLDOWN_MINUTES (default 30)
- ALERT_TRIGGER_SECRET (optional; secret header value to verify trigger)

Note: The Supabase Dashboard may reject secret names that start with the `SUPABASE_` prefix. For easier management, prefer `PROJECT_URL` and `SERVICE_ROLE_KEY` as the secret names and set those in Functions → Secrets.

Local testing:
1. Install supabase CLI and run `supabase functions serve alert-audit`.
2. POST a sample event to the function endpoint:

```
curl -X POST http://localhost:54321/alert-audit -H 'Content-Type: application/json' -d '{"record":{"action":"auth_token_verify","detail":"signature_invalid","ip_address":"1.2.3.4","actor_email":"bad@x.com"}}'
```

Deployment:
- `supabase functions deploy alert-audit --project-ref <your-ref>`
- In Supabase Console, create an Event Trigger on table `auth.audit_log_entries` for INSERT and point to the deployed function URL (or use the Dashboard "Integrations" -> Event Trigger flow). Add header `x-alert-secret` with the value of `ALERT_TRIGGER_SECRET` if using.

Notes:
- The function assumes `migrations/008_create_security_alerts.sql` has been applied to create `security.alert_events`, `security.security_alerts`, and the RPC `security.count_recent_events`.
- If you use a different audit table (e.g., `audit_logs`), configure the Event Trigger accordingly.
