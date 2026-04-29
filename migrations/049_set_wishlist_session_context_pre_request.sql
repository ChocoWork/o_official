create schema if not exists private;

create or replace function private.set_request_context()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  request_headers json := coalesce(current_setting('request.headers', true), '{}')::json;
  request_cookies json := coalesce(current_setting('request.cookies', true), '{}')::json;
  header_session_id text := nullif(btrim(coalesce(request_headers->>'x-session-id', '')), '');
  cookie_session_id text := nullif(btrim(coalesce(request_cookies->>'session_id', '')), '');
begin
  perform set_config('app.session_id', coalesce(header_session_id, cookie_session_id, ''), true);
end;
$$;

revoke all on function private.set_request_context() from public;
grant execute on function private.set_request_context() to authenticator, anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'private.set_request_context';
notify pgrst, 'reload config';