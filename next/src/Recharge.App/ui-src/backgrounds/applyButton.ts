import { button } from '../components/button.js';
import { toast } from '../components/toast.js';
import { describeError } from '../bridge.js';
import { useAsBackground } from './apply.js';

/** "Use as background" for an installed background or playlist, shown in its Library detail panel. */
export function backgroundApplyButton(kind: 'backgrounds' | 'playlists', folder: string, name: string): HTMLButtonElement {
  const apply = button('Use as background', { kind: 'secondary', icon: 'image', title: 'Show ' + name + ' behind the app' });
  apply.addEventListener('click', () => {
    apply.disabled = true;
    useAsBackground(kind, folder).then(
      (note) => {
        apply.disabled = false;
        if (note) toast(note, 'error');
        else toast(name + ' is now your background', 'success');
      },
      (error) => {
        apply.disabled = false;
        toast(describeError(error), 'error');
      }
    );
  });
  return apply;
}
