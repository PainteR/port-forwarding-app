use std::collections::{BTreeMap, BTreeSet};

use chrono::Utc;

use crate::{
    models::{
        docker_cache_key, DockerContainer, OccupiedPort, OccupiedPortsSnapshot, ServerConfig,
    },
    ssh,
};

// All UDP sockets are needed here: a connected UDP socket still owns its local port.
// TCP connections are filtered below so transient outgoing connections do not look
// like deployed services. Both protocols keep the Netid column in ss output.
const SOCKET_COMMAND: &str = "if ! command -v ss >/dev/null 2>&1; then printf '%s\\n' 'ss is not installed or not in PATH; install iproute2 to scan sockets' >&2; exit 127; fi; LC_ALL=C ss -H -n -a -t -u -p";

type Ports = BTreeMap<(u16, String), PortDetails>;

#[derive(Default)]
struct PortDetails {
    addresses: BTreeSet<String>,
    processes: BTreeSet<String>,
    containers: BTreeSet<String>,
}

#[derive(Default)]
struct SocketScanSummary {
    missing_processes: bool,
    malformed_lines: usize,
}

pub fn fetch(server: &ServerConfig) -> Result<OccupiedPortsSnapshot, String> {
    let output = ssh::exec(server, SOCKET_COMMAND)?;
    let mut ports = Ports::new();
    let mut warnings = Vec::new();

    if output.exit_status == 0 {
        let summary = merge_socket_output(&output.stdout, &mut ports);
        if !output.stderr.trim().is_empty() {
            warnings.push(format!(
                "Socket scan reported a problem; results may be incomplete: {}",
                output.stderr.trim()
            ));
        }
        if summary.malformed_lines > 0 {
            warnings.push(format!(
                "Could not read {} socket entries; results may be incomplete.",
                summary.malformed_lines
            ));
        }
        if summary.missing_processes {
            warnings.push(
                "Process details are unavailable for some sockets (permissions or kernel-owned sockets)."
                    .to_string(),
            );
        }
    } else {
        let detail = if output.stderr.trim().is_empty() {
            format!("ss exited with status {}", output.exit_status)
        } else {
            output.stderr.trim().to_string()
        };
        warnings.push(format!(
            "Socket scan failed; results may be incomplete: {detail}"
        ));
    }

    // Docker may publish via NAT without a docker-proxy listening socket. Query
    // running containers now rather than trusting the persisted Docker cache.
    match ssh::fetch_docker_containers_result(server) {
        Ok(containers) => merge_docker_ports(&containers, &mut ports),
        Err(error) => warnings.push(format!(
            "Docker published ports could not be checked; results may be incomplete: {error}"
        )),
    }

    Ok(OccupiedPortsSnapshot {
        server_id: server.id.clone(),
        server_key: docker_cache_key(server),
        fetched_at: Utc::now().to_rfc3339(),
        ports: finish_ports(ports),
        warnings,
    })
}

fn merge_socket_output(stdout: &str, ports: &mut Ports) -> SocketScanSummary {
    let mut summary = SocketScanSummary::default();

    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let mut columns = line.split_whitespace();
        let Some(protocol) = columns.next().and_then(normalize_protocol) else {
            summary.malformed_lines += 1;
            continue;
        };
        let Some(state) = columns.next() else {
            summary.malformed_lines += 1;
            continue;
        };
        if protocol == "tcp" && state != "LISTEN" {
            continue;
        }

        // Recv-Q and Send-Q precede Local Address:Port and Peer Address:Port.
        let (Some(_), Some(_), Some(local), Some(_)) = (
            columns.next(),
            columns.next(),
            columns.next(),
            columns.next(),
        ) else {
            summary.malformed_lines += 1;
            continue;
        };
        let Some((address, port)) = parse_endpoint(local) else {
            summary.malformed_lines += 1;
            continue;
        };
        if port == 0 {
            continue;
        }

        let processes = parse_processes(&columns.collect::<Vec<_>>().join(" "));
        summary.missing_processes |= processes.is_empty();
        let entry = ports.entry((port, protocol.to_string())).or_default();
        entry.addresses.insert(address.to_string());
        entry.processes.extend(processes);
    }

    summary
}

fn normalize_protocol(value: &str) -> Option<&'static str> {
    match value {
        "tcp" | "tcp6" => Some("tcp"),
        "udp" | "udp6" => Some("udp"),
        _ => None,
    }
}

fn parse_endpoint(value: &str) -> Option<(&str, u16)> {
    let (address, port) = value.rsplit_once(':')?;
    let port = port.parse::<u16>().ok()?;
    let address = address
        .strip_prefix('[')
        .and_then(|address| address.strip_suffix(']'))
        .unwrap_or(address);
    if address.is_empty() {
        return None;
    }
    Some((address, port))
}

fn parse_processes(value: &str) -> Vec<String> {
    let Some((_, users)) = value.split_once("users:(") else {
        return Vec::new();
    };

    users
        .split("(\"")
        .skip(1)
        .filter_map(|process| {
            let (name, metadata) = process.split_once('"')?;
            if name.is_empty() {
                return None;
            }
            let metadata = metadata.split(')').next().unwrap_or_default();
            let pid = metadata
                .split(',')
                .find_map(|field| field.strip_prefix("pid=")?.parse::<u32>().ok());
            Some(match pid {
                Some(pid) => format!("{name} (pid {pid})"),
                None => name.to_string(),
            })
        })
        .collect()
}

