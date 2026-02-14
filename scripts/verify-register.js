#!/usr/bin/env node
// Load .env.local if present (optional)
try {
  require('dotenv').config({ path: '.env.local' });
} catch (e) {
  // dotenv not installed or file missing — continue using process.env
}

const fetch = globalThis.fetch || require('node-fetch');

// If dotenv is not available, attempt to load .env.local manually so script
// can pick up SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from workspace.
try {
  if ((!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) && require('fs')) {
    const fs = require('fs');
    const p = '.env.local';
    if (fs.existsSync(p)) {
      const contents = fs.readFileSync(p, 'utf8');
      contents.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const match = trimmed.match(/^([A-Za-z0-9_\.\-]+)=(.*)$/);
        if (!match) return;
        const key = match[1];
        let val = match[2] || '';
        // remove surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      });
    }
  }
} catch (e) {
  // ignore
}

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.TEST_EMAIL || `verify+${Date.now()}@example.com`;
const PASSWORD = process.env.TEST_PASSWORD || 'Passw0rd!';
const REFRESH_COOKIE_NAME = 'sb-refresh-token';
const CSRF_COOKIE_NAME = 'sb-csrf-token';

async function httpPostRegister(email, password) {
  const resp = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  const setCookie = resp.headers.get('set-cookie') || resp.headers.get('Set-Cookie');
  return { status: resp.status, body: json, setCookie };
}

async function querySupabaseTable(supabaseUrl, serviceKey, table, filter) {
  const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${table}${filter||''}`;
  const resp = await fetch(url, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: 'application/json',
    },
  });
  const json = await resp.json();
  return { status: resp.status, body: json };
}

async function run() {
  console.log('Base URL:', BASE);
  console.log('Test email:', EMAIL);

  console.log('\n1) Creating user (public signup)');
  const first = await httpPostRegister(EMAIL, PASSWORD);
  console.log('Status:', first.status);
  console.log('Body:', JSON.stringify(first.body));
  console.log('Set-Cookie header:', first.setCookie ? '[present]' : '[none]');
  if (first.setCookie) {
    console.log('  Contains refresh cookie name?', first.setCookie.includes(REFRESH_COOKIE_NAME));
    console.log('  Contains csrf cookie name?', first.setCookie.includes(CSRF_COOKIE_NAME));
  }

  console.log('\n2) Duplicate registration attempt (should be 400/409)');
  const second = await httpPostRegister(EMAIL, PASSWORD);
  console.log('Status:', second.status);
  console.log('Body:', JSON.stringify(second.body));

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (SUPABASE_URL && SUPABASE_KEY) {
    console.log('\n3) Querying Supabase for created user (requires service role key)');
    try {
      const q = await querySupabaseTable(SUPABASE_URL, SUPABASE_KEY, 'users', `?select=id,email&email=eq.${encodeURIComponent(EMAIL)}`);
      console.log('users query status:', q.status);
      console.log('users body:', JSON.stringify(q.body));

      if (q.body && q.body.length) {
        const uid = q.body[0].id;
        const sQ = await querySupabaseTable(SUPABASE_URL, SUPABASE_KEY, 'sessions', `?select=*&user_id=eq.${encodeURIComponent(uid)}`);
        console.log('sessions query status:', sQ.status);
        console.log('sessions body:', JSON.stringify(sQ.body));

        const aQ = await querySupabaseTable(SUPABASE_URL, SUPABASE_KEY, 'audit_logs', `?select=*&action=eq.register&actor_email=eq.${encodeURIComponent(EMAIL)}`);
        console.log('audit_logs query status:', aQ.status);
        console.log('audit_logs body:', JSON.stringify(aQ.body));
      } else {
        console.log('User not found via REST API. Note: `auth.users` may be in a different schema or not exposed via PostgREST. If so, run the SQL below in Supabase SQL editor:');
        console.log(`\n-- SQL to run in Supabase SQL editor:\nselect id,email from auth.users where email = '${EMAIL}';\nselect * from public.sessions where user_id = '<id-from-above>' order by created_at desc limit 5;\nselect * from audit_logs where action='register' and actor_email='${EMAIL}' order by created_at desc limit 10;\n`);
      }
    } catch (e) {
      console.error('Supabase REST query failed:', e.message || e);
    }
  } else {
    console.log('\n3) SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping DB queries. To run DB checks, set these env vars and re-run.');
    console.log('Suggested SQL to run in Supabase SQL editor:');
    console.log(`\nselect id,email from auth.users where email = '${EMAIL}';\nselect * from public.sessions where user_id = '<id-from-above>' order by created_at desc limit 5;\nselect * from audit_logs where action='register' and actor_email='${EMAIL}' order by created_at desc limit 10;\n`);
  }

  // Decide exit code
  const ok = first.status >=200 && first.status < 300;
  process.exit(ok ? 0 : 2);
}

run().catch(e => { console.error(e); process.exit(3); });
