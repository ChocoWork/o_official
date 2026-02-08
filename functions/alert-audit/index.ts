// Edge Function: alert-audit
// 監査イベントの挿入（POST）を受け取り、`security.alert_events` に記録します。
// 直近の件数を問い合わせ、閾値を超えた場合に通知をトリガーします。

// Deno標準ライブラリ：バンドラが解決できるよう明示的なURLでimportします
import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
// Deno互換のnpm指定子を使用します
// Denoは`npm:`指定子をサポートします；Supabase Functionsでのバンドラエラーを回避します
import { createClient } from 'npm:@supabase/supabase-js';

// ダッシュボードが `SUPABASE_` で始まる名前を拒否する可能性があるため、予約されていないシークレット名を優先します
const SUPA_URL = Deno.env.get('PROJECT_URL') || Deno.env.get('SUPABASE_URL') || null;
const SUPA_KEY = Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || null;
const WEBHOOK = Deno.env.get('ALERT_WEBHOOK_URL') || null;
const WINDOW_MINUTES = Number(Deno.env.get('ALERT_WINDOW_MINUTES') || '5');
const THRESHOLD = Number(Deno.env.get('ALERT_THRESHOLD') || '3');
const COOLDOWN_MINUTES = Number(Deno.env.get('ALERT_COOLDOWN_MINUTES') || '30');
const SHARED_SECRET = Deno.env.get('ALERT_TRIGGER_SECRET') || null; // optional header secret

// 必要なシークレットを検証した後に、Supabaseクライアントを遅延生成します
let supabase: ReturnType<typeof createClient> | null = null;

serve(async (req: Request) => {
  try {
    // 任意：トリガーヘッダによる簡易シークレット検証
    if (SHARED_SECRET) {
      const hdr = req.headers.get('x-alert-secret') || '';
      if (hdr !== SHARED_SECRET) return new Response('unauthorized', { status: 401 });
    }

    const payload = await req.json().catch(() => null);
    const rec = payload?.record || payload?.new || payload?.data?.new || payload;
    if (!rec) return new Response('no record', { status: 204 });

    // 必要なSupabase設定が存在するか確認
    if (!supabase) {
      if (!SUPA_URL || !SUPA_KEY) {
        console.error('Missing Supabase configuration: PROJECT_URL or SERVICE_ROLE_KEY not set');
        return new Response('server misconfiguration', { status: 500 });
      }
      supabase = createClient(SUPA_URL, SUPA_KEY, { global: { headers: {} } });
    }

    // 関連イベントのみ処理（防御的）：署名無効イベントのみ処理
    // Supabaseの認証監査は統合により'action'に 'auth_token_verify' 等を格納する場合があります
    if (rec.action !== 'auth_token_verify' || rec.detail !== 'signature_invalid') {
      // Still store raw event for offline analysis if desired
      await supabase.from('security.alert_events').insert([{
        action: rec.action || null,
        detail: rec.detail || null,
        ip_address: rec.ip_address || rec.ip || null,
        actor_id: rec.user_id || rec.actor_id || null,
        actor_email: rec.actor_email || null,
        metadata: rec.metadata || null,
        created_at: rec.created_at || new Date().toISOString(),
      }]).catch(() => {});

      return new Response('ignored', { status: 200 });
    }

    const ip = rec.ip_address || rec.ip || null;
    const actorId = rec.user_id || rec.actor_id || null;
    const actorEmail = rec.actor_email || null;

    // 生のイベントを記録
    await supabase.from('security.alert_events').insert([{
      action: rec.action,
      detail: rec.detail,
      ip_address: ip,
      actor_id: actorId,
      actor_email: actorEmail,
      metadata: rec.metadata || null,
      created_at: rec.created_at || new Date().toISOString(),
    }]);

    // 指定ウィンドウ内の件数をPostgresに問い合わせる
    const rpcRes = await supabase.rpc('security.count_recent_events', {
      action_text: rec.action,
      detail_text: rec.detail,
      ip_text: ip,
      actor_text: actorId ? String(actorId) : null,
      window_minutes: WINDOW_MINUTES,
    });

    const count = Array.isArray(rpcRes.data) && rpcRes.data[0] ? Number(rpcRes.data[0].count) : 0;

    if (count >= THRESHOLD) {
      // クールダウン確認：直近のアラート記録を探す
      const { data: recent } = await supabase
        .from('security.security_alerts')
        .select('*')
        .eq('key', `${ip}|${actorId}|${rec.action}`)
        .gte('created_at', new Date(Date.now() - COOLDOWN_MINUTES * 60000).toISOString())
        .limit(1);

      if (!recent || recent.length === 0) {
        // Webhookが設定されていれば通知を送信
        if (WEBHOOK) {
          await fetch(WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: `Security alert: ${count} '${rec.detail}' events from IP ${ip} (actor=${actorEmail || actorId}) in last ${WINDOW_MINUTES} minutes.`,
              count,
              ip,
              actor: actorEmail || actorId,
            }),
          }).catch((e) => console.error('webhook error', e));
        } else {
          console.warn('No ALERT_WEBHOOK_URL set; would notify', { count, ip, actor: actorEmail || actorId });
        }

        // クールダウンを適用するためにアラート記録を挿入
        await supabase.from('security.security_alerts').insert([{
          key: `${ip}|${actorId}|${rec.action}`,
          action: rec.action,
          detail: rec.detail,
          count,
          window_minutes: WINDOW_MINUTES,
          created_at: new Date().toISOString(),
        }]);
      }
    }

    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('alert-audit error', err);
    return new Response('error', { status: 500 });
  }
});
