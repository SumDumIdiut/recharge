// Settings > Appearance: the theme picker (one radio card per theme, with a small preview).
import { getThemeChoice, setThemeChoice, getEventOn, isForcedOn, onThemeChange, isHalloween } from '../halloween.js';
import { getMusicOn, setMusicOn, getMusicVolume, setMusicVolume } from '../halloween-music.js';

export function renderThemePicker(doc = document) {
  const eventOn = getEventOn();
  // An unset choice follows the event; a saved Halloween choice shows as Classic while the event is off.
  const current = eventOn && getThemeChoice() !== 'classic' ? 'halloween' : 'classic';
  for (const card of doc.getElementById('theme-picker').querySelectorAll('[data-theme-choice]')) {
    const kind = card.dataset.themeChoice;
    const disabled = kind === 'halloween' && !eventOn;
    card.disabled = disabled;
    card.setAttribute('aria-checked', String(kind === current));
    card.querySelector('.theme-card-tag').textContent = disabled ? 'Event not running' : kind === current ? 'Selected' : '';
  }
  const note = doc.getElementById('theme-note');
  note.hidden = eventOn && !isForcedOn();
  const row = doc.getElementById('halloween-music-row');
  if (row) {
    row.hidden = !isHalloween();
    doc.getElementById('halloween-music').checked = getMusicOn();
    doc.getElementById('halloween-music-volume').value = String(Math.round(getMusicVolume() * 100));
  }
  note.textContent = isForcedOn() ? 'Test build: event forced on locally.' : 'Halloweencharge 2026: event not running.';
}

export function initThemePicker(doc = document) {
  const picker = doc.getElementById('theme-picker');
  picker.onclick = (e) => {
    const card = e.target.closest?.('[data-theme-choice]');
    if (card && !card.disabled) setThemeChoice(card.dataset.themeChoice);
  };
  picker.onkeydown = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const cards = [...picker.querySelectorAll('[data-theme-choice]')].filter((c) => !c.disabled);
    const i = cards.indexOf(doc.activeElement);
    if (i >= 0 && cards.length) { e.preventDefault(); cards[(i + (e.key === 'ArrowRight' ? 1 : cards.length - 1)) % cards.length].focus(); }
  };
  const box = doc.getElementById('halloween-music');
  const vol = doc.getElementById('halloween-music-volume');
  if (box) box.onchange = () => setMusicOn(box.checked);
  if (vol) vol.oninput = () => setMusicVolume(Number(vol.value) / 100);
  onThemeChange(() => renderThemePicker(doc));
  renderThemePicker(doc);
}
