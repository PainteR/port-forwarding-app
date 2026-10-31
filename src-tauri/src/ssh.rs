use std::{
    env,
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use serde_json::Value;
use ssh2::{CheckResult, KnownHostFileKind, Session};

use crate::models::{
    docker_cache_key, AuthConfig, DockerCache, DockerContainer, DockerPort, ServerConfig,
};

const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 10_000;

pub fn connect(server: &ServerConfig) -> Result<Session, String> {
    connect_with_io_timeout(server, None)
}

fn connect_with_io_timeout(
    server: &ServerConfig,
    command_timeout: Option<Duration>,
) -> Result<Session, String> {
    let address = resolve_address(server)?;
    let timeout = Duration::from_millis(
        server
            .connect_timeout_ms
            .unwrap_or(DEFAULT_CONNECT_TIMEOUT_MS),
    );

    let tcp = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("Failed to connect to {}: {error}", server.host))?;
    tcp.set_read_timeout(Some(timeout)).ok();
    tcp.set_write_timeout(Some(timeout)).ok();
    let command_socket = command_timeout
        .map(|_| {
            tcp.try_clone()
                .map_err(|error| format!("Failed to configure SSH command timeout: {error}"))
        })
        .transpose()?;

    let mut session =
        Session::new().map_err(|error| format!("Failed to create SSH session: {error}"))?;
    session.set_tcp_stream(tcp);
    session.set_timeout(timeout.as_millis().min(u32::MAX as u128) as u32);
    session
        .handshake()
        .map_err(|error| format!("SSH handshake failed: {error}"))?;

    verify_known_host(&session, server)?;
    authenticate(&session, server)?;
    session.set_keepalive(true, 30);
    if let (Some(socket), Some(timeout)) = (command_socket, command_timeout) {
        socket
            .set_read_timeout(Some(timeout))
            .and_then(|_| socket.set_write_timeout(Some(timeout)))
            .map_err(|error| format!("Failed to set SSH command timeout: {error}"))?;
        session.set_timeout(timeout.as_millis().min(u32::MAX as u128) as u32);
    }

    Ok(session)
}

pub fn exec(server: &ServerConfig, command: &str) -> Result<CommandOutput, String> {
    let session = connect(server)?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("Failed to open SSH command channel: {error}"))?;

    channel
        .exec(command)
        .map_err(|error| format!("Failed to execute remote command: {error}"))?;

    let mut stdout = String::new();
    let mut stderr = String::new();

    channel
        .read_to_string(&mut stdout)
        .map_err(|error| format!("Failed to read remote stdout: {error}"))?;
    channel
        .stderr()
        .read_to_string(&mut stderr)
        .map_err(|error| format!("Failed to read remote stderr: {error}"))?;
    channel
        .wait_close()
        .map_err(|error| format!("Failed to close remote command channel: {error}"))?;

    let exit_status = channel
        .exit_status()
        .map_err(|error| format!("Failed to read remote command exit status: {error}"))?;

    Ok(CommandOutput {
        stdout,
        stderr,
        exit_status,
    })
}

/// Run a bounded, noninteractive command with JSON or other text on stdin.
/// Merging extended data avoids a blocked stderr stream while a command runs.
pub fn exec_with_input(
    server: &ServerConfig,
    command: &str,
    input: &str,
    timeout: Duration,
) -> Result<CommandOutput, String> {
    let session = connect_with_io_timeout(server, Some(timeout))?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("Failed to open SSH command channel: {error}"))?;
    channel
        .handle_extended_data(ssh2::ExtendedData::Merge)
        .map_err(|error| format!("Failed to configure SSH command output: {error}"))?;
    channel
        .exec(command)
        .map_err(|error| format!("Failed to execute remote command: {error}"))?;
    channel
        .write_all(input.as_bytes())
        .map_err(|error| format!("Failed to send remote command input: {error}"))?;
    channel
        .send_eof()
        .map_err(|error| format!("Failed to finish remote command input: {error}"))?;
    let mut stdout = String::new();
    channel
        .read_to_string(&mut stdout)
        .map_err(|error| format!("Failed to read remote command output: {error}"))?;
    channel
        .wait_close()
        .map_err(|error| format!("Failed to close remote command channel: {error}"))?;
    let exit_status = channel
        .exit_status()
        .map_err(|error| format!("Failed to read remote command exit status: {error}"))?;

    Ok(CommandOutput {
        stdout,
        stderr: String::new(),
        exit_status,
    })
}

pub fn fetch_docker_containers(server: &ServerConfig) -> DockerCache {
    let result = fetch_docker_containers_result(server);

    match result {
        Ok(containers) => DockerCache {
            server_id: server.id.clone(),
            server_key: docker_cache_key(server),
            fetched_at: Utc::now().to_rfc3339(),
            containers,
            last_error: None,
        },
        Err(error) => DockerCache {
            server_id: server.id.clone(),
            server_key: docker_cache_key(server),
            fetched_at: Utc::now().to_rfc3339(),
            containers: Vec::new(),
            last_error: Some(error),
        },
    }
}

