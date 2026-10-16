// Where the Recharge hub lives. Defaults to the real hub; for testing against a local hub set the localStorage key
// `rechargeHubBase` (e.g. localStorage.setItem('rechargeHubBase', 'http://127.0.0.1:8099/recharge')). Only http(s) URLs are accepted.
export const DEFAULT_HUB_BASE = 'https://codecade.co.za/recharge';
export const HUB_OVERRIDE_KEY = 'rechargeHubBase';

export function resolveHubBase(stored) {
  const s = String(stored || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(s) ? s : DEFAULT_HUB_BASE;
}

function readOverride() {
  try { return globalThis.localStorage?.getItem(HUB_OVERRIDE_KEY) || ''; } catch { return ''; }
}

export const HUB_BASE = resolveHubBase(readOverride());
