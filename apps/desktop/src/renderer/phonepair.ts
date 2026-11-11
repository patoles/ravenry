// The phone card's app code: shown only when phone access is on and the
// pairing names somewhere a phone can reach this computer (a Wi-Fi or
// Tailscale address, or RAVENRY_PHONE_HOSTS). With none, the card says so
// instead of a code that pairs with nothing (PHONE-011, as the Mac app).

export interface PairApp { hosts?: string[] | null }

export function pairable<T extends PairApp>(access: boolean | undefined, app: T | null | undefined): T | null {
  if (!access || !app) return null;
  return Array.isArray(app.hosts) && app.hosts.length === 0 ? null : app;
}