fn merge_docker_ports(containers: &[DockerContainer], ports: &mut Ports) {
    for container in containers {
        let name = if container.name.is_empty() {
            &container.id
        } else {
            &container.name
        };
        for port in &container.ports {
            let Some(public_port) = port.public_port.filter(|port| *port != 0) else {
                continue;
            };
            let Some(protocol) = normalize_protocol(&port.protocol) else {
                continue;
            };
            let entry = ports
                .entry((public_port, protocol.to_string()))
                .or_default();
            entry.addresses.insert(
                port.ip
                    .as_deref()
                    .filter(|ip| !ip.is_empty())
                    .unwrap_or("*")
                    .to_string(),
            );
            entry.containers.insert(name.clone());
        }
    }
}

fn finish_ports(ports: Ports) -> Vec<OccupiedPort> {
    ports
        .into_iter()
        .map(|((port, protocol), details)| OccupiedPort {
            port,
            protocol,
            addresses: details.addresses.into_iter().collect(),
            processes: details.processes.into_iter().collect(),
            containers: details.containers.into_iter().collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::models::DockerPort;

    use super::*;

    #[test]
    fn socket_scan_merges_address_families_and_processes_in_port_order() {
        let mut ports = Ports::new();
        let summary = merge_socket_output(
            r#"tcp LISTEN 0 4096 [::]:3000 [::]:* users:(("node",pid=21,fd=4))
tcp LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=21,fd=3),("node",pid=22,fd=3))
tcp LISTEN 0 128 127.0.0.1:22 0.0.0.0:* users:(("sshd",pid=10,fd=5))
tcp LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=21,fd=3))
tcp ESTAB 0 0 10.0.0.1:49152 10.0.0.2:443 users:(("curl",pid=30,fd=3))"#,
            &mut ports,
        );
        let ports = finish_ports(ports);

        assert_eq!(summary.malformed_lines, 0);
        assert!(!summary.missing_processes);
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0].port, 22);
        assert_eq!(ports[1].port, 3000);
        assert_eq!(ports[1].addresses, ["0.0.0.0", "::"]);
        assert_eq!(ports[1].processes, ["node (pid 21)", "node (pid 22)"]);
    }

    #[test]
    fn socket_scan_keeps_connected_udp_and_missing_process_details() {
        let mut ports = Ports::new();
        let summary = merge_socket_output(
            r#"udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*
udp ESTAB 0 0 10.0.0.1:5353 10.0.0.2:53 users:(("dns worker",pid=42,fd=5))
udp UNCONN 0 0 [fe80::1%eth0]:546 [::]:*
tcp LISTEN 0 10 *:5353 *:*"#,
            &mut ports,
        );
        let ports = finish_ports(ports);

        assert_eq!(summary.malformed_lines, 0);
        assert!(summary.missing_processes);
        assert_eq!(ports.len(), 4);
        assert_eq!(ports[0].addresses, ["127.0.0.53%lo"]);
        assert!(ports[0].processes.is_empty());
        assert_eq!(ports[1].addresses, ["fe80::1%eth0"]);
        assert_eq!(ports[2].protocol, "tcp");
        assert_eq!(ports[3].protocol, "udp");
        assert_eq!(ports[3].processes, ["dns worker (pid 42)"]);
    }

    #[test]
    fn docker_nat_only_bindings_merge_with_sockets_without_exposed_only_ports() {
        let mut ports = Ports::new();
        merge_socket_output("tcp LISTEN 0 128 0.0.0.0:8080 0.0.0.0:*", &mut ports);
        let container = DockerContainer {
            id: "abc123".to_string(),
            name: "web".to_string(),
            image: "example/web".to_string(),
            status: "running".to_string(),
            ports: vec![
                DockerPort {
                    ip: Some("0.0.0.0".to_string()),
                    private_port: 80,
                    public_port: Some(8080),
                    protocol: "tcp".to_string(),
                },
                DockerPort {
                    ip: Some("::".to_string()),
                    private_port: 80,
                    public_port: Some(8080),
                    protocol: "tcp".to_string(),
                },
                DockerPort {
                    ip: Some("0.0.0.0".to_string()),
                    private_port: 3000,
                    public_port: Some(24401),
                    protocol: "tcp".to_string(),
                },
                DockerPort {
                    ip: None,
                    private_port: 9000,
                    public_port: None,
                    protocol: "tcp".to_string(),
                },
                DockerPort {
                    ip: None,
                    private_port: 53,
                    public_port: Some(5353),
                    protocol: "udp".to_string(),
                },
            ],
        };
        merge_docker_ports(&[container.clone(), container], &mut ports);
        let ports = finish_ports(ports);

        assert_eq!(ports.len(), 3);
        assert_eq!(ports[0].port, 5353);
        assert_eq!(ports[0].protocol, "udp");
        assert_eq!(ports[0].addresses, ["*"]);
        assert_eq!(ports[1].addresses, ["0.0.0.0", "::"]);
        assert_eq!(ports[1].containers, ["web"]);
        assert_eq!(ports[2].port, 24401);
        assert_eq!(ports[2].containers, ["web"]);
    }

    #[test]
    fn socket_scan_reports_unreadable_lines_instead_of_claiming_empty_results() {
        let mut ports = Ports::new();
        let summary = merge_socket_output(
            "tcp LISTEN 0 10 0.0.0.0:http 0.0.0.0:*\nudp UNCONN\nunexpected output\n",
            &mut ports,
        );
        assert_eq!(summary.malformed_lines, 3);
        assert!(ports.is_empty());
    }
}
