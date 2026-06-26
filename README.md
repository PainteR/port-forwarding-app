# Port Forward

A desktop SSH tunnel manager built with Tauri, React, and Rust. The app keeps SSH server profiles, starts local, remote, and dynamic/SOCKS forwards, creates quick access to published Docker ports, and streams container logs over SSH.

## Features

- SSH profiles with SSH agent, private key file, or password authentication.
- Manual tunnel configurations for `-L`, `-R`, and `-D`.
- Runtime tunnel states: `starting`, `running`, `reconnecting`, `stopping`, `stopped`, `failed`.
- Automatic fallback for local and dynamic ports: if the requested port is busy, the app tries a free port from `50000-58000` and shows the actual runtime bind.
- Docker discovery for the selected server via `docker ps` and `docker inspect`.
- Quick local forward creation for published Docker ports.
- `docker logs` viewing with an initial tail and live follow.
- Local storage for servers, forwards, Docker cache, and credential notes.
- macOS Dock badge with the number of active tunnels.

## Tech Stack

- Frontend: React 19, TypeScript, Vite, Tailwind CSS 4, shadcn/ui-style components.
- Desktop/runtime: Tauri 2.
- Backend: Rust, `ssh2`, Tauri commands.
- Bundles: macOS `.app` and `.dmg`.

## Requirements

- Node.js and Yarn.
- Rust stable and Cargo.
- Tauri platform prerequisites for your OS. On macOS, this usually means Xcode Command Line Tools.
- SSH access to the servers you want to configure.
- For the Docker section: Docker installed on the remote server and user permissions to run `docker ps`, `docker inspect`, and `docker logs`.

## Quick Start

```bash
yarn install
yarn tauri dev
```

`yarn tauri dev` starts the Vite dev server at `http://localhost:1420` and opens the Tauri desktop shell. Plain `yarn dev` starts only the browser frontend; Tauri IPC commands are not available there, so real SSH and Docker operations will not work.

## Common Commands

```bash
# Frontend build
yarn build

# Desktop dev app
yarn tauri dev

# Production bundle
yarn tauri build

# Rust checks
cd src-tauri
cargo fmt --check
cargo check
cargo test
```

After `yarn tauri build`, build artifacts are written under `src-tauri/target/release/bundle/`.

## Usage

1. Add a server profile with `Add server`: host, port, username, and authentication method.
2. Verify the profile with `Test connection`.
3. Add a tunnel in the `Forwards` section.
4. Start it with `Start`.
5. For a local forward, use `Open` to open `http://<bindHost>:<bindPort>` in the browser.

### Forward Types

`-L` local forward:

```text
local bindHost:bindPort -> targetHost:targetPort through the SSH server
```

Use this to access a service from your local machine when that service is reachable from the server.

`-R` remote forward:

```text
remote bindHost:bindPort -> local targetHost:targetPort
```

Opens a listener on the remote server and forwards incoming connections back to a local target.

`-D` dynamic forward:

```text
local bindHost:bindPort -> SOCKS5 proxy through the SSH server
```

Supports SOCKS5 `CONNECT` requests without authentication.

### Autostart

The `Autostart` flag currently starts a forward immediately after saving it. Saved forwards are not automatically started when the app launches.

## Docker

The `Refresh` button in the `Docker` section connects to the selected server and runs:

```bash
docker ps -q
docker inspect <container_ids>
```

The result is cached in the local `state.json`. For containers with published ports, the `Add` button creates a local forward with source `docker`.

The `Logs` button first reads the latest 1000 lines:

```bash
docker logs --tail 1000 <container_id> 2>&1
```

Then it opens a live follow session:

```bash
docker logs --tail 0 -f <container_id> 2>&1
```

## Local Data and Security

The app stores state in the Tauri app data directory in a `state.json` file. It contains:

- server profiles;
- forwards;
- Docker cache;
- saved secrets and passwords entered in the UI;
- SSH passwords/passphrases when the corresponding authentication method is used.

The file is not encrypted and is not stored in the OS keychain. Do not store secrets there unless your local user profile and disk are protected at the OS level.

When connecting over SSH, the app checks `~/.ssh/known_hosts` if the file exists. A host key mismatch stops the connection.

## Project Structure

```text
src/
  App.tsx              React UI, Tauri IPC calls, Docker log events
  components/ui/       UI primitives
  index.css            Tailwind/theme styles

src-tauri/
  tauri.conf.json      Tauri config and bundle settings
  capabilities/        Tauri permissions
  src/
    commands.rs        Tauri command handlers
    models.rs          Shared serializable DTOs
    ssh.rs             SSH connection, auth, Docker discovery
    tunnel.rs          Local, remote and dynamic forwarding runtime
    docker_logs.rs     Docker log sessions and event emission
    storage.rs         state.json persistence
    dock.rs            macOS Dock badge
    lib.rs             Tauri app setup and plugin registration
```

## Debug Automation

Debug builds register `tauri-plugin-mcp-bridge`; release builds do not include it. The project enables `withGlobalTauri` and the `mcp-bridge:default` permission for this.

## Troubleshooting

- `Tauri runtime is required for backend commands`: the app was opened through `yarn dev` in a browser. Run `yarn tauri dev`.
- `Host key mismatch`: the server key differs from the entry in `~/.ssh/known_hosts`; verify the server and update known_hosts manually.
- `Local port ... is unavailable`: the port is busy. For local and dynamic forwards, the app tries fallback ports from `50000-58000`; if no free port is available, the tunnel will not start.
- Empty Docker section: the server has no running containers, Docker is not installed, or the user does not have permission to use the Docker CLI.
- `Password authentication selected but no password was provided`: the profile uses password authentication but was saved without a password.
