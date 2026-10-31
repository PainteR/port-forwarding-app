use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use tauri::{AppHandle, Manager};

use crate::{
    docker_logs::DockerLogManager, models::PersistedState, terminal::TerminalManager,
    tunnel::TunnelManager,
};

pub struct AppState {
    store: Mutex<PersistedState>,
    storage_path: PathBuf,
    pub tunnels: TunnelManager,
    pub docker_logs: DockerLogManager,
    pub terminals: TerminalManager,
}

impl AppState {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let app_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

        fs::create_dir_all(&app_dir)
            .map_err(|error| format!("Failed to create app data directory: {error}"))?;

        let storage_path = app_dir.join("state.json");
        let mut store = read_store(&storage_path)?;
        if store.normalize_docker_caches() {
            write_store(&storage_path, &store)?;
        }

        Ok(Self {
            store: Mutex::new(store),
            storage_path,
            tunnels: TunnelManager::default(),
            docker_logs: DockerLogManager::default(),
            terminals: TerminalManager::default(),
        })
    }

    pub fn read<R>(&self, read: impl FnOnce(&PersistedState) -> R) -> Result<R, String> {
        let store = self
            .store
            .lock()
            .map_err(|_| "Application state lock is poisoned".to_string())?;
        Ok(read(&store))
    }

    pub fn update<R>(&self, update: impl FnOnce(&mut PersistedState) -> R) -> Result<R, String> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| "Application state lock is poisoned".to_string())?;
        let result = update(&mut store);
        write_store(&self.storage_path, &store)?;
        Ok(result)
    }
}

fn read_store(path: &Path) -> Result<PersistedState, String> {
    if !path.exists() {
        return Ok(PersistedState::default());
    }

    let contents =
        fs::read_to_string(path).map_err(|error| format!("Failed to read state file: {error}"))?;

    serde_json::from_str(&contents).map_err(|error| format!("Failed to parse state file: {error}"))
}

fn write_store(path: &Path, store: &PersistedState) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(store)
        .map_err(|error| format!("Failed to serialize state file: {error}"))?;

    fs::write(path, contents).map_err(|error| format!("Failed to write state file: {error}"))
}
