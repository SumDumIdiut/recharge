/**
 * The node creator: a dialog that composes a NodeManifest from a form (identity, options, appearance, behaviours),
 * validates it through parseManifest, and registers + persists it so it shows in the picker. Custom nodes are data
 * only - the form can only pick whitelisted behaviours and bind their params to the node's own options.
 */
import { h } from '../../dom.js';
import { modal } from '../../components/modal.js';
import { toast } from '../../components/toast.js';
import { BEHAVIORS, behaviorDef, type ParamSpec } from './behaviors.js';
import { parseManifest, PLACEMENTS, type OptionType } from './manifest.js';
import { addCustomNode, nodeById } from './registry.js';

interface OptionRow { key: string; label: string; type: OptionType; def: string }
interface ParamBind { bind: string; literal: string } // bind: '' = literal, else an option key
interface BehaviorRow { id: string; params: Record<string, ParamBind> }

const OPTION_TYPES: OptionType[] = ['number', 'bool', 'text'];

function slug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'node';
  let id = base, n = 2;
  while (nodeById(id)) id = base + '-' + n++;
  return id;
}

const input = (value: string, attrs: Record<string, string> = {}): HTMLInputElement =>
  h('input', { className: 'settings-input', attrs: { type: 'text', value, ...attrs } }) as HTMLInputElement;

function select(value: string, choices: Array<{ value: string; label: string }>): HTMLSelectElement {
  const s = h('select', { className: 'settings-input' }) as HTMLSelectElement;
  for (const c of choices) s.appendChild(h('option', { attrs: { value: c.value }, text: c.label }));
  s.value = value;
  return s;
}

/** Open the node creator. `onCreated` is called after a node is made (so the picker can rebuild). */
export function openNodeCreator(onCreated: () => void): void {
  const options: OptionRow[] = [];
  const behaviors: BehaviorRow[] = [];

  const form = h('div', { className: 'node-creator' });

  // identity
  const name = input('', { placeholder: 'My launch pad' });
  const icon = input('◆', { maxlength: '2' });
  const place = select('cell', PLACEMENTS.map((p) => ({ value: p, label: p })));
  const color = h('input', { className: 'node-color', attrs: { type: 'color', value: '#5fd4a0' } }) as HTMLInputElement;
  form.append(
    field('Name', name),
    field('Icon', icon),
    field('Placement', place),
    field('Colour', color),
  );

  // options
  const optsBox = h('div', { className: 'node-list' });
  const renderOptions = (): void => {
    optsBox.replaceChildren();
    options.forEach((o, i) => {
      const key = input(o.label, { placeholder: 'Option name' });
      key.addEventListener('input', () => { o.label = key.value; o.key = slugKey(key.value); renderBehaviors(); });
      const ty = select(o.type, OPTION_TYPES.map((t) => ({ value: t, label: t })));
      ty.addEventListener('change', () => { o.type = ty.value as OptionType; });
      const def = input(o.def, { placeholder: 'default' });
      def.addEventListener('input', () => { o.def = def.value; });
      const del = h('button', { className: 'node-del', attrs: { type: 'button', title: 'Remove' }, text: '×' });
      del.addEventListener('click', () => { options.splice(i, 1); renderOptions(); renderBehaviors(); });
      optsBox.appendChild(h('div', { className: 'node-row' }, key, ty, def, del));
    });
  };
  const addOpt = h('button', { className: 'node-add', attrs: { type: 'button' }, text: '+ Option' });
  addOpt.addEventListener('click', () => { options.push({ key: 'option' + (options.length + 1), label: 'Option ' + (options.length + 1), type: 'number', def: '0' }); renderOptions(); renderBehaviors(); });
  form.append(section('Options (tunable in the Properties panel)', optsBox, addOpt));

  // behaviours
  const behBox = h('div', { className: 'node-list' });
  const renderBehaviors = (): void => {
    behBox.replaceChildren();
    behaviors.forEach((b, i) => {
      const def = behaviorDef(b.id)!;
      const pick = select(b.id, BEHAVIORS.map((d) => ({ value: d.id, label: d.label })));
      pick.addEventListener('change', () => { b.id = pick.value; b.params = {}; renderBehaviors(); });
      const del = h('button', { className: 'node-del', attrs: { type: 'button', title: 'Remove' }, text: '×' });
      del.addEventListener('click', () => { behaviors.splice(i, 1); renderBehaviors(); });
      const rows = h('div', { className: 'node-params' });
      for (const spec of def.params) rows.appendChild(paramRow(b, spec, options));
      behBox.appendChild(h('div', { className: 'node-behavior' }, h('div', { className: 'node-row' }, pick, del), rows));
    });
  };
  const addBeh = h('button', { className: 'node-add', attrs: { type: 'button' }, text: '+ Behaviour' });
  addBeh.addEventListener('click', () => { behaviors.push({ id: BEHAVIORS[0].id, params: {} }); renderBehaviors(); });
  form.append(section('Behaviours (what it does)', behBox, addBeh));

  const errors = h('div', { className: 'node-errors', hidden: true });
  form.appendChild(errors);

  renderOptions();
  renderBehaviors();

  const tryCreate = (): boolean => {
    const nm = name.value.trim();
    if (!nm) { showErrors(errors, ['Give the node a name.']); return false; }
    const raw = buildManifest(nm, icon.value, place.value, color.value, options, behaviors);
    const { manifest, errors: errs } = parseManifest(raw);
    if (!manifest || errs.length) { showErrors(errors, errs.length ? errs : ['Could not build the node.']); return false; }
    addCustomNode(manifest);
    toast('Created node "' + manifest.label + '"', 'success');
    onCreated();
    return true;
  };

  modal({
    title: 'New node',
    body: form,
    actions: [{ label: 'Create', kind: 'primary', onClick: tryCreate }, { label: 'Cancel' }],
  });
}

