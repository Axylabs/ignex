/**
 * @fileoverview `ignex ops caddy` template — a Caddyfile that terminates TLS
 * and proxies to the ignex backend. Pure function, split out of `./ops.ts`
 * (which re-exports it).
 */

export interface CaddyfileOptions {
  /** Site domains (default ["example.com"]). */
  domains?: string[];
  /** Backend upstream host:port (default "127.0.0.1:3000"). */
  upstream?: string;
  /**
   * Request body ceiling enforced at the proxy (`request_body { max_size }`),
   * e.g. "64MiB". Align it with the app's `server.maxRequestBodySize` so
   * oversized uploads are rejected before they reach the backend. Omitted by
   * default (Caddy imposes no limit).
   */
  maxBodySize?: string;
  /**
   * How long Caddy keeps retrying the upstream when it is unreachable
   * (`lb_try_duration`), e.g. "5s". The single-upstream zero-downtime knob: a
   * request arriving while the backend restarts (systemd `restart`, a rolling
   * deploy) waits for it to come back instead of failing with 502. Omitted by
   * default (Caddy's default: no retry).
   */
  lbRetry?: string;
}

/**
 * Input validation for every value spliced into the Caddyfile. These are
 * operator-supplied CLI flags (not client input), but a crafted value (a
 * newline or brace inside `--domain`/`--max-body`) would inject arbitrary
 * Caddy directives into a config an operator then deploys — every
 * interpolation into a generated infrastructure file is validated, fail-fast.
 */
const HOSTNAME = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
/** Caddy env placeholder form, e.g. `{$SITE_ADDRESS}` (documented for one
 * committed Caddyfile serving every environment). */
const PLACEHOLDER = /^\{\$[A-Za-z_][A-Za-z0-9_]*\}$/;
const SPLIT_PLACEHOLDER =
  /^\{\$[A-Za-z_][A-Za-z0-9_]*\}$|^((\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*)\{\$[A-Za-z_][A-Za-z0-9_]*\}$/;
const SIZE_RE = /^\d+(\.\d+)?(B|k[i]?B|m[i]?B|g[i]?B)$/i;
const DURATION_RE = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

const assertMatch = (value: string, re: RegExp, what: string, hint: string): void => {
  if (!re.test(value)) {
    throw new TypeError(`invalid ${what}: ${JSON.stringify(value)} — ${hint}`);
  }
};

const validateCaddyInputs = (
  domains: string[],
  upstream: string,
  maxBodySize?: string,
  lbRetry?: string,
): void => {
  for (const domain of domains) {
    const value = domain.trim();
    if (HOSTNAME.test(value) || SPLIT_PLACEHOLDER.test(value) || PLACEHOLDER.test(value)) continue;
    throw new TypeError(
      `invalid domain: ${JSON.stringify(domain)} — expected a hostname (e.g. example.com), ` +
        `an optional *. wildcard, or a Caddy env placeholder ({$SITE_ADDRESS}); ` +
        "no spaces, braces, slashes or newlines",
    );
  }
  // Upstream: `host:port` (host may be a hostname, IPv4 or [bracketed] IPv6;
  // Caddy env placeholders pass through untouched).
  if (!PLACEHOLDER.test(upstream)) {
    const match = /^([^:[\s]+|\[[0-9a-fA-F:.]+\]|\d+(\.\d+){3}):(\d+)$/.exec(upstream.trim());
    const port = match === null ? NaN : Number.parseInt(match[3] ?? "", 10);
    if (match === null || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError(
        `invalid upstream: ${JSON.stringify(upstream)} — expected host:port ` +
          "(e.g. 127.0.0.1:3000 or app:3000); port must be 1-65535",
      );
    }
  }
  if (maxBodySize !== undefined) {
    assertMatch(
      maxBodySize.trim(),
      SIZE_RE,
      "max-body size",
      "expected a Caddy size (e.g. 64MiB, 1GiB, 512KiB, 1MB)",
    );
  }
  if (lbRetry !== undefined) {
    assertMatch(
      lbRetry.trim(),
      DURATION_RE,
      "lb-retry duration",
      "expected a Caddy duration (e.g. 5s, 500ms, 1h30m)",
    );
  }
};

/** Optimized Caddyfile — TLS termination + HSTS in front of the ignex backend. */
export function caddyfileTemplate(options: CaddyfileOptions = {}): string {
  const domains = options.domains && options.domains.length > 0 ? options.domains : ["example.com"];
  const upstream = options.upstream ?? "127.0.0.1:3000";
  validateCaddyInputs(domains, upstream, options.maxBodySize, options.lbRetry);
  const site = domains.join(", ");

  const requestBody = options.maxBodySize
    ? `	# Reject oversized bodies at the edge — keep in sync with the app's
	# \`server.maxRequestBodySize\`.
	request_body {
		max_size ${options.maxBodySize}
	}

`
    : "";

  const lbRetry = options.lbRetry
    ? `
		# Keep retrying the upstream while it restarts (systemd restart, rolling
		# deploy) so in-flight requests wait instead of failing with 502.
		lb_try_duration ${options.lbRetry}
		lb_try_interval 250ms`
    : "";

  // Caddy manages X-Forwarded-For itself but passes a client-supplied
  // X-Real-IP through untouched — and the framework's \`trustProxy\` resolution
  // prefers X-Real-IP. Always overwrite it with the real peer so \`ctx.ip\`
  // cannot be spoofed by the client.
  const reverseProxy = `	reverse_proxy ${upstream} {
		# The app runs with trustProxy: ctx.ip prefers X-Real-IP, so pin it to
		# the real peer — a client-supplied value must never pass through.
		# (Behind another proxy/CDN, set it from that hop's header instead.)
		header_up X-Real-IP {remote_host}${lbRetry}
	}`;

  return `# Caddyfile generated by \`ignex ops caddy\` — reverse proxy for an ignex backend.
#
# Optimizations:
#   - Caddy terminates TLS (auto Let's Encrypt) and serves HTTP/2 + HTTP/3.
#   - The app already sends its security headers (CSP, COEP/COOP, ...) via
#     \`server.headers\`; HSTS is deliberately NOT set by the app (it belongs at
#     the TLS terminator), so we add it here.
#   - No \`encode gzip\`: the app compresses via its \`compression()\` plugin, so
#     re-compressing here would waste CPU.
#   - WebSockets / SSE (e.g. the /jobs and /session routes) pass through
#     automatically — Caddy upgrades them by default.

${site} {
${requestBody}	# Host → backend. Change to the service name when the backend runs in the
	# same compose network (e.g. app:3000).
${reverseProxy}

	header {
		# HSTS — only ever sent over HTTPS (Caddy is the TLS terminator).
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
	}
}
`;
}
