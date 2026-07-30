/**
 * Centralized API fetch helper with optional dashboard token auth.
 *
 * When the backend has `dashboard_token` configured, all `/dashboard/api/*`
 * endpoints require `Authorization: Bearer <token>`. This module stores the
 * token in sessionStorage (cleared when the browser tab closes, reducing
 * exposure) and automatically attaches the header to every request. On 401,
 * a `dashboard:unauthorized` event is dispatched so the TokenGate component
 * can prompt for the token.
 */

const TOKEN_KEY = "umans-gate:dashboard-token";
export const UNAUTHORIZED_EVENT = "dashboard:unauthorized";

export function getDashboardToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setDashboardToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // sessionStorage may be unavailable (private mode, etc.)
  }
}

export function clearDashboardToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

/**
 * Fetch wrapper that adds the dashboard token header if one is stored.
 * On 401 responses, dispatches {@link UNAUTHORIZED_EVENT} so the TokenGate
 * can prompt the user.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = getDashboardToken();
  const headers = new Headers(init?.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(input, { cache: "no-store", ...init, headers });

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }

  return res;
}
