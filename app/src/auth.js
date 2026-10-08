const TOKEN_KEY = 'rechargeAuthToken';
const USERNAME_KEY = 'rechargeAuthUsername';
const ADMIN_KEY = 'rechargeAuthAdmin';
const EXPIRED_KEY = 'rechargeSessionExpired';
const HUB_BASE = 'https://codecade.co.za/recharge';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getUsername() {
  try {
    return localStorage.getItem(USERNAME_KEY);
  } catch {
    return null;
  }
}

export function isAdmin() {
  try {
    return localStorage.getItem(ADMIN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSession(token, username, admin = false) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USERNAME_KEY, username);
    localStorage.setItem(ADMIN_KEY, admin ? '1' : '0');
  } catch {
    /* localStorage unavailable - session just won't persist across restarts */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
    localStorage.removeItem(ADMIN_KEY);
  } catch {
    /* ignore */
  }
}

export function isLoggedIn() {
  return !!getToken();
}

export const EXPIRED_MESSAGE = 'Your login expired - log in again.';

// Set when the hub rejected the stored token, until the login dialog has shown the note once.
export function sessionExpired() {
  try {
    return localStorage.getItem(EXPIRED_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearExpiredNote() {
  try {
    localStorage.removeItem(EXPIRED_KEY);
  } catch {
    /* ignore */
  }
}

function markExpired() {
  try {
    localStorage.setItem(EXPIRED_KEY, '1');
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent('session-expired', { detail: EXPIRED_MESSAGE }));
  } catch {
    /* no window (tests) */
  }
}

// Asks the hub who this token belongs to (the login response doesn't say
// whether the account is an admin). Only a 401 ends the session - being
// offline just keeps whatever was stored, so "logged in" only ever lies while offline.
// Returns 'expired' when the stale session was cleared.
export async function refreshSession(fetchFn = (...a) => fetch(...a)) {
  const token = getToken();
  if (!token) return 'none';
  try {
    const res = await fetchFn(`${HUB_BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      clearSession();
      markExpired();
      return 'expired';
    }
    if (!res.ok) return 'unchecked';
    const me = await res.json();
    setSession(token, me.username, !!me.admin);
    return 'ok';
  } catch {
    return 'unchecked'; /* offline - keep the stored session */
  }
}
