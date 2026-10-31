import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/lib/nginx.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
  },
});
const nginx = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const draft = () => ({
  ...nginx.createDomainDraft(),
  domain: "example.com",
  email: "info@example.com",
});

test("domain config preserves or strips URI prefixes explicitly and keeps nginx variables literal", () => {
  const value = draft();
  value.aliases = "www.example.com, api.example.com www.example.com";
  const config = nginx.generateDomainConfig(value);
  assert.match(
    config,
    /location \/b\/ \{\n\s+proxy_pass http:\/\/127\.0\.0\.1:24002\//,
  );
  assert.match(
    config,
    /location \/ \{\n\s+proxy_pass http:\/\/127\.0\.0\.1:29001;/,
  );
  assert.match(config, /proxy_set_header Host \$host;/);
  assert.match(config, /return 301 https:\/\/example\.com\$request_uri;/);
  assert.match(
    config,
    /server_name example\.com www\.example\.com api\.example\.com;/,
  );
  assert.match(
    config,
    /location \^~ \/\.well-known\/acme-challenge\/ \{\n\s+root \/var\/www\/_letsencrypt;\n\s+try_files \$uri =404;/,
  );
  assert.match(
    config,
    /ssl_trusted_certificate \/etc\/letsencrypt\/live\/example.com\/chain.pem;/,
  );
});

test("standalone template works without shared includes and accepts IPv6 upstream origins", () => {
  const value = draft();
  value.useSharedIncludes = false;
  value.locations = [
    { path: "/", upstream: "https://[2001:db8::1]:8443", stripPrefix: false },
  ];
  const config = nginx.generateDomainConfig(value, {
    ...nginx.DEFAULT_NGINX_SETTINGS,
    webroot: "/srv/acme",
  });
  assert.doesNotMatch(config, /include nginxconfig/);
  assert.match(config, /proxy_pass https:\/\/\[2001:db8::1\]:8443;/);
  assert.match(
    config,
    /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/,
  );
  assert.match(config, /root \/srv\/acme;/);
});

test("draft config can be prepared before a certificate contact email is entered", () => {
  const value = { ...draft(), email: "" };
  assert.deepEqual(nginx.validateDomainDraft(value), []);
  assert.match(nginx.generateDomainConfig(value), /server_name example.com;/);
  assert.ok(nginx.validateDomainDraft({ ...value, email: "invalid" }).length);
});

test("configuration injection and ambiguous paths are rejected before rendering", () => {
  for (const domain of [
    "example.com;",
    "example.com\n}",
    "*.example.com",
    "https://example.com",
    "-example.com",
    "127.0.0.1",
  ]) {
    assert.ok(nginx.validateDomainDraft({ ...draft(), domain }).length, domain);
  }
  for (const upstream of [
    "http://127.0.0.1:3000;",
    "http://host/a",
    "http://user:pass@host",
    "http://host?x=1",
    "http://host#fragment",
    "http://$backend",
    "http://host:65536",
    "http://host:0",
    "http://.",
    "http://-",
  ]) {
    assert.ok(
      nginx.validateDomainDraft({
        ...draft(),
        locations: [{ path: "/", upstream, stripPrefix: false }],
      }).length,
      upstream,
    );
  }
  for (const path of ["/ {", "/;", "/$path", "/../private", "/foo\nbar"]) {
    assert.ok(
      nginx.validateDomainDraft({
        ...draft(),
        locations: [{ path, upstream: "http://host:3000", stripPrefix: false }],
      }).length,
      path,
    );
  }
  assert.throws(() =>
    nginx.generateDomainConfig({ ...draft(), domain: "example.com;" }),
  );
  assert.ok(
    nginx.validateNginxSettings({
      ...nginx.DEFAULT_NGINX_SETTINGS,
      webroot: "/srv/../etc",
    }).length,
  );
  assert.ok(
    nginx.validateNginxSettings({
      ...nginx.DEFAULT_NGINX_SETTINGS,
      webroot: "/srv/a;bad",
    }).length,
  );
});

test("duplicate locations and accidental partial-prefix stripping are rejected", () => {
  const value = draft();
  value.locations[0].path = "/b";
  assert.ok(
    nginx
      .validateDomainDraft(value)
      .some((error) => error.includes("ending in /")),
  );
  value.locations[0].path = "/";
  assert.ok(
    nginx
      .validateDomainDraft(value)
      .some((error) => error.includes("already configured")),
  );
});

test("cloning changes whole domains and certificate lineage while preserving other hosts and routes", () => {
  const site = {
    fileName: "example.com.conf",
    domains: ["example.com", "www.example.com"],
    enabled: true,
    hasTls: true,
    revision: "rev1",
    content: `server_name example.com www.example.com;\nssl_certificate /etc/letsencrypt/live/example.com-0001/fullchain.pem;\nproxy_pass http://myexample.com:3000;\ninclude nginxconfig.io/proxy.conf;\nreturn 301 https://example.com$request_uri;\n# unrelated other.example.com\n`,
  };
  const config = nginx.cloneSiteConfig(site, "new.example.com");
  assert.match(config, /server_name new\.example\.com www\.new\.example\.com;/);
  assert.match(config, /live\/new\.example\.com\/fullchain.pem/);
  assert.match(config, /http:\/\/myexample\.com:3000;/);
  assert.match(config, /# unrelated other\.example\.com/);
  assert.match(config, /include nginxconfig.io\/proxy.conf/);
  assert.doesNotMatch(config, /new\.new\.example\.com/);
});

test("filename validation rejects traversal and shell/path control", () => {
  assert.equal(nginx.isValidNginxFileName("example.com.conf"), true);
  assert.equal(nginx.isValidNginxFileName("default"), true);
  assert.equal(nginx.isValidNginxFileName("a".repeat(200)), true);
  assert.equal(nginx.isValidNginxFileName("a".repeat(201)), false);
  for (const name of [
    "../nginx.conf",
    "/etc/nginx.conf",
    "a;echo.conf",
    ".hidden",
    "a\nb.conf",
    "a..conf",
  ]) {
    assert.equal(nginx.isValidNginxFileName(name), false, name);
  }
});
