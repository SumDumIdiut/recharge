import { h } from '../dom.js';
import { describeError } from '../bridge.js';
import { selectControl } from '../components/select.js';
import { button } from '../components/button.js';
import { toast } from '../components/toast.js';
import { formatBytes, getSettings, saveSettings, updateCheck, updateDownload, updateRestart, updateSetChannel, updateStatus } from './api.js';
import { lastCheckLine } from '../lib/updateInfo.js';
import { panel, row, setSwitch, switchControl, wrap, type Section } from './ui.js';

export function updatesSection(): Section {
  const version = h('span', { className: 'path-value', text: '…' });
  const result = h('div', { className: 'setting-hint', text: 'Not checked yet.' });
  const actions = h('div', { className: 'settings-row-wrap' });
  const note = h('div', { className: 'setting-hint' });

  function restartButton(): HTMLButtonElement {
    const restart = button('Restart to update', {
      kind: 'primary',
      icon: 'refresh',
      onClick: () => {
        restart.disabled = true;
        void updateRestart().catch((e) => {
          restart.disabled = false;
          toast('Could not restart: ' + describeError(e), 'error');
        });
      },
    });
    return restart;
  }

  async function status(): Promise<void> {
    try {
      const s = await updateStatus();
      version.textContent = s.version + (s.build ? ' (build ' + s.build + ')' : '');
      note.textContent = s.managed ? 'Updates are handled by the Recharge launcher.' : 'Checks ' + s.url;
      result.textContent = s.failure || lastCheckLine(s, Date.now());
      actions.replaceChildren();
      if (s.ready) actions.appendChild(restartButton());
    } catch (e) {
      version.textContent = 'unavailable (' + describeError(e) + ')';
    }
  }

  const check = button('Check now', {
    kind: 'primary',
    icon: 'refresh',
    onClick: () => void doCheck(),
  });
  async function doCheck(): Promise<void> {
    check.disabled = true;
    actions.replaceChildren();
    result.textContent = 'Checking…';
    try {
      const r = await updateCheck();
      if (r.state === 'available') {
        result.textContent = 'Version ' + r.version + ' is available (' + formatBytes(r.downloadBytes) + ' to download).';
        const download = button('Download', {
          kind: 'primary',
          icon: 'download',
          onClick: () => {
            download.disabled = true;
            result.textContent = 'Downloading…';
            void updateDownload().then(
              () => {
                toast('Update downloaded.', 'success');
                return status();
              },
              (e) => {
                result.textContent = 'Download failed: ' + describeError(e);
                download.disabled = false;
              }
            );
          },
        });
        actions.appendChild(download);
      } else {
        await status();
      }
    } catch (e) {
      result.textContent = 'Could not check: ' + describeError(e);
    } finally {
      check.disabled = false;
    }
  }

  const channelHost = h('div');
  void getSettings().then(
    (s) =>
      channelHost.appendChild(
        selectControl(
          [
            { value: 'stable', label: 'Stable' },
            { value: 'beta', label: 'Beta' },
          ],
          {
            value: s.updateChannel,
            onChange: (value) =>
              void updateSetChannel(value as 'stable' | 'beta').then(
                () => status(),
                (e) => toast(describeError(e), 'error')
              ),
          }
        )
      ),
    () => undefined
  );

  const autoHost = h('div');
  void getSettings().then(
    (s) => {
      const toggle = switchControl('Update automatically', s.autoUpdate !== false, (next) => {
        setSwitch(toggle, next);
        void saveSettings({ autoUpdate: next }).then(
          () => undefined,
          (e) => {
            setSwitch(toggle, !next);
            toast(describeError(e), 'error');
          }
        );
      });
      autoHost.appendChild(toggle);
    },
    () => undefined
  );

  const resultRow = row('Check for updates', '', wrap(check));
  resultRow.querySelector('.setting-copy')?.append(result, note);
  resultRow.querySelector('.setting-control')?.appendChild(actions);
  void status();
  return {
    node: panel(
      'Updates',
      row('Current version', '', version),
      row('Channel', 'Stable gets tested releases; Beta gets new things first.', channelHost),
      row('Update automatically', 'Check at start-up and every 6 hours, and download in the background.', autoHost),
      resultRow
    ),
  };
}
