/**
 * SSRF / DNS-rebinding guard for outbound media fetches.
 *
 * Media URLs arrive from Twilio webhooks and are fetched WITH our Twilio creds
 * attached. Without validation an attacker could point a media URL at an internal
 * host (e.g. the Railway/cloud metadata endpoint 169.254.169.254) and exfiltrate
 * those creds. assertSafeMediaUrl() enforces https, an allowlist of Twilio (and
 * optionally extra CDN) hostnames, and — critically — resolves the hostname and
 * rejects if ANY resolved address is private/loopback/link-local/metadata, which
 * also blocks DNS-rebinding to internal targets.
 *
 * Dependency-free: only node:dns and node:net. Pure functions, no import-time side
 * effects.
 */

import dns from "node:dns";
import net from "node:net";

// Built-in Twilio hostname suffixes. Twilio serves media from api.twilio.com and
// the mcs/media *.twiliocdn.com domains.
const TWILIO_SUFFIXES = [".twilio.com", ".twiliocdn.com"] as const;
const TWILIO_EXACT_HOSTS = ["api.twilio.com"] as const;

/**
 * Extra hostname suffixes permitted via the MEDIA_URL_ALLOWLIST env var
 * (comma-separated). Lets other CDNs (e.g. the MEDIA_BASE_URL host) be allowed
 * without code changes. Read lazily so there are no import-time side effects.
 */
function extraAllowedSuffixes(): string[] {
  const raw = process.env.MEDIA_URL_ALLOWLIST || "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    // normalise "example.com" → ".example.com" so it matches as a suffix
    .map((s) => (s.startsWith(".") ? s : `.${s}`));
}

/** True if host is an allowlisted Twilio (or env-extended) hostname. */
function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, ""); // drop any trailing dot
  if (TWILIO_EXACT_HOSTS.includes(h as (typeof TWILIO_EXACT_HOSTS)[number])) return true;
  if (TWILIO_SUFFIXES.some((suf) => h.endsWith(suf))) return true;
  // Allow an exact extra host too (".example.com" suffix matches "x.example.com",
  // and the bare "example.com" is matched by stripping the leading dot).
  const extras = extraAllowedSuffixes();
  if (extras.some((suf) => h.endsWith(suf) || h === suf.slice(1))) return true;
  return false;
}

/**
 * True if the given IP literal is private, loopback, link-local, unique-local,
 * metadata (169.254.169.254 lives inside 169.254.0.0/16), or the unspecified
 * address. Covers both IPv4 and IPv6 (incl. IPv4-mapped IPv6 like ::ffff:10.0.0.1).
 */
export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 0) return true; // not a valid IP → treat as unsafe

  if (kind === 4) return isPrivateIpv4(ip);

  // IPv6
  const lower = ip.toLowerCase();

  // Loopback ::1
  if (lower === "::1") return true;
  // Unspecified ::
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;

  // IPv4-mapped / IPv4-compatible IPv6 — extract the embedded IPv4 and check it.
  const mapped = lower.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped && net.isIP(mapped[1]) === 4) {
    return isPrivateIpv4(mapped[1]);
  }

  const first16 = ipv6FirstHextet(lower);
  if (first16 === null) return true; // unparseable → unsafe

  // fc00::/7 — unique-local (fc00–fdff)
  if (first16 >= 0xfc00 && first16 <= 0xfdff) return true;
  // fe80::/10 — link-local (fe80–febf)
  if (first16 >= 0xfe80 && first16 <= 0xfebf) return true;

  return false;
}

/** IPv4 private/loopback/link-local/unspecified ranges. */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → unsafe
  }
  const [a, b] = parts;
  if (a === 0) return true;                       // 0.0.0.0/8 (incl. 0.0.0.0)
  if (a === 127) return true;                     // 127.0.0.0/8 loopback
  if (a === 10) return true;                      // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16
  if (a === 169 && b === 254) return true;        // 169.254.0.0/16 (incl. metadata 169.254.169.254)
  return false;
}

/** First 16-bit group of an IPv6 address, expanding "::" as needed. Null if unparseable. */
function ipv6FirstHextet(ip: string): number | null {
  // Strip a zone id (e.g. fe80::1%eth0) before parsing.
  const addr = ip.split("%")[0];
  if (addr.startsWith("::")) return 0; // leading "::" means the first group is 0
  const firstGroup = addr.split(":")[0];
  if (!firstGroup) return 0;
  const n = parseInt(firstGroup, 16);
  return Number.isNaN(n) ? null : n;
}

/**
 * Parse and validate a media URL before fetching it. Throws on any failure.
 *
 * Checks, in order:
 *  1. protocol must be https:
 *  2. hostname must be an allowlisted Twilio (or MEDIA_URL_ALLOWLIST) host
 *  3. every DNS-resolved address must be public (blocks DNS-rebinding to internal IPs)
 *
 * @returns the parsed URL on success.
 */
export async function assertSafeMediaUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`unsafe media url: not a valid URL`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`unsafe media url: protocol must be https (got ${url.protocol})`);
  }

  const host = url.hostname;
  if (!isAllowedHost(host)) {
    throw new Error(`unsafe media url: host not allowlisted (${host})`);
  }

  // If the host is already an IP literal, check it directly — no DNS needed.
  if (net.isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new Error(`unsafe media url: host resolves to a private address (${host})`);
    }
    return url;
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await dns.promises.lookup(host, { all: true });
  } catch (e: any) {
    throw new Error(`unsafe media url: DNS lookup failed for ${host} (${e?.message || e})`);
  }
  if (!resolved.length) {
    throw new Error(`unsafe media url: DNS lookup returned no addresses for ${host}`);
  }
  for (const { address } of resolved) {
    if (isPrivateIp(address)) {
      throw new Error(`unsafe media url: ${host} resolves to a private address (${address})`);
    }
  }

  return url;
}

/**
 * Convenience wrapper: validate then fetch with an AbortController timeout.
 * The primary public API is assertSafeMediaUrl(); use this where a guarded fetch
 * with a hard timeout is wanted in one call.
 */
export async function safeFetchMedia(
  rawUrl: string,
  init?: RequestInit,
  timeoutMs = 12000,
): Promise<Response> {
  await assertSafeMediaUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(rawUrl, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
