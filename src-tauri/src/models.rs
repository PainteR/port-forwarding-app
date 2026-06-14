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
    pub fetched_at: String,
    pub containers: Vec<DockerContainer>,
    pub last_error: Option<String>,
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
    pub servers: Vec<ServerConfig>,
    pub forwards: Vec<ForwardConfig>,
    pub docker_caches: Vec<DockerCache>,
}

#[cfg(test)]
mod tests {
    use super::{AuthConfig, ForwardSource};
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
}
