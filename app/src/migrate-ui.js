// "Switch to the new Recharge updater": runs the migration (backend: commands/migrate.rs, "migrate-progress" events) and, if nothing arrives for IDLE_MS or the hand-over never closes this window, says so instead of hanging.
const IDLE_MS = 3 * 60 * 1000;
const START_FROM_MENU = 'The new Recharge is installed - start it from your apps menu (Recharge).';

export async function runMigrate() {
  const { invoke } = window.__TAURI__.core;
  const btn = document.getElementById('migrate-btn');
  const out = document.getElementById('launcher-update-progress');
  const row = document.getElementById('migrate-cleanup-row');
  const cleanup = !!row && !row.hidden && document.getElementById('migrate-cleanup').checked;
  btn.disabled = true;
  out.hidden = false;
  out.textContent = 'Downloading the new Recharge and setting it up - this window will close and reopen.';

  let last = Date.now();
  let phase = '';
  let unlisten = null;
  try {
    unlisten = await window.__TAURI__.event.listen('migrate-progress', (e) => {
      last = Date.now();
      phase = e.payload?.phase || phase;
      if (e.payload?.message) out.textContent = e.payload.message;
    });
  } catch { /* no events: the timeout below still applies */ }
  const watchdog = setInterval(() => {
    if (Date.now() - last > IDLE_MS) {
      clearInterval(watchdog);
      out.textContent = phase === 'handover' || phase === 'done' ? START_FROM_MENU : 'The download seems stuck. Check your connection and try again.';
      btn.disabled = false;
    }
  }, 5000);
  try {
    const hint = await invoke('migrate_to_launcher', { cleanup });
    // Normally the app exits right after this; reaching here means the window outlived the hand-over.
    out.textContent = START_FROM_MENU + (hint ? ' ' + hint : '');
  } catch (err) {
    btn.disabled = false;
    out.textContent = String(err);
  } finally {
    clearInterval(watchdog);
    if (unlisten) unlisten();
  }
}
