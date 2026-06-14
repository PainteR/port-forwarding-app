use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::{
    dock, docker_logs,
    models::{
        DockerCache, DockerLogSession, ForwardConfig, ForwardRuntimeStatus, ForwardSource,
        SecretConfig, ServerConfig,
    },
    ssh,
    storage::AppState,
};

#[tauri::command]
pub fn list_servers(state: State<AppState>) -> Result<Vec<ServerConfig>, String> {
    state.read(|store| store.servers.clone())
}

#[tauri::command]
pub fn save_server(
    state: State<AppState>,
    mut server: ServerConfig,
) -> Result<ServerConfig, String> {
    if server.id.trim().is_empty() {
        server.id = Uuid::new_v4().to_string();
    }
    if server.name.trim().is_empty() {
        server.name = server.host.clone();
    }
    if server.port == 0 {
        server.port = 22;
    }

    state.update(|store| {
        upsert(&mut store.servers, server.clone(), |item| &item.id);
        server
    })
}

#[tauri::command]
pub fn delete_server(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let forward_ids = state.read(|store| {
        store
            .forwards
            .iter()
            .filter(|forward| forward.server_id == id)
            .map(|forward| forward.id.clone())
            .collect::<Vec<_>>()
    })?;

    for forward_id in forward_ids {
        let _ = state.tunnels.stop(&forward_id);
    }
    let _ = state.docker_logs.stop_sessions_for_server(&id);

    state.update(|store| {
        store.servers.retain(|server| server.id != id);
        store.forwards.retain(|forward| forward.server_id != id);
        store.docker_caches.retain(|cache| cache.server_id != id);
        store.secrets.retain(|secret| secret.server_id != id);
    })?;

    sync_dock_badge(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn test_connection(state: State<AppState>, server_id: String) -> Result<(), String> {
    let server = find_server(&state, &server_id)?;
    let _session = ssh::connect(&server)?;
    Ok(())
}

#[tauri::command]
pub fn list_forwards(
    state: State<AppState>,
    server_id: Option<String>,
) -> Result<Vec<ForwardConfig>, String> {
    state.read(|store| match server_id {
        Some(server_id) => store
            .forwards
            .iter()
            .filter(|forward| forward.server_id == server_id)
            .cloned()
            .collect(),
        None => store.forwards.clone(),
    })
}

#[tauri::command]
pub fn list_secrets(
    state: State<AppState>,
    server_id: Option<String>,
) -> Result<Vec<SecretConfig>, String> {
    state.read(|store| match server_id {
        Some(server_id) => store
            .secrets
            .iter()
            .filter(|secret| secret.server_id == server_id)
            .cloned()
            .collect(),
        None => store.secrets.clone(),
    })
}

#[tauri::command]
pub fn save_secret(
    state: State<AppState>,
    mut secret: SecretConfig,
) -> Result<SecretConfig, String> {
    if secret.id.trim().is_empty() {
        secret.id = Uuid::new_v4().to_string();
    }
    if secret.name.trim().is_empty() {
        secret.name = "Secret".to_string();
    }

    secret.username = normalize_optional(secret.username);
    secret.password = normalize_optional(secret.password);
    secret.url = normalize_optional(secret.url);
    secret.notes = normalize_optional(secret.notes);

    find_server(&state, &secret.server_id)?;

    state.update(|store| {
        upsert(&mut store.secrets, secret.clone(), |item| &item.id);
        secret
    })
}

#[tauri::command]
pub fn delete_secret(state: State<AppState>, id: String) -> Result<(), String> {
    state.update(|store| {
        store.secrets.retain(|secret| secret.id != id);
    })
}

#[tauri::command]
pub fn save_forward(
    state: State<AppState>,
    mut forward: ForwardConfig,
) -> Result<ForwardConfig, String> {
    if forward.id.trim().is_empty() {
        forward.id = Uuid::new_v4().to_string();
    }
    if forward.name.trim().is_empty() {
        forward.name = default_forward_name(&forward);
    }

    find_server(&state, &forward.server_id)?;

    state.update(|store| {
        upsert(&mut store.forwards, forward.clone(), |item| &item.id);
        forward
    })
}

#[tauri::command]
pub fn delete_forward(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let _ = state.tunnels.stop(&id);

    state.update(|store| {
        store.forwards.retain(|forward| forward.id != id);
    })?;

    sync_dock_badge(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn start_forward(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<ForwardRuntimeStatus, String> {
    let (server, forward) = state.read(|store| {
        let forward = store
            .forwards
            .iter()
            .find(|forward| forward.id == id)
            .cloned();
        let server = forward.as_ref().and_then(|forward| {
            store
                .servers
                .iter()
                .find(|server| server.id == forward.server_id)
                .cloned()
        });
        (server, forward)
    })?;

    let forward = forward.ok_or_else(|| "Forward not found".to_string())?;
    if !forward.enabled {
        return Err("Forward is disabled".to_string());
    }

    let server = server.ok_or_else(|| "Forward server not found".to_string())?;
    let status = state.tunnels.start(forward, server)?;
    sync_dock_badge(&app, &state);
    Ok(status)
}

#[tauri::command]
pub fn stop_forward(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<ForwardRuntimeStatus, String> {
    let status = state.tunnels.stop(&id)?;
    sync_dock_badge(&app, &state);
    Ok(status)
}

#[tauri::command]
pub fn list_forward_statuses(
    app: AppHandle,
    state: State<AppState>,
) -> Result<Vec<ForwardRuntimeStatus>, String> {
    let statuses = state.tunnels.statuses()?;
    dock::update_active_forward_badge(&app, &statuses);
    Ok(statuses)
}

#[tauri::command]
pub fn refresh_docker_containers(
    state: State<AppState>,
    server_id: String,
) -> Result<DockerCache, String> {
    let server = find_server(&state, &server_id)?;
    let cache = ssh::fetch_docker_containers(&server);

    state.update(|store| {
        upsert(&mut store.docker_caches, cache.clone(), |item| {
            &item.server_id
        });
        cache
    })
}

#[tauri::command]
pub fn list_docker_cache(
    state: State<AppState>,
    server_id: String,
) -> Result<Option<DockerCache>, String> {
    state.read(|store| {
        store
            .docker_caches
            .iter()
            .find(|cache| cache.server_id == server_id)
            .cloned()
    })
}

#[tauri::command]
pub fn start_container_logs(
    state: State<AppState>,
    app: AppHandle,
    server_id: String,
    container_id: String,
    container_name: String,
) -> Result<DockerLogSession, String> {
    let server = find_server(&state, &server_id)?;
    let command = docker_logs::docker_logs_command(&container_id, 1000, false)?;
    let output = ssh::exec(&server, &command)?;

    if output.exit_status != 0 {
        return Err(command_error(
            "Failed to read Docker logs",
            &output.stdout,
            &output.stderr,
        ));
    }

    state
        .docker_logs
        .start(app, server, container_id, container_name, output.stdout)
}

#[tauri::command]
pub fn stop_container_logs(state: State<AppState>, session_id: String) -> Result<(), String> {
    state.docker_logs.stop(&session_id)
}

fn sync_dock_badge(app: &AppHandle, state: &State<AppState>) {
    match state.tunnels.statuses() {
        Ok(statuses) => dock::update_active_forward_badge(app, &statuses),
        Err(error) => eprintln!("failed to read tunnel statuses for dock badge: {error}"),
    }
}

fn find_server(state: &State<AppState>, server_id: &str) -> Result<ServerConfig, String> {
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

fn upsert<T>(items: &mut Vec<T>, item: T, id: impl Fn(&T) -> &String) {
    if let Some(existing) = items.iter_mut().find(|existing| id(existing) == id(&item)) {
        *existing = item;
    } else {
        items.push(item);
    }
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn command_error(prefix: &str, stdout: &str, stderr: &str) -> String {
    let message = [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|message| !message.is_empty());

    match message {
        Some(message) => format!("{prefix}: {message}"),
        None => prefix.to_string(),
    }
}

fn default_forward_name(forward: &ForwardConfig) -> String {
    let prefix = match forward.source {
        ForwardSource::Manual {} => match forward.kind {
            crate::models::ForwardKind::Local => "-L",
            crate::models::ForwardKind::Remote => "-R",
            crate::models::ForwardKind::Dynamic => "-D",
        },
        ForwardSource::Docker { .. } => "Docker",
    };

    match forward.kind {
        crate::models::ForwardKind::Dynamic => {
            format!("{prefix} {}:{}", forward.bind_host, forward.bind_port)
        }
        _ => format!(
            "{prefix} {}:{} -> {}:{}",
            forward.bind_host,
            forward.bind_port,
            forward.target_host.as_deref().unwrap_or_default(),
            forward.target_port.unwrap_or_default()
        ),
    }
}
