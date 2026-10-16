// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Port of the UniFi Access developer API on the console.
export const DEFAULT_PORT = 12445;

export const DEFAULT_CONFIG = {
  host: '',
  api_token: '',
  allow_self_signed: false,
  allow_remote_unlock: false,
  language: 'fr',
};

/**
 * Parse the console address typed by the user: an IP or a name, with an
 * optional port (`192.0.2.1`, `192.0.2.1:12445`, `unifi.local`), or a URL
 * copied from the browser (`https://192.0.2.1/access/`). The path is dropped,
 * the port defaults to the developer API one.
 * @param {unknown} raw
 * @returns {{ hostname: string, port: number }|null} null when unusable
 */
export function parseHost(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs.
  if (url.username || url.password) {
    return null;
  }
  // The console web interface (443) does not serve the developer API: a URL
  // copied from the browser without a port means the API port.
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  return { hostname: url.hostname, port };
}

/** `host:port` as shown to the user and in the logs (never a token). */
export const describeHost = ({ hostname, port }) =>
  `${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`;

const flag = (value) => value === true || value === 'true';

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const typedHost = typeof source.host === 'string' ? source.host.trim() : '';
  return {
    host: parseHost(typedHost),
    hostTyped: typedHost !== '',
    // A token is pasted: only the surrounding blanks are dropped.
    token: typeof source.api_token === 'string' ? source.api_token.trim() : '',
    allowSelfSigned: flag(source.allow_self_signed),
    allowRemoteUnlock: flag(source.allow_remote_unlock),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
