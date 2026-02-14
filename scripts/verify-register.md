# verify-register

Simple verification for `POST /api/auth/register`.

Usage (Node 18+ or with `node-fetch` available):

```bash
# Basic HTTP checks against local dev server
BASE_URL=http://localhost:3000 TEST_EMAIL=you@example.com TEST_PASSWORD=Passw0rd! node scripts/verify-register.js

# If you want DB checks via Supabase REST (requires service role key)
SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service-role-key> BASE_URL=https://your-app node scripts/verify-register.js
```

What it checks:
- Sends a public signup request and prints response + Set-Cookie header
- Sends a duplicate signup request and prints response
- If Supabase service role key provided, queries `users`, `sessions`, and `audit_logs` via REST API
- Otherwise, prints SQL snippets to run in Supabase SQL editor

Expected outcomes:
- First request: 201 Created (or 202 Accepted if email confirmation required)
- Second request: 400/409 indicating duplicate
- Set-Cookie contains `sb-refresh-token` and `sb-csrf-token` when session returned
