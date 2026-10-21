/**
 * Canonical public HTTP(S) root parsing, mirrored from
 * `@deepseek-ai/dsh-web-app`'s internal `public-url` module (the package
 * exposes no public subpath for it). This code is duplicated on purpose: the
 * custom `web-startup` must reject the same hazards the stock startup rejects
 * before the value reaches the stock `web-runtime` config schema.
 *
 * Keep behavior-compatible with the upstream validator and re-diff it on
 * every dsh upgrade.
 */

/**
 * Parse the advertised public HTTP(S) root of a prefix-stripping proxy
 * deployment, rejecting the hazards WHATWG URL parsing would accept on its
 * own, then normalize the path to end in `/`.
 * @param value advertised public HTTP(S) root.
 * @param label field name or CLI flag included in rejection messages.
 * @returns the parsed URL with a trailing-slash pathname.
 * @throws when the value is not a usable advertised root, naming the reason.
 */
export function parsePublicUrl(value: string, label = 'publicUrl'): URL {
  if (/[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error(`${label} must not contain ASCII whitespace or control characters`)
  }
  if (!/^https?:\/\//iu.test(value)) {
    throw new Error(`${label} must be an absolute http or https URL of the form http(s)://host[/prefix]`)
  }
  if (value.includes('?') || value.includes('#')) {
    throw new Error(`${label} must not include a query or fragment (? or #)`)
  }
  // Userinfo lives in the raw authority (before the first path slash); the
  // empty-authority forms (`https://`, `https:///ui`, `http:///ui`) fail here too.
  const [authority = ''] = value.slice(value.indexOf('://') + 3).split(/[/\\]/, 1)
  if (authority === '') {
    throw new Error(`${label} must name a host after http:// or https://`)
  }
  if (authority.includes('@')) {
    throw new Error(`${label} must not include credentials (a username or password before @, including an empty user)`)
  }
  const url = URL.parse(value)
  if (url === null) throw new Error(`${label} must be an absolute http or https URL`)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}
