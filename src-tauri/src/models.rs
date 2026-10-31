use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthConfig,
    pub connect_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
pub enum AuthConfig {
    Agent,
    KeyFile {
        #[serde(rename = "privateKeyPath", alias = "private_key_path")]
        private_key_path: String,
        passphrase: Option<String>,
    },
    Password {
        password: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretConfig {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub url: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardConfig {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub kind: ForwardKind,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub enabled: bool,
    pub auto_start: bool,
    pub source: ForwardSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ForwardKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardSource {
    Manual {},
    Docker {
        #[serde(rename = "containerId", alias = "container_id")]
        container_id: String,
        #[serde(rename = "containerName", alias = "container_name")]
        container_name: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub ports: Vec<DockerPort>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerPort {
    pub ip: Option<String>,
    pub private_port: u16,
    pub public_port: Option<u16>,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerCache {
    pub server_id: String,
    #[serde(default)]
    pub server_key: String,
    pub fetched_at: String,
    pub containers: Vec<DockerContainer>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OccupiedPort {
    pub port: u16,
    pub protocol: String,
    pub addresses: Vec<String>,
    pub processes: Vec<String>,
    pub containers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OccupiedPortsSnapshot {
    pub server_id: String,
    pub server_key: String,
    pub fetched_at: String,
    pub ports: Vec<OccupiedPort>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerLogSession {
    pub session_id: String,
    pub server_id: String,
    pub container_id: String,
    pub container_name: String,
    pub initial_logs: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerLogChunk {
    pub session_id: String,
    pub stream: DockerLogStream,
    pub text: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DockerLogStream {
    Stdout,
    Stderr,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerLogStopped {
    pub session_id: String,
    pub message: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRuntimeStatus {
    pub forward_id: String,
    pub state: RuntimeState,
    pub message: Option<String>,
    pub bound_host: Option<String>,
    pub bound_port: Option<u16>,
    pub started_at: Option<String>,
    pub updated_at: String,
    pub reconnects: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeState {
    Starting,
    Running,
    Reconnecting,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    #[serde(default)]
    pub servers: Vec<ServerConfig>,
    #[serde(default)]
    pub forwards: Vec<ForwardConfig>,
    #[serde(default)]
    pub docker_caches: Vec<DockerCache>,
    #[serde(default)]
    pub secrets: Vec<SecretConfig>,
}

impl PersistedState {
    pub fn normalize_docker_caches(&mut self) -> bool {
        let original_len = self.docker_caches.len();
        let server_keys = self
            .servers
            .iter()
            .map(|server| (server.id.clone(), docker_cache_key(server)))
            .collect::<HashMap<_, _>>();
        let mut latest_by_server = HashMap::<String, DockerCache>::new();

        for cache in self.docker_caches.drain(..) {
            let Some(expected_key) = server_keys.get(&cache.server_id) else {
                continue;
            };

            if cache.server_key != *expected_key {
                continue;
            }

            match latest_by_server.entry(cache.server_id.clone()) {
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    if cache.fetched_at >= entry.get().fetched_at {
                        entry.insert(cache);
                    }
                }
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(cache);
                }
            }
        }

        self.docker_caches = self
            .servers
            .iter()
            .filter_map(|server| latest_by_server.remove(&server.id))
            .collect();

        self.docker_caches.len() != original_len
    }
}

pub fn docker_cache_key(server: &ServerConfig) -> String {
    format!(
        "{}@{}:{}",
        server.username.trim(),
        server.host.trim(),
        server.port
    )
}

#[cfg(test)]
mod tests {
    use super::{docker_cache_key, AuthConfig, ForwardSource, PersistedState, ServerConfig};
    use serde_json::json;

    #[test]
    fn key_file_auth_uses_camel_case_private_key_path() {
        let auth: AuthConfig = serde_json::from_value(json!({
            "method": "keyFile",
            "privateKeyPath": "/Users/painter/.ssh/id_ed25519",
            "passphrase": null
        }))
        .expect("camelCase key file auth should deserialize");

        assert_eq!(
            serde_json::to_value(auth).expect("auth should serialize"),
            json!({
                "method": "keyFile",
                "privateKeyPath": "/Users/painter/.ssh/id_ed25519",
                "passphrase": null
            })
        );
    }

    #[test]
    fn key_file_auth_accepts_legacy_snake_case_private_key_path() {
        let auth: AuthConfig = serde_json::from_value(json!({
            "method": "keyFile",
            "private_key_path": "/Users/painter/.ssh/id_ed25519",
            "passphrase": null
        }))
        .expect("legacy snake_case key file auth should deserialize");

        assert_eq!(
            serde_json::to_value(auth).expect("auth should serialize"),
            json!({
                "method": "keyFile",
                "privateKeyPath": "/Users/painter/.ssh/id_ed25519",
                "passphrase": null
            })
        );
    }

    #[test]
    fn docker_forward_source_uses_camel_case_fields() {
        let source: ForwardSource = serde_json::from_value(json!({
            "docker": {
                "containerId": "abc123",
                "containerName": "phpmyadmin"
            }
        }))
        .expect("camelCase Docker source should deserialize");

        let serialized = serde_json::to_value(source).expect("source should serialize");

        assert_eq!(
            serialized,
            json!({
                "docker": {
                    "containerId": "abc123",
                    "containerName": "phpmyadmin"
                }
            })
        );
    }

    #[test]
    fn docker_forward_source_accepts_legacy_snake_case_fields() {
        let source: ForwardSource = serde_json::from_value(json!({
            "docker": {
                "container_id": "abc123",
                "container_name": "phpmyadmin"
            }
        }))
        .expect("legacy snake_case Docker source should deserialize");

        assert_eq!(
            serde_json::to_value(source).expect("source should serialize"),
            json!({
                "docker": {
                    "containerId": "abc123",
                    "containerName": "phpmyadmin"
                }
            })
        );
    }

    #[test]
    fn persisted_state_accepts_missing_secrets() {
        let state: PersistedState = serde_json::from_value(json!({
            "servers": [],
            "forwards": [],
            "dockerCaches": []
        }))
        .expect("older state files without secrets should deserialize");

        assert!(state.secrets.is_empty());
    }

    #[test]
    fn docker_cache_key_uses_connection_identity() {
        let server = server("server-a", "Production", " root ", " example.com ");

        assert_eq!(docker_cache_key(&server), "root@example.com:22");
    }

    #[test]
    fn persisted_state_discards_orphan_and_legacy_docker_caches() {
        let mut state: PersistedState = serde_json::from_value(json!({
            "servers": [
                server_json("server-a", "Production", "root", "example.com"),
                server_json("server-b", "Staging", "deploy", "staging.example.com")
            ],
            "forwards": [],
            "secrets": [],
            "dockerCaches": [
                {
                    "serverId": "server-a",
                    "fetchedAt": "2026-07-04T09:00:00+00:00",
                    "containers": [],
                    "lastError": null
                },
                {
                    "serverId": "deleted-server",
                    "serverKey": "root@deleted.example.com:22",
                    "fetchedAt": "2026-07-04T10:00:00+00:00",
                    "containers": [],
                    "lastError": null
                },
                {
                    "serverId": "server-b",
                    "serverKey": "deploy@old-staging.example.com:22",
                    "fetchedAt": "2026-07-04T11:00:00+00:00",
                    "containers": [],
                    "lastError": null
                }
            ]
        }))
        .expect("state should deserialize");

        assert!(state.normalize_docker_caches());

        assert!(state.docker_caches.is_empty());
    }

    #[test]
    fn persisted_state_keeps_latest_docker_cache_per_server() {
        let mut state: PersistedState = serde_json::from_value(json!({
            "servers": [
                server_json("server-a", "Production", "root", "example.com")
            ],
            "forwards": [],
            "secrets": [],
            "dockerCaches": [
                {
                    "serverId": "server-a",
                    "serverKey": "root@example.com:22",
                    "fetchedAt": "2026-07-04T09:00:00+00:00",
                    "containers": [
                        container_json("old123", "old")
                    ],
                    "lastError": null
                },
                {
                    "serverId": "server-a",
                    "serverKey": "root@example.com:22",
                    "fetchedAt": "2026-07-04T10:00:00+00:00",
                    "containers": [
                        container_json("new123", "new")
                    ],
                    "lastError": null
                }
            ]
        }))
        .expect("state should deserialize");

        assert!(state.normalize_docker_caches());

        assert_eq!(state.docker_caches.len(), 1);
        assert_eq!(state.docker_caches[0].server_id, "server-a");
        assert_eq!(state.docker_caches[0].containers[0].id, "new123");
    }

    fn server(id: &str, name: &str, username: &str, host: &str) -> ServerConfig {
        serde_json::from_value(server_json(id, name, username, host)).expect("server should parse")
    }

    fn server_json(id: &str, name: &str, username: &str, host: &str) -> serde_json::Value {
        json!({
            "id": id,
            "name": name,
            "host": host,
            "port": 22,
            "username": username,
            "auth": {
                "method": "agent"
            },
            "connectTimeoutMs": null
        })
    }

    fn container_json(id: &str, name: &str) -> serde_json::Value {
        json!({
            "id": id,
            "name": name,
            "image": "example:latest",
            "status": "running",
            "ports": []
        })
    }
}
