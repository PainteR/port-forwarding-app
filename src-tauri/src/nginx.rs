use std::time::Duration;

use chrono::Utc;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::{
    models::{docker_cache_key, ServerConfig},
    ssh,
    storage::AppState,
};

const REMOTE_HELPER: &str = include_str!("nginx_remote.py");
// Keep SSH exec requests small; channel data can stream the full helper safely.
const REMOTE_BOOTSTRAP: &str = "import io,json,sys; envelope=json.load(sys.stdin); sys.stdin=io.StringIO(envelope['request']); exec(compile(envelope['source'], '<port-forward-nginx>', 'exec'), {'__name__':'__main__'})";
const OPERATION_TIMEOUT: Duration = Duration::from_secs(420);
const RESPONSE_PREFIX: &str = "__PORT_FORWARD_NGINX_JSON__";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NginxSettings {
    #[serde(default = "default_config_dir")]
    pub config_dir: String,
    #[serde(default = "default_webroot")]
    pub webroot: String,
    #[serde(default = "default_use_sudo")]
    pub use_sudo: bool,
}

fn default_config_dir() -> String {
    "/etc/nginx".to_string()
}

fn default_webroot() -> String {
    "/var/www/_letsencrypt".to_string()
}

fn default_use_sudo() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NginxSiteSummary {
    pub file_name: String,
    pub domains: Vec<String>,
    pub enabled: bool,
    pub has_tls: bool,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NginxSite {
    pub file_name: String,
    pub content: String,
    pub enabled: bool,
    pub revision: String,
    pub domains: Vec<String>,
    pub has_tls: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NginxSnapshot {
    pub server_id: String,
    pub server_key: String,
    pub fetched_at: String,
    pub sites: Vec<NginxSiteSummary>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteInventory {
    sites: Vec<NginxSiteSummary>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NginxOperationResult {
    pub success: bool,
    pub log: String,
    pub site: Option<NginxSite>,
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NginxSaveRequest {
    pub file_name: String,
    pub content: String,
    pub enabled: bool,
    pub expected_revision: Option<String>,
    #[serde(default)]
    pub create: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NginxProvisionRequest {
    pub file_name: String,
    pub domain: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub email: String,
    pub content: String,
    pub expected_revision: Option<String>,
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub force_renewal: bool,
}

#[tauri::command]
pub async fn list_nginx_sites(
    state: State<'_, AppState>,
    server_id: String,
    settings: NginxSettings,
) -> Result<NginxSnapshot, String> {
    let server = find_server(&state, &server_id)?;
    let server_key = docker_cache_key(&server);
    let inventory: RemoteInventory = invoke_remote(server, settings, "list", json!({})).await?;
    Ok(NginxSnapshot {
        server_id,
        server_key,
        fetched_at: Utc::now().to_rfc3339(),
        sites: inventory.sites,
        warnings: inventory.warnings,
    })
}

#[tauri::command]
pub async fn read_nginx_site(
    state: State<'_, AppState>,
    server_id: String,
    settings: NginxSettings,
    file_name: String,
) -> Result<NginxSite, String> {
    let server = find_server(&state, &server_id)?;
    invoke_remote(server, settings, "read", json!({ "fileName": file_name })).await
}

#[tauri::command]
pub async fn save_nginx_site(
    state: State<'_, AppState>,
    server_id: String,
    settings: NginxSettings,
    request: NginxSaveRequest,
) -> Result<NginxOperationResult, String> {
    let server = find_server(&state, &server_id)?;
    invoke_remote(server, settings, "save", json!({ "request": request })).await
}

#[tauri::command]
pub async fn set_nginx_site_enabled(
    state: State<'_, AppState>,
    server_id: String,
    settings: NginxSettings,
    file_name: String,
    enabled: bool,
    expected_revision: Option<String>,
) -> Result<NginxOperationResult, String> {
    let server = find_server(&state, &server_id)?;
    invoke_remote(
        server,
        settings,
        "set_enabled",
        json!({ "request": {
            "fileName": file_name,
            "enabled": enabled,
            "expectedRevision": expected_revision,
            "create": false,
        }}),
    )
    .await
}

#[tauri::command]
pub async fn test_nginx_configuration(
    state: State<'_, AppState>,
    server_id: String,
    settings: NginxSettings,
) -> Result<NginxOperationResult, String> {
    let server = find_server(&state, &server_id)?;
    invoke_remote(server, settings, "test", json!({})).await
}

#[tauri::command]
pub async fn reload_nginx_configuration(
    state: State<'_, AppState>,
    server_id: String,
    settings: NginxSettings,
) -> Result<NginxOperationResult, String> {
    let server = find_server(&state, &server_id)?;
    invoke_remote(server, settings, "reload", json!({})).await
}

#[tauri::command]
pub async fn provision_nginx_site(
    state: State<'_, AppState>,
    server_id: String,
    settings: NginxSettings,
    request: NginxProvisionRequest,
) -> Result<NginxOperationResult, String> {
    let server = find_server(&state, &server_id)?;
    invoke_remote(server, settings, "provision", json!({ "request": request })).await
}

fn find_server(state: &State<'_, AppState>, server_id: &str) -> Result<ServerConfig, String> {
    state
        .read(|store| {
            store
                .servers
                .iter()
                .find(|server| server.id == server_id)
                .cloned()
        })?
        .ok_or_else(|| "Server not found".to_string())
}

async fn invoke_remote<T: DeserializeOwned + Send + 'static>(
    server: ServerConfig,
    settings: NginxSettings,
    operation: &'static str,
    extra: Value,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let command = remote_command(settings.use_sudo);
        let mut payload = extra;
        payload["settings"] = serde_json::to_value(settings).map_err(|error| error.to_string())?;
        payload["operation"] = Value::String(operation.to_string());
        let input = remote_input(REMOTE_HELPER, &payload)?;
        let output = ssh::exec_with_input(&server, &command, &input, OPERATION_TIMEOUT)
            .map_err(|error| format!("Nginx SSH operation failed: {error}. Refresh the site to check its current state."))?;
        let response = parse_response(&output.stdout)?;
        if output.exit_status != 0 || response.get("error").is_some() {
            return Err(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Remote Nginx helper failed")
                .to_string());
        }
        serde_json::from_value(response)
            .map_err(|error| format!("Invalid Nginx helper response: {error}"))
    })
    .await
    .map_err(|error| format!("Nginx operation task failed: {error}"))?
}

fn parse_response(stdout: &str) -> Result<Value, String> {
    let lines = stdout.lines().collect::<Vec<_>>();
    let (frame_index, frame) = lines
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, line)| line.strip_prefix(RESPONSE_PREFIX).map(|frame| (index, frame)))
        .ok_or_else(|| {
            format!(
                "Nginx helper could not run. Python 3 and root access or noninteractive sudo are required. {}",
                stdout.trim().chars().take(2000).collect::<String>()
            )
        })?;
    let mut response: Value = serde_json::from_str(frame)
        .map_err(|error| format!("Invalid Nginx helper response: {error}"))?;
    let extra = lines
        .into_iter()
        .enumerate()
        .filter(|(index, _)| *index != frame_index)
        .map(|(_, line)| line)
        .collect::<Vec<_>>()
        .join("\n");
    let extra = extra.trim();
    if !extra.is_empty() {
        let warning = format!(
            "SSH output: {}",
            extra.chars().take(2000).collect::<String>()
        );
        if let Some(log) = response.get_mut("log") {
            if let Some(value) = log.as_str() {
                *log = Value::String(format!("{warning}\n{value}"));
            }
        } else if let Some(warnings) = response.get_mut("warnings").and_then(Value::as_array_mut) {
            warnings.push(Value::String(warning));
        }
    }
    Ok(response)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn remote_input(source: &str, payload: &Value) -> Result<String, String> {
    let request = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    if request.len() > 1024 * 1024 {
        return Err("Nginx request exceeds 1 MiB".to_string());
    }
    serde_json::to_string(&json!({ "source": source, "request": request }))
        .map_err(|error| error.to_string())
}

fn remote_command(use_sudo: bool) -> String {
    let python = format!("python3 -c {}", shell_quote(REMOTE_BOOTSTRAP));
    if use_sudo {
        format!("if [ \"$(id -u)\" -eq 0 ]; then exec {python}; else exec sudo -n -- {python}; fi")
    } else {
        format!("exec {python}")
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };

    use super::*;

    #[test]
    fn settings_have_noninteractive_defaults() {
        let settings: NginxSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.config_dir, "/etc/nginx");
        assert_eq!(settings.webroot, "/var/www/_letsencrypt");
        assert!(settings.use_sudo);
    }

    #[test]
    fn ssh_exec_request_is_small_and_sudo_is_noninteractive() {
        let command = remote_command(true);
        assert!(command.contains("exec sudo -n -- python3 -c '"));
        assert!(command.len() < 1024);
        assert!(!command.contains(REMOTE_HELPER));
        assert!(!remote_command(false).contains("sudo"));
    }

    #[test]
    fn bootstrap_executes_large_helper_and_preserves_request_on_stdin() {
        let source = format!(
            "{}\nimport json,sys\nprint(json.dumps(json.load(sys.stdin)))\n",
            "# helper data, not an SSH exec request\n".repeat(2000),
        );
        let payload = json!({
            "operation": "list",
            "literal": "quotes '\"; $host; $(must-not-execute); ${request_uri}\nдомен",
        });
        let input = remote_input(&source, &payload).unwrap();
        assert!(input.len() > 35_000);
        let python = if cfg!(windows) { "python" } else { "python3" };
        let mut child = Command::new(python)
            .args(["-X", "utf8", "-c", REMOTE_BOOTSTRAP])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            payload
        );
    }

    #[test]
    fn stdin_transport_still_limits_request_size() {
        let payload = json!({ "content": "x".repeat(1024 * 1024) });
        assert!(remote_input(REMOTE_HELPER, &payload)
            .unwrap_err()
            .contains("1 MiB"));
    }

    #[test]
    fn successful_mutations_remain_successful_with_sudo_warnings() {
        let response = parse_response(
            "sudo: unable to resolve host server\n__PORT_FORWARD_NGINX_JSON__{\"success\":true,\"log\":\"Applied\",\"site\":null,\"backupPath\":null}\n",
        )
        .unwrap();
        assert_eq!(response["success"], true);
        assert!(response["log"].as_str().unwrap().contains("SSH output:"));
    }
}
