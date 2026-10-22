(function () {
  function setHtml(html) {
    var body = document.body;
    if (!body) return;
    body.innerHTML = '<div style="max-width:560px;margin:40px auto;padding:24px;font-family:Arial,sans-serif;color:#0f172a;">' + html + '</div>';
  }

  function waitInitData(maxMs) {
    return new Promise(function (resolve) {
      var started = Date.now();
      function tick() {
        var data = String((window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) || "");
        if (data) return resolve(data);
        if (Date.now() - started >= maxMs) return resolve("");
        setTimeout(tick, 200);
      }
      tick();
    });
  }

  async function run() {
    try {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (!tg) {
        setHtml('<h2 style="margin:0 0 8px;">RP Market</h2><p>Telegram WebApp недоступен.</p>');
        return;
      }

      tg.ready();
      setHtml('<h2 style="margin:0 0 8px;">RP Market</h2><p>Подтверждаем вход для Android-приложения...</p>');

      var initData = String(tg.initData || "") || (await waitInitData(8000));
      if (!initData) {
        throw new Error("init_data_missing");
      }

      var resp = await fetch('/api/v2/auth/telegram/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ init_data: initData, device_id: 'android-bridge' })
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok || !data.code) {
        throw new Error(String(data.error || ('http_' + resp.status)));
      }

      var origin = String(window.location.origin || '').trim();
      var bridgeUrl =
        origin + '/android-auth-return.html' +
        '?code=' + encodeURIComponent(data.code);

      try {
        if (tg.openLink) tg.openLink(bridgeUrl);
        else window.location.href = bridgeUrl;
      } catch (_) {
        window.location.href = bridgeUrl;
      }

      setTimeout(function () {
        setHtml(
          '<h2 style="margin:0 0 8px;">RP Market</h2>' +
          '<p style="margin:0 0 12px;">Если возврат не произошёл автоматически, нажмите:</p>' +
          '<a href="' + bridgeUrl + '" style="display:inline-block;padding:10px 14px;background:#1e82f2;color:#fff;border-radius:10px;text-decoration:none;">Продолжить вход</a>'
        );
      }, 1200);
    } catch (e) {
      setHtml(
        '<h2 style="margin:0 0 8px;">RP Market</h2>' +
        '<p style="margin:0 0 12px;">Ошибка Android-входа: ' + String((e && e.message) || e) + '</p>' +
        '<button onclick="location.reload()" style="padding:10px 14px;border:0;background:#1e82f2;color:#fff;border-radius:10px;">Повторить</button>'
      );
    }
  }

  run();
})();
