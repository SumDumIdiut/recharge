const TOKEN_KEY = 'rechargeAuthToken';
const USERNAME_KEY = 'rechargeAuthUsername';
const ADMIN_KEY = 'rechargeAuthAdmin';
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

// Asks the hub who this token belongs to (the login response doesn't say
// whether the account is an admin). Only a 401 ends the session - being
// offline just keeps whatever was stored.
export async function refreshSession() {
  const token = getToken();
  if (!token) return;
  try {
    const res = await fetch(`${HUB_BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) return clearSession();
    if (!res.ok) return;
    const me = await res.json();
    setSession(token, me.username, !!me.admin);
  } catch {
    /* offline - keep the stored session */
  }
}
