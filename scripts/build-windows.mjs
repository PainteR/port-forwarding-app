#!/usr/bin/env node
// Build Windows x64 on macOS without a VM. Only generated files are cached;
// Cargo registry sources and the native Windows/OpenSSL build stay unchanged.
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, cpSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = "x86_64-pc-windows-msvc";
let env = { ...process.env };

function run(command, args, { cwd = root, capture = false, log } = {}) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: log !== undefined ? ["ignore", log, log] : capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.signal ?? result.status})`);
  return result.stdout?.trim() ?? "";
}

function executable(name, searchPath = env.PATH ?? "") {
  for (const directory of searchPath.split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Try the next directory. */ }
  }
  return null;
}

function requireTool(name, hint) {
  const tool = executable(name);
  if (!tool) throw new Error(`Missing ${name}. ${hint}`);
  return tool;
}

function brewBin(formula) {
  const brew = executable("brew");
  if (!brew) return null;
  const result = spawnSync(brew, ["--prefix", formula], { env, encoding: "utf8" });
  return result.status === 0 ? path.join(result.stdout.trim(), "bin") : null;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Values printed by cargo-xwin are not shell-escaped. Read the SDK path as
// literal text rather than evaluating the exported shell commands.
function sdkFromXwin(output) {
  const library = output.match(/^export LIB="(.*)";$/m)?.[1].split(";")[0];
  const suffix = "/crt/lib/x86_64";
  if (!library?.endsWith(suffix)) throw new Error("Cannot locate the Windows SDK in cargo-xwin's environment output. Update cargo-xwin.");
  return library.slice(0, -suffix.length);
}

function shellWord(value) {
  // These strings are consumed by OpenSSL's generated Unix Makefile.
  return `'${value.replaceAll("'", "'\\''")}'`.replaceAll("$", () => "$$");
}

function prepareOpenSsl(metadata, sdk, clang, ar, ranlib, xwinVersion) {
  const packages = metadata.packages.filter((item) => item.name === "openssl-src");
  if (packages.length !== 1) throw new Error("Expected one locked openssl-src package in the Windows dependency graph.");
  const openssl = packages[0];
  const includes = [path.join(sdk, "crt/include"), ...["ucrt", "um", "shared", "winrt"].map((part) => path.join(sdk, "sdk/include", part))];
  for (const include of includes) {
    if (!existsSync(include)) throw new Error(`Incomplete Windows SDK: missing ${include}`);
  }
  const flags = [
    `--target=${target}`, "-O2", "-ffunction-sections", "-fdata-sections",
    "-fms-extensions", "-fms-compatibility", "-fms-runtime-lib=dll",
    "-D_CRT_SECURE_NO_WARNINGS", "-D_WINSOCK_DEPRECATED_NO_WARNINGS",
    ...includes.flatMap((include) => ["-isystem", include]),
  ];
  // mingw64 supplies Unix Makefile rules and Windows settings. The compiler
  // target above still selects the MSVC ABI/CRT, not the MinGW toolchain.
  const options = ["mingw64", "no-shared", "no-asm", "no-tests", "no-module", "no-legacy", "no-capieng", "no-comp", "no-zlib", "no-zlib-dynamic", "--libdir=lib"];
  const headers = ["crt/include/vcruntime.h", "sdk/include/ucrt/corecrt.h", "sdk/include/um/winnt.h"];
  const fingerprint = hash(JSON.stringify({
    recipe: 1, source: openssl.id, clang, compiler: run(clang, ["--version"], { capture: true }), ar, ranlib,
    xwinVersion, sdk, headers: headers.map((name) => hash(readFileSync(path.join(sdk, name)))), flags, options,
  })).slice(0, 16);
  const cache = path.join(metadata.target_directory, "windows-cross", `openssl-${openssl.version}-${fingerprint}`);
  const source = path.join(cache, "source");
  const build = path.join(cache, "build");
  const prefix = path.join(cache, "install");
  const stamp = path.join(cache, "complete");
  const libraries = ["ssl", "crypto"].map((name) => path.join(prefix, "lib", `lib${name}.lib`));
  if (existsSync(stamp) && [...libraries, path.join(prefix, "include/openssl/ssl.h")].every(existsSync)) {
    console.log(`Using cached Windows OpenSSL ${openssl.version}`);
    return prefix;
  }

  mkdirSync(build, { recursive: true });
  console.log(`Preparing Windows OpenSSL ${openssl.version} (first build)`);
  cpSync(path.join(path.dirname(openssl.manifest_path), "openssl"), source, { recursive: true });
  const savedEnv = env;
  env = { ...env, CC: shellWord(clang), AR: shellWord(ar), RANLIB: shellWord(ranlib), CFLAGS: flags.map(shellWord).join(" ") };
  const logPath = path.join(cache, "build.log");
  const log = openSync(logPath, "w");
  try {
    if (!existsSync(path.join(build, "Makefile"))) {
      run("perl", [path.join(source, "Configure"), ...options, `--prefix=${prefix}`], { cwd: build, log });
    }
    run("make", ["-s", `-j${Math.min(availableParallelism(), 8)}`, "build_libs"], { cwd: build, log });
    mkdirSync(path.join(prefix, "lib"), { recursive: true });
    cpSync(path.join(source, "include/openssl"), path.join(prefix, "include/openssl"), { recursive: true });
    cpSync(path.join(build, "include/openssl"), path.join(prefix, "include/openssl"), { recursive: true });
    for (const name of ["ssl", "crypto"]) cpSync(path.join(build, `lib${name}.a`), path.join(prefix, "lib", `lib${name}.lib`));
    writeFileSync(stamp, `${fingerprint}\n`);
  } catch (error) {
    console.error(readFileSync(logPath, "utf8").split("\n").slice(-60).join("\n"));
    throw new Error(`${error.message}. OpenSSL log: ${logPath}`);
  } finally {
    closeSync(log);
    env = savedEnv;
  }
  return prefix;
}

function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: yarn build:windows\nBuilds a Windows x64 NSIS installer on macOS. See README.md for one-time prerequisites.\nOpenSSL cache: src-tauri/target/windows-cross (or CARGO_TARGET_DIR/windows-cross).");
    return;
  }
  if (process.argv.length > 2) throw new Error("Unknown arguments. Run yarn build:windows --help for usage.");
  if (process.platform !== "darwin") throw new Error("This script targets macOS. On Windows use yarn tauri build.");

  const llvm = env.LLVM_BIN || brewBin("llvm");
  const nsis = brewBin("nsis");
  env.PATH = [llvm, nsis, env.PATH].filter(Boolean).join(path.delimiter);
  const tools = Object.fromEntries(["clang", "clang-cl", "llvm-ar", "llvm-ranlib", "llvm-lib", "llvm-rc", "llvm-readobj"].map((name) => [name, requireTool(name, "Install Homebrew LLVM: brew install llvm")]));
  requireTool("makensis", "Install NSIS: brew install nsis");
  requireTool("perl", "Install Xcode Command Line Tools: xcode-select --install");
  requireTool("make", "Install Xcode Command Line Tools: xcode-select --install");
  requireTool("yarn", "Install Yarn Classic 1.22.");
  requireTool("cargo", "Install Rust using rustup.");
  requireTool("rustup", "Install Rust using rustup.");
  const cli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
  if (!existsSync(cli)) throw new Error("Install frontend dependencies first: yarn install --frozen-lockfile");
  const targets = run("rustup", ["target", "list", "--installed"], { capture: true }).split(/\s+/);
  if (!targets.includes(target)) throw new Error(`Install the Windows Rust target: rustup target add ${target}`);
  const xwin = executable("cargo-xwin");
  if (!xwin) throw new Error("Install cargo-xwin: cargo install --locked cargo-xwin");
  const xwinVersion = run("cargo", ["xwin", "--version"], { capture: true });
  const version = xwinVersion.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!version || (version[0] === 0 && (version[1] < 23 || (version[1] === 23 && version[2] < 1)))) {
    throw new Error("cargo-xwin 0.23.1 or newer is required: cargo install --locked cargo-xwin");
  }
  // Use the same SDK layout/backend for discovery and the application build.
  env.XWIN_CROSS_COMPILER = "clang-cl";
  console.log(`Preparing ${target} with ${xwinVersion}`);
  const sdk = sdkFromXwin(run("cargo", ["xwin", "env", "--target", target], { capture: true }));
  const metadata = JSON.parse(run("cargo", ["metadata", "--manifest-path", path.join(root, "src-tauri/Cargo.toml"), "--locked", "--format-version", "1", "--filter-platform", target], { capture: true }));
  const prefix = prepareOpenSsl(metadata, sdk, tools.clang, tools["llvm-ar"], tools["llvm-ranlib"], xwinVersion);
  env = {
    ...env, CARGO_TARGET_DIR: metadata.target_directory,
    X86_64_PC_WINDOWS_MSVC_OPENSSL_NO_VENDOR: "1",
    X86_64_PC_WINDOWS_MSVC_OPENSSL_STATIC: "1",
    X86_64_PC_WINDOWS_MSVC_OPENSSL_DIR: prefix,
    X86_64_PC_WINDOWS_MSVC_OPENSSL_LIB_DIR: path.join(prefix, "lib"),
    X86_64_PC_WINDOWS_MSVC_OPENSSL_INCLUDE_DIR: path.join(prefix, "include"),
  };
  // Bypass Yarn Classic's handling of `--`; the final --locked is for Cargo.
  run(process.execPath, [cli, "build", "--runner", xwin, "--target", target, "--ci", "--", "--locked"]);
  const release = path.join(metadata.target_directory, target, "release");
  const app = path.join(release, "port-forward.exe");
  const imports = run(tools["llvm-readobj"], ["--file-headers", "--coff-imports", app], { capture: true });
  if (!imports.includes("IMAGE_FILE_MACHINE_AMD64")) throw new Error("The generated executable is not Windows x64.");
  const external = [...imports.matchAll(/^\s*Name: (.*)$/gm)].map((match) => match[1]).filter((name) => /libssl|libcrypto|libgcc|libstdc\+\+|libwinpthread/i.test(name));
  if (external.length) throw new Error(`Unexpected runtime DLL dependencies: ${external.join(", ")}`);
  const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const installer = path.join(release, "bundle/nsis", `${config.productName}_${config.version}_x64-setup.exe`);
  const checksum = hash(readFileSync(installer));
  console.log(`\nWindows x64 build complete (unsigned).\nInstaller: ${installer}\nExecutable: ${app}\nSHA-256: ${checksum}`);
}

try { main(); } catch (error) {
  console.error(`\nWindows build failed: ${error.message}`);
  process.exitCode = 1;
}
