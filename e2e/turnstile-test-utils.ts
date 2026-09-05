import { Page } from '@playwright/test';

/**
 * Turnstile のテスト用トークンを注入する。
 *
 * window.onTurnstileSuccess は LoginModal / RegisterModal がハイドレーション後に
 * 登録するフック（src/hooks/useTurnstileWidget.ts）。goto 直後に呼ぶと未登録で、
 * `?.()` が無言で何もせずに終わり、送信がクライアント側の
 * 「ボット検証を完了してください」で止まる。並列実行時に顕在化する。
 * 登録を待ってから呼ぶこと。
 */
export async function injectTurnstileToken(page: Page, token = 'test-turnstile-token') {
  if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) return;

  await page.waitForFunction(() => typeof window.onTurnstileSuccess === 'function');
  await page.evaluate((value) => {
    window.onTurnstileSuccess!(value);
  }, token);
}

/**
 * Turnstile の api.js をローカルスタブに差し替える。
 *
 * スイート全体を並列実行すると challenges.cloudflare.com が 429 を返し、
 * api.js が net::ERR_BLOCKED_BY_ORB で読めずウィジェットが生成されない。
 * レイアウトの検証を外部 CDN の可用性に依存させないためのスタブ。
 *
 * 再現する挙動は実測値に基づく（Chromium 実測、2026-09-02）:
 *   - iframe は幅 300px を下回れない
 *   - size:'flexible' はコンテナ幅に追従する（300px 以上のとき）
 *   - 高さは 72px 固定
 *   - hidden input[name=cf-turnstile-response] はウィジェットの兄弟として置かれる
 *   - トークンは使い捨てで、発行のたびに別の値になる（固定値だと再利用を検出できない）
 *   - reset(widgetId) で新しいトークンを発行し直す
 *   - remove(widgetId) はウィジェットを DOM から取り除く
 */
export async function stubTurnstileScript(page: Page) {
  await page.route('**/turnstile/v0/api.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        window.turnstile = (function () {
          var widgets = {};
          var widgetSeq = 0;
          var tokenSeq = 0;

          // 値は同期で入れ、コールバックだけ非同期にする。実物と同じく
          // hidden input は描画直後から読めるが、購読側へは 1 tick 遅れて届く。
          function issue(id) {
            var w = widgets[id];
            if (!w) return;
            tokenSeq += 1;
            var token = 'XXXX.DUMMY.TOKEN.' + tokenSeq;
            w.input.value = token;
            setTimeout(function () { w.opts.callback(token); }, 0);
          }

          return {
            render: function (el, opts) {
              var widget = document.createElement('div');
              widget.setAttribute('data-turnstile-stub', '1');
              widget.style.height = '72px';
              widget.style.minWidth = '300px';
              widget.style.width = opts.size === 'flexible' ? '100%' : '300px';
              var input = document.createElement('input');
              input.type = 'hidden';
              input.name = 'cf-turnstile-response';
              el.appendChild(widget);
              el.appendChild(input);
              widgetSeq += 1;
              var id = 'stub-widget-' + widgetSeq;
              widgets[id] = { opts: opts, widget: widget, input: input };
              issue(id);
              return id;
            },
            reset: function (id) { issue(id); },
            remove: function (id) {
              var w = widgets[id];
              if (!w) return;
              if (w.widget.parentNode) w.widget.parentNode.removeChild(w.widget);
              if (w.input.parentNode) w.input.parentNode.removeChild(w.input);
              delete widgets[id];
            },
          };
        })();
        if (window.__turnstileScriptReady) window.__turnstileScriptReady();
      `,
    });
  });
}
