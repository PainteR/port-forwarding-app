export type NginxSettings = {
  configDir: string;
  webroot: string;
  useSudo: boolean;
};

export type NginxSiteSummary = {
  fileName: string;
  domains: string[];
  enabled: boolean;
  hasTls: boolean;
  revision: string;
};

export type NginxSite = NginxSiteSummary & { content: string };

export type NginxSnapshot = {
  serverId: string;
  serverKey: string;
  fetchedAt: string;
  sites: NginxSiteSummary[];
  warnings: string[];
};

export type NginxOperationResult = {
  success: boolean;
  log: string;
  site?: NginxSite | null;
  backupPath?: string | null;
};

export type NginxSaveRequest = {
  fileName: string;
  content: string;
  enabled: boolean;
  expectedRevision: string | null;
  create: boolean;
};

export type NginxProvisionRequest = {
  fileName: string;
  domain: string;
  aliases: string[];
  email: string;
  content: string;
  expectedRevision: string | null;
  create: boolean;
  forceRenewal: boolean;
};

export type NginxLocation = {
  path: string;
  /** HTTP(S) origin, without a URI, credentials, query, or fragment. */
  upstream: string;
  stripPrefix: boolean;
};

export type DomainDraft = {
  domain: string;
  /** Additional DNS names, separated by whitespace or commas. */
  aliases: string;
  email: string;
  locations: NginxLocation[];
  useSharedIncludes: boolean;
};

export const DEFAULT_NGINX_SETTINGS: NginxSettings = {
  configDir: "/etc/nginx",
  webroot: "/var/www/_letsencrypt",
  useSudo: true,
};

export function createDomainDraft(): DomainDraft {
  return {
    domain: "",
    aliases: "",
    email: "",
    locations: [
      { path: "/b/", upstream: "http://127.0.0.1:24002", stripPrefix: true },
      { path: "/", upstream: "http://127.0.0.1:29001", stripPrefix: false },
    ],
    useSharedIncludes: true,
  };
}

export function parseDomainAliases(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(normalizeDomain),
    ),
  ];
}

export function isValidDomain(value: string): boolean {
  const domain = normalizeDomain(value);
  if (domain.length > 253 || !domain.includes(".")) return false;
  const labels = domain.split(".");
  if (!/[a-z]/.test(labels[labels.length - 1])) return false;
  return labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  );
}

export function isValidNginxFileName(value: string): boolean {
  return (
    value.length <= 200 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
    !value.includes("..")
  );
}

export function validateNginxSettings(settings: NginxSettings): string[] {
  const errors: string[] = [];
  if (!isSafeAbsolutePath(settings.configDir)) {
    errors.push(
      "Nginx configuration directory must be an absolute path without spaces, parent segments, or configuration characters.",
    );
  }
  if (!isSafeAbsolutePath(settings.webroot)) {
    errors.push(
      "ACME webroot must be an absolute path without spaces, parent segments, or configuration characters.",
    );
  }
  return errors;
}

export function validateDomainDraft(
  draft: DomainDraft,
  settings: NginxSettings = DEFAULT_NGINX_SETTINGS,
): string[] {
  const errors = validateNginxSettings(settings);
  const domain = normalizeDomain(draft.domain);
  if (!isValidDomain(domain)) {
    errors.push(
      "Enter a DNS domain such as example.com. Use punycode for international names; wildcards are not supported by webroot certificates.",
    );
  }
  const aliases = parseDomainAliases(draft.aliases);
  for (const alias of aliases) {
    if (!isValidDomain(alias))
      errors.push(`Invalid additional domain: ${alias}.`);
  }
  if (aliases.includes(domain))
    errors.push(
      "The primary domain is already included; remove it from additional domains.",
    );
  if (
    draft.email.trim() &&
    !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(
      draft.email.trim(),
    )
  ) {
    errors.push("Enter a valid certificate contact email.");
  }
  if (!draft.locations.length) errors.push("Add at least one proxy location.");
  const paths = new Set<string>();
  for (const [index, location] of draft.locations.entries()) {
    const prefix = `Location ${index + 1}`;
    if (!isSafeLocationPath(location.path)) {
      errors.push(
        `${prefix}: use a plain path prefix such as / or /b/, without spaces, variables, or configuration characters.`,
      );
    }
    if (paths.has(location.path))
      errors.push(`${prefix}: path ${location.path} is already configured.`);
    paths.add(location.path);
    if (
      location.stripPrefix &&
      (location.path === "/" || !location.path.endsWith("/"))
    ) {
      errors.push(
        `${prefix}: stripping requires a non-root prefix ending in /, such as /b/.`,
      );
    }
    if (!parseUpstreamOrigin(location.upstream)) {
      errors.push(
        `${prefix}: upstream must be an HTTP(S) host and optional port, such as http://127.0.0.1:3000; URI paths, credentials, queries, and fragments are not supported.`,
      );
    }
  }
  return errors;
}