pub(crate) fn fetch_docker_containers_result(
    server: &ServerConfig,
) -> Result<Vec<DockerContainer>, String> {
    let ids_output = exec(
        server,
        "if ! command -v docker >/dev/null 2>&1; then printf '%s\\n' 'Docker is not installed or not in PATH' >&2; exit 127; fi; docker ps -q",
    )?;

    if ids_output.exit_status != 0 {
        return Err(if ids_output.stderr.trim().is_empty() {
            "Failed to query Docker containers".to_string()
        } else {
            ids_output.stderr.trim().to_string()
        });
    }

    let ids = ids_output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| line.chars().all(|char| char.is_ascii_hexdigit()))
        .collect::<Vec<_>>();

    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let inspect_command = format!("docker inspect {}", ids.join(" "));
    let inspect_output = exec(server, &inspect_command)?;

    if inspect_output.exit_status != 0 {
        return Err(if inspect_output.stderr.trim().is_empty() {
            "Failed to inspect Docker containers".to_string()
        } else {
            inspect_output.stderr.trim().to_string()
        });
    }

    parse_docker_inspect(&inspect_output.stdout)
}

fn parse_docker_inspect(stdout: &str) -> Result<Vec<DockerContainer>, String> {
    let value: Value = serde_json::from_str(stdout)
        .map_err(|error| format!("Failed to parse Docker inspect JSON: {error}"))?;

    let containers = value
        .as_array()
        .ok_or_else(|| "Docker inspect did not return an array".to_string())?
        .iter()
        .map(parse_container)
        .collect::<Vec<_>>();

    Ok(containers)
}

fn parse_container(value: &Value) -> DockerContainer {
    let id = value
        .get("Id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(12)
        .collect::<String>();
    let name = value
        .get("Name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_start_matches('/')
        .to_string();
    let image = value
        .get("Config")
        .and_then(|config| config.get("Image"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let status = value
        .get("State")
        .and_then(|state| state.get("Status"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    DockerContainer {
        id,
        name,
        image,
        status,
        ports: parse_ports(value),
    }
}

fn parse_ports(value: &Value) -> Vec<DockerPort> {
    let Some(ports) = value
        .get("NetworkSettings")
        .and_then(|settings| settings.get("Ports"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };

    let mut parsed = Vec::new();

    for (container_port, bindings) in ports {
        let Some((private_port, protocol)) = container_port.split_once('/') else {
            continue;
        };
        let Ok(private_port) = private_port.parse::<u16>() else {
            continue;
        };

        match bindings {
            Value::Array(items) => {
                for item in items {
                    let public_port = item
                        .get("HostPort")
                        .and_then(Value::as_str)
                        .and_then(|port| port.parse::<u16>().ok());
                    let ip = item
                        .get("HostIp")
                        .and_then(Value::as_str)
                        .filter(|ip| !ip.is_empty())
                        .map(ToString::to_string);

                    parsed.push(DockerPort {
                        ip,
                        private_port,
                        public_port,
                        protocol: protocol.to_string(),
                    });
                }
            }
            Value::Null => {
                parsed.push(DockerPort {
                    ip: None,
                    private_port,
                    public_port: None,
                    protocol: protocol.to_string(),
                });
            }
            _ => {}
        }
    }

    parsed
}

fn resolve_address(server: &ServerConfig) -> Result<SocketAddr, String> {
    (server.host.as_str(), server.port)
        .to_socket_addrs()
        .map_err(|error| format!("Failed to resolve {}:{}: {error}", server.host, server.port))?
        .next()
        .ok_or_else(|| format!("No address found for {}:{}", server.host, server.port))
}

fn verify_known_host(session: &Session, server: &ServerConfig) -> Result<(), String> {
    let Some(path) = known_hosts_path() else {
        return Ok(());
    };

    if !path.exists() {
        return Ok(());
    }

    let (key, _) = session
        .host_key()
        .ok_or_else(|| "SSH server did not provide a host key".to_string())?;

    let mut known_hosts = session
        .known_hosts()
        .map_err(|error| format!("Failed to initialize known_hosts: {error}"))?;
    known_hosts
        .read_file(&path, KnownHostFileKind::OpenSSH)
        .map_err(|error| format!("Failed to read known_hosts: {error}"))?;

    match known_hosts.check_port(&server.host, server.port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::NotFound => Ok(()),
        CheckResult::Mismatch => Err(format!(
            "Host key mismatch for {}:{}. Check ~/.ssh/known_hosts.",
            server.host, server.port
        )),
        CheckResult::Failure => Err(format!(
            "Failed to verify host key for {}:{}",
            server.host, server.port
        )),
    }
}

fn authenticate(session: &Session, server: &ServerConfig) -> Result<(), String> {
    match &server.auth {
        AuthConfig::Agent => session
            .userauth_agent(&server.username)
            .map_err(|error| format!("SSH agent authentication failed: {error}"))?,
        AuthConfig::KeyFile {
            private_key_path,
            passphrase,
        } => session
            .userauth_pubkey_file(
                &server.username,
                None,
                Path::new(private_key_path),
                passphrase.as_deref(),
            )
            .map_err(|error| format!("SSH key authentication failed: {error}"))?,
        AuthConfig::Password { password } => {
            let Some(password) = password else {
                return Err(
                    "Password authentication selected but no password was provided".to_string(),
                );
            };
            session
                .userauth_password(&server.username, password)
                .map_err(|error| format!("SSH password authentication failed: {error}"))?
        }
    }

    if session.authenticated() {
        Ok(())
    } else {
        Err("SSH authentication did not complete".to_string())
    }
}

fn known_hosts_path() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".ssh").join("known_hosts"))
}

#[derive(Debug, Clone)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_status: i32,
}
