import { isRetryableAuthError } from "./authErrors";
import { supabase } from "./supabaseClient";
import type { Session } from "@supabase/supabase-js";

let refreshPromise: Promise<Session | null> | null = null;

export function showComplianceNotice(code: string) {
  const eventName = code === "terms_acceptance_required" ? "ws-terms-required" : code === "age_confirmation_required" ? "ws-age-required" : null;
  if (!eventName) return;
  window.dispatchEvent(new Event(eventName));
  if (window.parent !== window) {
    try { window.parent.dispatchEvent(new Event(eventName)); } catch { /* standalone room */ }
  }
}

function buildApiUrl(input: RequestInfo) {
  const baseUrl = import.meta.env.VITE_BASE_URL || "";
  return typeof input === "string"
    ? `${baseUrl.replace(/\/$/, "")}/${input.replace(/^\//, "")}`
    : input;
}

async function fetchWithAccessToken(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string | undefined
) {
  const headers = new Headers(init?.headers);
  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }

  const response = await fetch(buildApiUrl(input), { ...init, headers });
  if (response.status === 451) {
    window.dispatchEvent(new Event("ws-region-unavailable"));
    // The arcade's rooms are same-origin frames; their notices belong to the station.
    if (window.parent !== window) {
      try { window.parent.dispatchEvent(new Event("ws-region-unavailable")); } catch { /* standalone room */ }
    }
  }
  if (response.status === 403) {
    const body = await response.clone().json().catch(() => ({}));
    showComplianceNotice(body.code);
  }
  return response;
}

function refreshSessionOnce(refreshToken: string) {
  if (!refreshPromise) {
    refreshPromise = supabase.auth
      .refreshSession({ refresh_token: refreshToken })
      .then(async ({ data, error }) => {
        if (error || !data.session?.access_token) {
          if (!isRetryableAuthError(error)) {
            await supabase.auth.signOut({ scope: "local" });
          }
          return null;
        }

        return data.session;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

export async function fetchWithAuth(
  input: RequestInfo,
  init?: RequestInit
): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const response = await fetchWithAccessToken(input, init, session?.access_token);
  if (response.status !== 401 || !session) {
    return response;
  }

  const refreshedSession = await refreshSessionOnce(session.refresh_token);
  if (!refreshedSession?.access_token) {
    return response;
  }

  const retryResponse = await fetchWithAccessToken(
    input,
    init,
    refreshedSession.access_token
  );
  if (retryResponse.status === 401) {
    await supabase.auth.signOut({ scope: "local" });
  }
  return retryResponse;
}
