#!/usr/bin/env node
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAYS = process.env.AUDIT_LOG_RETENTION_DAYS ? parseInt(process.env.AUDIT_LOG_RETENTION_DAYS, 10) : 365;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(2);
}

(async function main(){
  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
  const endpoint = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/audit_logs?created_at=lt.${encodeURIComponent(cutoff)}`;

  let fetcher = global.fetch;
  if (typeof fetcher !== 'function') {
    try {
      fetcher = require('node-fetch');
    } catch (e) {
      console.error('Global fetch not available and node-fetch not installed');
      process.exit(2);
    }
  }

  const res = await fetcher(endpoint, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=representation',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Failed to cleanup audit logs:', res.status, body);
    process.exit(1);
  }

  const data = await res.json();
  console.log(`Deleted ${Array.isArray(data) ? data.length : 0} audit logs older than ${cutoff}`);
})();