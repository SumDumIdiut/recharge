// Runs first on every load. The built-in screens hand over to the live copy
// (kept fresh from the repo) when one is active; the live copy confirms it
// loaded so a broken handover can't strand anyone on it.
(function () {
  var LIVE_ORIGIN = 'http://127.0.0.1:39285';
  var t = window.__TAURI__;
  var invoke = t && t.core && t.core.invoke;
  if (!invoke) return;

  if (location.origin === LIVE_ORIGIN) {
    // Browser storage is per origin, so settings and the login come across
    // once from the built-in screens.
    invoke('live_take_stash').then(function (json) {
      if (json) {
        try {
          var data = JSON.parse(json);
          for (var k in data) if (localStorage.getItem(k) === null) localStorage.setItem(k, data[k]);
          location.reload();
          return;
        } catch (e) {}
      }
      invoke('live_ack').catch(function () {});
    }).catch(function () {});
    return;
  }

  if (/[?&]embedded=1/.test(location.search)) return;
  invoke('live_status', { redirect: true }).then(function (s) {
    if (!s || !s.active) return;
    var data = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      data[k] = localStorage.getItem(k);
    }
    return invoke('live_stash', { json: JSON.stringify(data) }).then(function () {
      location.replace(s.url);
    });
  }).catch(function () {});
})();