function paramRow(b: BehaviorRow, spec: ParamSpec, options: OptionRow[]): HTMLElement {
  const bind = (b.params[spec.key] ||= { bind: '', literal: String(spec.def) });
  const where = select(bind.bind, [{ value: '', label: 'value' }, ...options.map((o) => ({ value: o.key, label: 'from: ' + (o.label || o.key) }))]);
  const lit = input(bind.literal, { placeholder: String(spec.def) });
  const sync = (): void => { lit.style.display = where.value ? 'none' : ''; };
  where.addEventListener('change', () => { bind.bind = where.value; sync(); });
  lit.addEventListener('input', () => { bind.literal = lit.value; });
  sync();
  return h('div', { className: 'node-row' }, h('span', { className: 'node-param-key', text: spec.key }), where, lit);
}

function buildManifest(name: string, icon: string, place: string, color: string, options: OptionRow[], behaviors: BehaviorRow[]): unknown {
  const opts = options.filter((o) => o.key).map((o) => ({ key: o.key, label: o.label || o.key, type: o.type, default: coerce(o.type, o.def) }));
  const zone = place === 'zone';
  return {
    id: slug(name), label: name, category: 'Custom', icon: icon || '◆', place,
    options: opts,
    appearance: [zone ? { zone: true, glyph: icon, color } : { glyph: icon, color }],
    build: {
      collider: { shape: 'box', trigger: true },
      behaviors: behaviors.map((b) => ({ behavior: b.id, event: 'enter', params: paramsOf(b) })),
    },
  };
}

function paramsOf(b: BehaviorRow): Record<string, unknown> {
  const def = behaviorDef(b.id);
  const out: Record<string, unknown> = {};
  if (!def) return out;
  for (const spec of def.params) {
    const bind = b.params[spec.key];
    if (bind?.bind) out[spec.key] = { option: bind.bind };
    else out[spec.key] = coerce(spec.type, bind?.literal ?? String(spec.def));
  }
  return out;
}

function coerce(type: string, v: string): unknown {
  if (type === 'number') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  if (type === 'bool') return v === 'true' || v === '1' || v === 'yes';
  return v;
}

const slugKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 32) || 'opt';

function field(label: string, control: HTMLElement): HTMLElement {
  return h('label', { className: 'node-field' }, h('span', { className: 'node-field-label', text: label }), control);
}
function section(title: string, list: HTMLElement, add: HTMLElement): HTMLElement {
  return h('div', { className: 'node-section' }, h('div', { className: 'node-section-title', text: title }), list, add);
}
function showErrors(el: HTMLElement, errs: string[]): void {
  el.replaceChildren(...errs.slice(0, 6).map((e) => h('div', { text: '• ' + e })));
  el.hidden = false;
}
