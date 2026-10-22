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
      var startParam = String((tg.initDataUnsafe && tg.initDataUnsafe.start_param) || "");
      if (startParam.indexOf("android_device_") !== 0) {
        setHtml('<h2 style="margin:0 0 8px;">RP Market</h2><p>Неверный параметр входа.</p>');
        return;
      }
      var attemptId = startParam.slice("android_device_".length);
      if (!attemptId) {
        setHtml('<h2 style="margin:0 0 8px;">RP Market</h2><p>Попробуйте войти снова из приложения.</p>');
        return;
      }

      setHtml('<h2 style="margin:0 0 8px;">RP Market</h2><p>Подтверждаем вход...</p>');

      var initData = String(tg.initData || "") || (await waitInitData(8000));
      if (!initData) {
        throw new Error("init_data_missing");
      }

      var resp = await fetch('/api/v2/auth/telegram/device/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          init_data: initData,
          attempt_id: attemptId
        })
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok || !data.ok) {
        throw new Error(String(data.error || ('http_' + resp.status)));
      }

      setHtml(
        '<h2 style="margin:0 0 8px;">RP Market</h2>' +
        '<p style="margin:0 0 12px;">Вход подтверждён. Вернитесь в приложение или на сайт.</p>' +
        '<button onclick="window.close()" style="padding:10px 14px;border:0;background:#1e82f2;color:#fff;border-radius:10px;">Готово</button>'
      );
      try { if (tg.close) tg.close(); } catch (_) {}
    } catch (e) {
      setHtml(
        '<h2 style="margin:0 0 8px;">RP Market</h2>' +
        '<p style="margin:0 0 12px;">Ошибка подтверждения: ' + String((e && e.message) || e) + '</p>' +
        '<button onclick="location.reload()" style="padding:10px 14px;border:0;background:#1e82f2;color:#fff;border-radius:10px;">Повторить</button>'
      );
    }
  }

  run();
})();
