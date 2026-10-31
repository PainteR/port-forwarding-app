// Local grammar check only: uses a cached image, no published ports or network.
// Run with: node tests/nginx-config-docker.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";

function run(executable, args) {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `${executable} ${args.join(" ")} failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`,
      { cause: error },
    );
  }
}

const imageId = run("docker", [
  "image",
  "inspect",
  process.env.NGINX_TEST_IMAGE ?? "nginx:latest",
  "--format",
  "{{.Id}}",
]).trim();
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
const temporaryRoot = mkdtempSync(join(tmpdir(), "port-forward-nginx-config-"));

try {
  const certificateDirectory = join(temporaryRoot, "certificate");
  const webroot = join(temporaryRoot, "webroot");
  mkdirSync(certificateDirectory);
  mkdirSync(webroot);
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=example.com",
    "-addext",
    "subjectAltName=DNS:example.com,DNS:www.example.com",
    "-keyout",
    join(certificateDirectory, "privkey.pem"),
    "-out",
    join(certificateDirectory, "fullchain.pem"),
  ]);
  copyFileSync(
    join(certificateDirectory, "fullchain.pem"),
    join(certificateDirectory, "chain.pem"),
  );
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
  const { createDomainDraft, generateDomainConfig } = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
  const finalConfiguration = generateDomainConfig({
    ...createDomainDraft(),
    domain: "example.com",
    aliases: "www.example.com",
    useSharedIncludes: false,
  });
  const backendPath = fileURLToPath(
    new URL("../src-tauri/src/nginx_remote.py", import.meta.url),
  );
  const bootstrapConfiguration = run("python3", [
    "-B",
    "-c",
    [
      "import importlib.util,sys",
      "spec=importlib.util.spec_from_file_location('nginx_remote',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "print(module.bootstrap_configuration(['example.com','www.example.com'],'/var/www/_letsencrypt'))",
    ].join("\n"),
    backendPath,
  ]);

  const commonArguments = [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--cap-add=CHOWN",
    "--tmpfs",
    "/var/cache/nginx",
    "--tmpfs",
    "/var/run",
    "--entrypoint",
    "nginx",
  ];
  const versionResult = spawnSync(
    "docker",
    [...commonArguments, imageId, "-v"],
    { encoding: "utf8" },
  );
  assert.equal(versionResult.status, 0, versionResult.stderr);
  console.log(`Image: ${imageId}`);
  console.log((versionResult.stdout + versionResult.stderr).trim());

  for (const [name, configuration] of [
    ["https", finalConfiguration],
    ["http-bootstrap", bootstrapConfiguration],
  ]) {
    const configurationPath = join(temporaryRoot, `${name}.conf`);
    writeFileSync(configurationPath, configuration);
    const result = spawnSync(
      "docker",
      [
        ...commonArguments,
        "--mount",
        `type=bind,source=${configurationPath},target=/etc/nginx/conf.d/default.conf,readonly`,
        "--mount",
        `type=bind,source=${certificateDirectory},target=/etc/letsencrypt/live/example.com,readonly`,
        "--mount",
        `type=bind,source=${webroot},target=/var/www/_letsencrypt,readonly`,
        imageId,
        "-t",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /test is successful/);
    console.log(`${name}: ${result.stderr.trim()}`);
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
