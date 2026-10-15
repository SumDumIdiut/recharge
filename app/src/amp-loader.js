// Opens the Amplifier from the downloaded copy (commands/amp.rs) when there is a usable one, else from the built-in files; a downloaded copy that fails to load or mount is marked bad and the built-in one opens instead.
// Everything it touches is passed in, so tests can drive it without a browser.
const BUILTIN = '/maps/editor.js';

// deps: { invoke(cmd, args), importModule(url), addStyle(href) -> remove(), warn(msg) }
export async function openAmplifier(root, deps) {
  let info = null;
  try { info = await deps.invoke('amp_status'); } catch { /* an older app without amp_status: built-in */ }
  if (info && info.active && info.url && info.version) {
    let removeStyle = () => {};
    try {
      // The downloaded stylesheet goes on top of the built-in one, so a restyled editor matches its own markup.
      try { removeStyle = deps.addStyle(info.url + 'style.css') || removeStyle; } catch { /* the built-in styles still apply */ }
      const m = await deps.importModule(info.url + 'editor.js');
      await m.mountEditor(root);
      return { version: info.version, fallback: false, module: m };
    } catch (e) {
      deps.warn?.(`Amplifier ${info.version} failed (${e && e.message || e}), using the built-in one`);
      removeStyle();
      try { await deps.invoke('amp_mark_bad', { version: info.version }); } catch { /* still falls back this time */ }
      root.replaceChildren?.();
      root.innerHTML = '';
    }
  }
  const m = await deps.importModule(BUILTIN);
  await m.mountEditor(root);
  return { version: null, fallback: !!(info && info.active), module: m };
}
