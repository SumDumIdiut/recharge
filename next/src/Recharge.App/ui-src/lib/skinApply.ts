// Wearing an installed skin from the app. With the game running the skin switches live (the `skin.apply` intent, sent through
// `game.intent`); otherwise the choice is written to the Skins module's config and takes effect on the next launch.
import { call, describeError } from '../bridge.js';
import { button } from '../components/button.js';
import { toast } from '../components/toast.js';

export type ApplyMode = 'live' | 'next';

/** Whether the game is running and linked to the app (`game.state` → { running }); false whenever that cannot be told. */
export async function gameRunning(): Promise<boolean> {
  try {
    const state = await call<{ running?: unknown }>('game.state', {});
    return !!state && state.running === true;
  } catch {
    return false;
  }
}

/** The label of the apply button for a game state. */
export function applyLabel(running: boolean): string {
  return running ? 'Apply' : 'Apply on next launch';
}

/** The message after an apply: what happened to the skin called `name`. */
export function appliedMessage(mode: ApplyMode, name: string): string {
  return mode === 'live' ? name + ' applied' : name + ' will be worn on the next launch';
}

/** Applies a skin folder (null for the vanilla look): live through the game's link when it answers, else into the config. */
export async function applySkin(folder: string | null): Promise<ApplyMode> {
  try {
    await call('game.intent', { kind: 'skin.apply', args: { folder } });
    return 'live';
  } catch {
    // no game connected (or the link command is not there): fall through to the config
  }
  await call('skin.applyNext', { folder });
  return 'next';
}

/** The skin folder the config says is worn, or null (vanilla / unknown). */
export async function currentSkinFolder(): Promise<string | null> {
  try {
    const reply = await call<{ folder?: unknown }>('skin.current', {});
    return typeof reply.folder === 'string' ? reply.folder : null;
  } catch {
    return null;
  }
}

/** An Apply button for one installed skin. `onApplied` runs after a successful apply. */
export function skinApplyButton(folder: string, name: string, onApplied?: (mode: ApplyMode) => void): HTMLButtonElement {
  const apply = button(applyLabel(false), { kind: 'secondary', icon: 'check', title: 'Wear this skin: live when the game is running, otherwise from the next launch' });
  const label = apply.querySelector('span') as HTMLElement;
  void gameRunning().then((running) => { label.textContent = applyLabel(running); });
  apply.addEventListener('click', () => {
    apply.disabled = true;
    applySkin(folder).then(
      (mode) => { toast(appliedMessage(mode, name), 'success'); apply.disabled = false; onApplied?.(mode); },
      (error) => { toast(describeError(error), 'error'); apply.disabled = false; });
  });
  return apply;
}
