import { isIPv4, isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'

/**
 * dsh 0.2.1 rejects wildcard bind addresses inside
 * `@deepseek-ai/dsh-host-webserver`'s config schema, not only in its CLI.
 * This bundle exists to expose the Web UI on a wildcard bind, so it widens
 * the boot-path `WebServer.Config.host` member in place before the
 * `webserver` row validates its config.
 *
 * The schema object is shared by every holder of the package, and `dict` is a
 * plain writable object, so replacing the single `host` member keeps every
 * other field (port, tls, compression, ...) validating exactly as declared.
 *
 * One instance matters. The `webserver` row resolves the package from the
 * profile root, while a `link:`-installed plugin may import another copy from
 * its own node_modules. Widening the imported copy would change nothing at
 * boot, so {@link bootWebServer} resolves the package from the profile root
 * that `ctx.baseUrl` names.
 */

/** Package whose webserver schema the boot path validates against. */
const WEBSERVER_PACKAGE = '@deepseek-ai/dsh-host-webserver'

/** Marks a `host` schema member as already widened (idempotency per schema). */
const WIDENED = Symbol.for('dsh-public-access.host-widened')

/** Success is sticky; failures retry on the next call. */
let wildcardSupported = false

/**
 * Whether a schema member already carries our widening.
 * @param value candidate schema member.
 * @returns true when the member is the union we installed.
 */
function isWidenedMember(value) {
  return typeof value === 'function' && Reflect.get(value, WIDENED) === true
}

/**
 * Replace the `host` member of a schemastery object schema with a union that
 * accepts IPv4/IPv6 literals — including the wildcard binds the stock 0.2.1
 * member rejects. All other members, and every other consumer of the schema,
 * are untouched.
 * @param schema schemastery object schema with a `dict` property.
 * @returns whether the schema now accepts the extended host domain.
 */
export function widenHostMember(schema) {
  const dict = schema?.dict
  const host = dict?.host
  if (isWidenedMember(host)) return true
  if (
    dict === undefined ||
    typeof host !== 'function' ||
    typeof z.union !== 'function' ||
    typeof z.transform !== 'function' ||
    typeof z.ValidationError !== 'function'
  ) {
    return false
  }
  try {
    const widened = z.union([
      host,
      z.transform(z.string(), (value, options) => {
        if (!isIPv4(value) && !isIPv6(value)) {
          throw new z.ValidationError('expected an IPv4 or IPv6 literal', options)
        }
        return value
      })
    ])
    // A fresh union's meta is empty. The stock host member is `.required()`,
    // and a default-less non-required member lets a host-less config validate
    // (which would make listen(port, undefined) bind every interface).
    const meta = Reflect.get(host, 'meta')
    Reflect.set(widened, 'meta', meta !== null && typeof meta === 'object' ? { ...meta } : {})
    Reflect.set(widened, WIDENED, true)
    dict.host = widened
    return true
  } catch {
    return false
  }
}

/**
 * The webserver module instance the boot path validates configs against.
 *
 * A fake require anchored inside the profile root resolves the package the
 * same way the `webserver` row does. Without a base URL this returns
 * `undefined`; there is no useful imported fallback because a second module
 * instance has its own `WebServer.Config`.
 * @param baseUrl the cordis context's base URL (profile root at boot).
 * @returns the boot-path module, or undefined when it cannot be resolved.
 */
function bootWebServer(baseUrl) {
  if (baseUrl === undefined || baseUrl === null) return undefined
  try {
    const base = String(baseUrl)
    const anchor = base.endsWith('/') ? base : `${base}/`
    const require = createRequire(new URL('node_modules/.host-schema.cjs', anchor))
    const entry = require.resolve(WEBSERVER_PACKAGE)
    const loaded = require(entry)
    return loaded?.WebServer ?? loaded?.default?.WebServer ?? (typeof loaded === 'function' ? loaded : undefined)
  } catch {
    return undefined
  }
}

/**
 * Widen the boot-path webserver's `host` schema to accept wildcard and
 * literal binds. Safe to call repeatedly; never throws.
 * @param baseUrl the cordis context's base URL.
 * @returns whether an extended `--host` value will validate at boot.
 */
export function ensureWildcardBindSupport(baseUrl) {
  if (wildcardSupported) return true
  const target = bootWebServer(baseUrl)
  const widened = target?.Config !== undefined ? widenHostMember(target.Config) : false
  if (widened) wildcardSupported = true
  return widened
}

/**
 * Whether the boot-path webserver config declares the 0.2.1 `tls` field.
 * TLS and `--public-url` shipped in the same upstream line, so this one probe
 * gates both: on an older harness the flags would otherwise be accepted and
 * silently ignored.
 * @param baseUrl the cordis context's base URL.
 * @returns true when the boot-path schema has a `tls` member.
 */
export function supportsTlsConfig(baseUrl) {
  const dict = bootWebServer(baseUrl)?.Config?.dict
  return dict !== undefined && 'tls' in dict
}

/**
 * Canonical bare IPv6 literal for `value` (WHATWG normalization), or
 * `undefined` when the value is not an IPv6 literal the parser accepts.
 * Canonicalization matters because the connection fence validates every
 * `trustedHosts` entry through WHATWG parsing; a non-canonical spelling makes
 * the `connection` row throw at activation.
 * @param value candidate IPv6 literal, bare or bracketed.
 * @returns the canonical bare literal, or undefined.
 */
export function canonicalIpv6(value) {
  const literal = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  if (!isIPv6(literal)) return undefined
  try {
    return new URL(`http://[${literal}]`).hostname.slice(1, -1)
  } catch {
    return undefined
  }
}

/**
 * Whether a canonical IPv6 literal is IPv4-mapped. Node binds such a literal
 * as AF_INET, so clients arrive with a plain IPv4 `Host` that a bracketed
 * mapped-form fence entry can never match; the CLI refuses these instead.
 * @param canonical canonical bare IPv6 literal.
 * @returns true for `::ffff:...`.
 */
function isIpv4Mapped(canonical) {
  return canonical.startsWith('::ffff:')
}

/**
 * Normalize and validate a `--host` value.
 *
 * Accepts the wildcard binds (`0.0.0.0`, `::`), loopback, and concrete
 * IPv4/IPv6 literals. IPv6 is returned in canonical spelling so the bind and
 * the fence entry agree. DNS names, zone suffixes, and IPv4-mapped literals
 * are rejected.
 * @param value raw `--host` argument.
 * @returns the bare canonical host the webserver should bind.
 * @throws when the value is not a supported binding host.
 */
export function normalizeBindHost(value) {
  const host = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  if (host === '127.0.0.1' || host === '0.0.0.0') return host
  if (host.includes('%')) {
    throw new Error(`--host does not accept an interface zone id: ${JSON.stringify(value)}`)
  }
  if (isIPv4(host)) return host
  const canonical = canonicalIpv6(host)
  if (canonical !== undefined && !isIpv4Mapped(canonical)) return canonical
  if (canonical !== undefined) {
    throw new Error(
      `--host does not accept an IPv4-mapped IPv6 address (${JSON.stringify(value)}); use the equivalent IPv4 literal`
    )
  }
  throw new Error(
    `--host must be an IP literal: 127.0.0.1, 0.0.0.0, a concrete IPv4 address, or an IPv6 address without a zone (got ${JSON.stringify(value)})`
  )
}

/**
 * Fence authorities the stock 0.2.1 trust derivation no longer produces for a
 * wildcard bind. The list mirrors the surface the socket actually serves:
 * `0.0.0.0` gets every non-internal IPv4 address; `::` gets every
 * non-internal address (IPv6 bracketed, IPv4 plain); a concrete literal gets
 * its own authority. Loopback needs no entry.
 * @param bindHost the webserver's configured bind host.
 * @param interfaces optional interface table (tests).
 * @returns fence authorities to append; always canonical and port-less.
 */
export function lanHosts(bindHost, interfaces = networkInterfaces()) {
  if (bindHost === undefined) return []
  const bare = bindHost.startsWith('[') && bindHost.endsWith(']') ? bindHost.slice(1, -1) : bindHost
  if (bare === '127.0.0.1') return []
  if (isIPv4(bare)) {
    if (bare !== '0.0.0.0') return [bare]
    return interfaceHosts(false, interfaces)
  }
  const canonical = canonicalIpv6(bare.split('%')[0])
  if (canonical === undefined) return []
  if (canonical !== '::') return [`[${canonical}]`]
  return interfaceHosts(true, interfaces)
}

/**
 * Non-internal interface addresses of this host, in enumeration order.
 * An enumeration failure must not kill the connection row's activation, so it
 * shrinks the trust list (fail-closed) instead of propagating.
 * @param includeIpv6 collect IPv6 addresses too.
 * @param interfaces interface table.
 * @returns canonical, deduplicated authorities.
 */
function interfaceHosts(includeIpv6, interfaces) {
  try {
    const hosts = []
    for (const list of Object.values(interfaces)) {
      for (const iface of list ?? []) {
        if (iface.internal) continue
        if (includeIpv6) {
          const address = canonicalIpv6(iface.address.split('%')[0])
          if (address !== undefined) {
            hosts.push(`[${address}]`)
            continue
          }
        }
        if (iface.family === 'IPv4') hosts.push(iface.address)
      }
    }
    return [...new Set(hosts)]
  } catch {
    return []
  }
}
