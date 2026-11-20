// Configurazione dell'accesso: provider GitHub con le credenziali dell'app, site URL e redirect
// su loopback (le dieci porte che l'app prova in ordine: apps/desktop/src-tauri/README.md).

export const LOOPBACK_PORTS = Array.from({ length: 10 }, (_, i) => 53682 + i);
export const loopbackUrls = () => LOOPBACK_PORTS.map((p) => `http://127.0.0.1:${p}/callback`);
export const SITE_URL = loopbackUrls()[0];

/** `uri_allow_list` è una stringa separata da virgole: si conservano gli indirizzi già presenti. */
export function mergeAllowList(existing) {
  const current = String(existing ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...current, ...loopbackUrls()])].join(',');
}

export function buildAuthPatch({ existingAllowList, clientId, clientSecret }) {
  return {
    site_url: SITE_URL,
    uri_allow_list: mergeAllowList(existingAllowList),
    external_github_enabled: true,
    external_github_client_id: clientId,
    external_github_secret: clientSecret,
  };
}