export function generateDomainConfig(
  draft: DomainDraft,
  settings: NginxSettings = DEFAULT_NGINX_SETTINGS,
): string {
  const errors = validateDomainDraft(draft, settings);
  if (errors.length) throw new Error(errors.join("\n"));

  const domain = normalizeDomain(draft.domain);
  const domains = [domain, ...parseDomainAliases(draft.aliases)].join(" ");
  const routes = draft.locations
    .map((location) => {
      const origin = parseUpstreamOrigin(location.upstream)!;
      // With a URI, nginx replaces the matching prefix. Without one it preserves it.
      const upstream = `${origin}${location.stripPrefix ? "/" : ""}`;
      const headers = draft.useSharedIncludes
        ? "        include nginxconfig.io/proxy.conf;"
        : [
            "        proxy_http_version 1.1;",
            "        proxy_set_header X-Real-IP $remote_addr;",
            "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
            "        proxy_set_header X-Forwarded-Proto $scheme;",
          ].join("\n");
      return `    location ${location.path} {\n        proxy_pass ${upstream};\n        proxy_set_header Host $host;\n${headers}\n    }`;
    })
    .join("\n\n");
  const security = draft.useSharedIncludes
    ? "    include nginxconfig.io/security.conf;"
    : "    ssl_protocols TLSv1.2 TLSv1.3;";
  const general = draft.useSharedIncludes
    ? "\n\n    include nginxconfig.io/general.conf;"
    : "";

  return `server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domains};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_trusted_certificate /etc/letsencrypt/live/${domain}/chain.pem;

${security}

    access_log /var/log/nginx/access.log combined buffer=512k flush=1m;
    error_log /var/log/nginx/error.log warn;

${routes}${general}
}

# HTTP redirect and ACME certificate validation
server {
    listen 80;
    listen [::]:80;
    server_name ${domains};

    location ^~ /.well-known/acme-challenge/ {
        root ${settings.webroot};
        try_files $uri =404;
    }

    location / {
        return 301 https://${domain}$request_uri;
    }
}
`;
}

/**
 * Duplicate the primary name and its listed subdomain aliases in a raw config.
 * Other aliases and arbitrary directives remain available for review in the editor.
 */
export function cloneSiteConfig(site: NginxSite, newDomain: string): string {
  const nextDomain = normalizeDomain(newDomain);
  if (!isValidDomain(nextDomain))
    throw new Error("Enter a valid new DNS domain.");
  const primary = site.domains.map(normalizeDomain).find(isValidDomain);
  if (!primary)
    throw new Error(
      "This file has no regular DNS domain to replace. Copy and edit its configuration manually.",
    );

  let content = site.content.replace(
    new RegExp(
      `/etc/letsencrypt/live/${escapeRegExp(primary)}(?:-\\d{4})?/`,
      "gi",
    ),
    `/etc/letsencrypt/live/${nextDomain}/`,
  );
  const replacements = [...new Set(site.domains.map(normalizeDomain))]
    .filter((domain) => domain === primary || domain.endsWith(`.${primary}`))
    .sort((left, right) => right.length - left.length);
  // Use one pass so a target containing the source name is never replaced twice.
  const expression = new RegExp(
    `(^|[^a-zA-Z0-9_.-])(${replacements.map(escapeRegExp).join("|")})(?=$|[^a-zA-Z0-9_.-])`,
    "gi",
  );
  return content.replace(
    expression,
    (_match, boundary: string, domain: string) =>
      `${boundary}${domain.toLowerCase() === primary ? nextDomain : `${domain.slice(0, -primary.length)}${nextDomain}`}`,
  );
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase();
}

function isSafeAbsolutePath(value: string): boolean {
  return (
    /^\/[a-zA-Z0-9_./-]+$/.test(value) &&
    value !== "/" &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function isSafeLocationPath(value: string): boolean {
  return (
    /^\/[a-zA-Z0-9_~.@%+/-]*$/.test(value) &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function parseUpstreamOrigin(value: string): string | null {
  const upstream = value.trim();
  if (
    !/^https?:\/\/(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9_.-]+)(?::[0-9]{1,5})?\/?$/.test(
      upstream,
    )
  )
    return null;
  try {
    const url = new URL(upstream);
    if (!url.hostname || url.port === "0") return null;
    if (
      !url.hostname.startsWith("[") &&
      !url.hostname
        .split(".")
        .every((label) =>
          /^[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?$/.test(label),
        )
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
