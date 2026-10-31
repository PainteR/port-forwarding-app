//! File operations use SFTP, with one independent SSH connection per operation/transfer.
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    hash::{Hash, Hasher},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use ssh2::{FileStat, OpenFlags, OpenType, Session, Sftp};
use tauri::{ipc::Channel, State};
use uuid::Uuid;

use crate::{models::ServerConfig, ssh, storage::AppState};

const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DEPTH: usize = 128;
const MAX_ENTRIES: usize = 250_000;
const CANCELLED: &str = "Transfer cancelled";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: String,
    pub revision: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferMode {
    Sftp,
    Archive,
}

#[derive(Debug, Clone)]
pub(crate) struct TransferRequest {
    pub transfer_id: String,
    pub direction: TransferDirection,
    pub sources: Vec<String>,
    pub destination: String,
    pub mode: TransferMode,
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub transfer_id: String,
    pub bytes_transferred: u64,
    pub total_bytes: Option<u64>,
    pub files_transferred: u64,
    pub current_path: String,
    pub message: Option<String>,
}

pub(crate) struct TransferControl {
    cancelled: Arc<AtomicBool>,
    channel: Channel<TransferEvent>,
    transfer_id: String,
    last_event: Mutex<(Instant, TransferEvent)>,
}

impl TransferControl {
    #[cfg(test)]
    pub(crate) fn for_test(transfer_id: &str) -> Self {
        let event = TransferEvent {
            event_type: "progress".into(),
            transfer_id: transfer_id.into(),
            bytes_transferred: 0,
            total_bytes: None,
            files_transferred: 0,
            current_path: String::new(),
            message: None,
        };
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            channel: Channel::new(|_| Ok(())),
            transfer_id: transfer_id.into(),
            last_event: Mutex::new((Instant::now(), event)),
        }
    }
    #[cfg(test)]
    pub(crate) fn cancel_for_test(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
    pub(crate) fn progress(
        &self,
        bytes: u64,
        total: Option<u64>,
        files: u64,
        path: &str,
    ) -> Result<(), String> {
        self.check()?;
        let mut last = self
            .last_event
            .lock()
            .map_err(|_| "Transfer progress lock failed")?;
        last.1 = TransferEvent {
            event_type: "progress".into(),
            transfer_id: self.transfer_id.clone(),
            bytes_transferred: bytes,
            total_bytes: total,
            files_transferred: files,
            current_path: path.into(),
            message: None,
        };
        if last.0.elapsed().as_millis() >= 100 {
            self.channel.send(last.1.clone()).map_err(|_| {
                self.cancelled.store(true, Ordering::Relaxed);
                CANCELLED.to_string()
            })?;
            last.0 = Instant::now();
        }
        Ok(())
    }
    fn finish(&self, result: &Result<(), String>) {
        if let Ok(last) = self.last_event.lock() {
            let mut event = last.1.clone();
            event.event_type = match result {
                Ok(()) => "completed",
                Err(_) if self.is_cancelled() => "cancelled",
                Err(_) => "error",
            }
            .into();
            event.message = result.as_ref().err().cloned();
            let _ = self.channel.send(event);
        }
    }
}

#[derive(Default)]
pub struct TransferManager {
    active: Mutex<HashMap<String, (String, Arc<AtomicBool>)>>,
    pending_cancellations: Mutex<HashMap<String, Instant>>,
}

impl TransferManager {
    fn register(&self, server_id: &str, transfer_id: &str) -> Result<Arc<AtomicBool>, String> {
        if transfer_id.is_empty() || transfer_id.len() > 128 {
            return Err("Invalid transfer ID".into());
        }
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Transfer state lock failed")?;
        if active.len() >= 8 {
            return Err("At most eight transfers may run simultaneously".into());
        }
        if active.contains_key(transfer_id) {
            return Err("Transfer ID is already active".into());
        }
        let mut pending = self
            .pending_cancellations
            .lock()
            .map_err(|_| "Transfer cancellation lock failed")?;
        pending.retain(|_, created| created.elapsed() < Duration::from_secs(120));
        let cancelled = Arc::new(AtomicBool::new(pending.remove(transfer_id).is_some()));
        active.insert(transfer_id.into(), (server_id.into(), cancelled.clone()));
        Ok(cancelled)
    }
    fn remove(&self, id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(id);
        }
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Transfer state lock failed")?;
        if id.is_empty() || id.len() > 128 {
            return Err("Invalid transfer ID".into());
        }
        if let Some((_, cancelled)) = active.get(id) {
            cancelled.store(true, Ordering::Relaxed);
        } else {
            // UI cleanup may arrive before the async transfer command registers.
            // Keep a short, bounded tombstone so that cancellation still wins.
            let mut pending = self
                .pending_cancellations
                .lock()
                .map_err(|_| "Transfer cancellation lock failed")?;
            pending.retain(|_, created| created.elapsed() < Duration::from_secs(120));
            if pending.len() >= 1024 {
                if let Some(oldest) = pending
                    .iter()
                    .min_by_key(|(_, created)| **created)
                    .map(|(id, _)| id.clone())
                {
                    pending.remove(&oldest);
                }
            }
            pending.insert(id.to_owned(), Instant::now());
        }
        Ok(())
    }
    pub fn cancel_for_server(&self, server_id: &str) {
        if let Ok(active) = self.active.lock() {
            for (id, cancelled) in active.values() {
                if id == server_id {
                    cancelled.store(true, Ordering::Relaxed);
                }
            }
        }
    }
    pub fn cancel_all(&self) {
        if let Ok(active) = self.active.lock() {
            for (_, cancelled) in active.values() {
                cancelled.store(true, Ordering::Relaxed);
            }
        }
    }
}

fn server_config(
    state: &State<'_, AppState>,
    id: Option<String>,
) -> Result<Option<ServerConfig>, String> {
    id.map(|id| {
        state
            .read(|store| store.servers.iter().find(|s| s.id == id).cloned())?
            .ok_or_else(|| "Server not found".to_string())
    })
    .transpose()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("File operation failed: {e}"))?
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    server_id: Option<String>,
    path: Option<String>,
) -> Result<FileListing, String> {
    let server = server_config(&state, server_id)?;
    blocking(move || {
        let endpoint = Endpoint::new(server.as_ref())?;
        let path = endpoint.directory(path.as_deref())?;
        let mut entries = endpoint.entries(&path)?;
        entries.sort_by(|a, b| {
            (a.kind != EntryKind::Directory, a.name.to_lowercase())
                .cmp(&(b.kind != EntryKind::Directory, b.name.to_lowercase()))
        });
        Ok(FileListing {
            path: path_text(&path)?,
            entries,
        })
    })
    .await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    server_id: Option<String>,
    path: String,
) -> Result<(), String> {
    let server = server_config(&state, server_id)?;
    blocking(move || {
        let endpoint = Endpoint::new(server.as_ref())?;
        let path = mutation_path(&path)?;
        endpoint.check_parent(&path)?;
        endpoint.mkdir(&path, 0o755)
    })
    .await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    server_id: Option<String>,
    path: String,
    new_path: String,
) -> Result<(), String> {
    let server = server_config(&state, server_id)?;
    blocking(move || {
        let endpoint = Endpoint::new(server.as_ref())?;
        let source = mutation_path(&path)?;
        let target = mutation_path(&new_path)?;
        endpoint.check_parent(&source)?;
        endpoint.check_parent(&target)?;
        if endpoint.metadata(&target)?.is_some() {
            return Err(format!("Destination already exists: {}", target.display()));
        }
        endpoint.rename(&source, &target, false)
    })
    .await
}

#[tauri::command]
pub async fn sftp_delete(
    state: State<'_, AppState>,
    server_id: Option<String>,
    paths: Vec<String>,
) -> Result<(), String> {
    let server = server_config(&state, server_id)?;
    blocking(move || {
        let endpoint = Endpoint::new(server.as_ref())?;
        let paths = paths
            .iter()
            .map(|p| mutation_path(p))
            .collect::<Result<Vec<_>, _>>()?;
        for path in &paths {
            endpoint.check_parent(path)?;
        }
        for path in paths {
            endpoint.remove_tree(&path, 0)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    server_id: Option<String>,
    path: String,
    permissions: u32,
) -> Result<(), String> {
    if permissions > 0o777 {
        return Err("Permissions must be between 000 and 777".into());
    }
    let server = server_config(&state, server_id)?;
    blocking(move || {
        let endpoint = Endpoint::new(server.as_ref())?;
        let path = mutation_path(&path)?;
        endpoint.check_no_symlink(&path)?;
        endpoint.permissions(&path, permissions)
    })
    .await
}

#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, AppState>,
    server_id: Option<String>,
    path: String,
) -> Result<TextFile, String> {
    let server = server_config(&state, server_id)?;
    blocking(move || Endpoint::new(server.as_ref())?.read_text(&mutation_path(&path)?)).await
}

#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, AppState>,
    server_id: Option<String>,
    path: String,
    content: String,
    revision: String,
) -> Result<(), String> {
    if content.len() as u64 > MAX_TEXT_BYTES {
        return Err("Text editor supports files up to 2 MiB".into());
    }
    let server = server_config(&state, server_id)?;
    blocking(move || {
        let endpoint = Endpoint::new(server.as_ref())?;
        let path = mutation_path(&path)?;
        let current = endpoint.read_text(&path)?;
        if current.revision != revision {
            return Err("File changed since it was opened. Reopen it before saving.".into());
        }
        let mode = endpoint
            .required_metadata(&path)?
            .permissions
            .unwrap_or(0o644)
            & 0o777;
        endpoint.write_atomic(&path, content.as_bytes(), mode, true)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_transfer(
    state: State<'_, AppState>,
    server_id: String,
    transfer_id: String,
    direction: TransferDirection,
    sources: Vec<String>,
    destination: String,
    mode: TransferMode,
    overwrite: bool,
    on_event: Channel<TransferEvent>,
) -> Result<(), String> {
    if sources.is_empty() || sources.len() > 10_000 {
        return Err("Select between 1 and 10000 items".into());
    }
    for source in &sources {
        mutation_path(source)?;
    }
    absolute_path(&destination)?;
    // Register while holding the profile snapshot lock so a concurrent server edit
    // cannot leave a worker running with credentials that were just replaced.
    let (server, cancelled) = state.read(|store| {
        let server = store
            .servers
            .iter()
            .find(|server| server.id == server_id)
            .cloned()
            .ok_or("Server not found")?;
        let cancelled = state.transfers.register(&server_id, &transfer_id)?;
        Ok::<_, String>((server, cancelled))
    })??;
    let event = TransferEvent {
        event_type: "progress".into(),
        transfer_id: transfer_id.clone(),
        bytes_transferred: 0,
        total_bytes: None,
        files_transferred: 0,
        current_path: String::new(),
        message: None,
    };
    let request = TransferRequest {
        transfer_id: transfer_id.clone(),
        direction,
        sources,
        destination,
        mode,
        overwrite,
    };
    let control = TransferControl {
        cancelled,
        channel: on_event,
        transfer_id: request.transfer_id.clone(),
        last_event: Mutex::new((Instant::now(), event)),
    };
    let result = blocking(move || {
        let result = match request.mode {
            TransferMode::Sftp => transfer_sftp(&server, &request, &control),
            TransferMode::Archive => crate::sftp_archive::transfer(&server, &request, &control),
        };
        control.finish(&result);
        result
    })
    .await;
    state.transfers.remove(&transfer_id);
    result
}

#[tauri::command]
pub fn sftp_cancel(state: State<'_, AppState>, transfer_id: String) -> Result<(), String> {
    state.transfers.cancel(&transfer_id)
}

fn absolute_path(value: &str) -> Result<PathBuf, String> {
    if value.contains('\0') || !Path::new(value).is_absolute() {
        return Err("An absolute path is required".into());
    }
    let path = Path::new(value);
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("Paths containing . or .. are not allowed".into());
    }
    Ok(path.to_path_buf())
}

fn mutation_path(value: &str) -> Result<PathBuf, String> {
    let path = absolute_path(value)?;
    if path.parent().is_none() || path.file_name().is_none() {
        return Err("The filesystem root cannot be modified or transferred".into());
    }
    Ok(path)
}

fn path_text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("Non-UTF-8 filename is not supported: {}", path.display()))
}
fn revision(bytes: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}-{}", hasher.finish(), bytes.len())
}
fn stat_mode(mode: u32) -> EntryKind {
    match mode & 0o170000 {
        0o040000 => EntryKind::Directory,
        0o100000 => EntryKind::File,
        0o120000 => EntryKind::Symlink,
        _ => EntryKind::Other,
    }
}
fn empty_stat() -> FileStat {
    FileStat {
        size: None,
        uid: None,
        gid: None,
        perm: None,
        atime: None,
        mtime: None,
    }
}

fn remote_entry(path: &Path, stat: FileStat) -> Result<FileEntry, String> {
    Ok(FileEntry {
        name: path
            .file_name()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path_text(path)?,
        kind: stat_mode(stat.perm.unwrap_or(0)),
        size: stat.size.unwrap_or(0),
        modified: stat.mtime,
        permissions: stat.perm.map(|p| p & 0o7777),
    })
}

struct Endpoint {
    remote: Option<(Session, Sftp)>,
}
impl Endpoint {
    fn new(server: Option<&ServerConfig>) -> Result<Self, String> {
        let remote = server
            .map(|server| {
                let session = ssh::connect(server)?;
                session.set_timeout(5_000);
                let sftp = session
                    .sftp()
                    .map_err(|e| format!("SFTP subsystem unavailable: {e}"))?;
                Ok::<_, String>((session, sftp))
            })
            .transpose()?;
        Ok(Self { remote })
    }
    fn directory(&self, path: Option<&str>) -> Result<PathBuf, String> {
        let path = path.filter(|p| !p.is_empty());
        if let Some((_, sftp)) = &self.remote {
            let path = sftp
                .realpath(Path::new(path.unwrap_or(".")))
                .map_err(|e| format!("Cannot open directory: {e}"))?;
            if self.required_metadata(&path)?.kind != EntryKind::Directory {
                return Err("Path is not a directory".into());
            }
            Ok(path)
        } else {
            let path = path
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
                .ok_or("Home directory unavailable")?;
            let path =
                fs::canonicalize(&path).map_err(|e| format!("Cannot open directory: {e}"))?;
            if !path.is_dir() {
                return Err("Path is not a directory".into());
            }
            Ok(path)
        }
    }
    fn metadata(&self, path: &Path) -> Result<Option<FileEntry>, String> {
        if let Some((_, sftp)) = &self.remote {
            match sftp.lstat(path) {
                Ok(stat) => Ok(Some(remote_entry(path, stat)?)),
                Err(e)
                    if e.code() == ssh2::ErrorCode::SFTP(2)
                        || e.code() == ssh2::ErrorCode::SFTP(10) =>
                {
                    Ok(None)
                }
                Err(e) => Err(format!("Cannot inspect {}: {e}", path.display())),
            }
        } else {
            match fs::symlink_metadata(path) {
                Ok(meta) => {
                    #[cfg(unix)]
                    let permissions = {
                        use std::os::unix::fs::PermissionsExt;
                        Some(meta.permissions().mode() & 0o7777)
                    };
                    #[cfg(not(unix))]
                    let permissions = None;
                    let kind = if meta.file_type().is_symlink() {
                        EntryKind::Symlink
                    } else if meta.is_dir() {
                        EntryKind::Directory
                    } else if meta.is_file() {
                        EntryKind::File
                    } else {
                        EntryKind::Other
                    };
                    Ok(Some(FileEntry {
                        name: path
                            .file_name()
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        path: path_text(path)?,
                        kind,
                        size: meta.len(),
                        modified: meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_secs()),
                        permissions,
                    }))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(format!("Cannot inspect {}: {e}", path.display())),
            }
        }
    }
    fn required_metadata(&self, path: &Path) -> Result<FileEntry, String> {
        self.metadata(path)?
            .ok_or_else(|| format!("Path does not exist: {}", path.display()))
    }
    fn entries(&self, path: &Path) -> Result<Vec<FileEntry>, String> {
        if let Some((_, sftp)) = &self.remote {
            // READDIR already includes attributes. Avoid a round trip per row.
            sftp.readdir(path)
                .map_err(|e| format!("Cannot read {}: {e}", path.display()))?
                .into_iter()
                .map(|(child, stat)| {
                    if child.parent() != Some(path) {
                        return Err("Server returned an invalid directory entry".into());
                    }
                    remote_entry(&child, stat)
                })
                .collect()
        } else {
            fs::read_dir(path)
                .map_err(|e| format!("Cannot read {}: {e}", path.display()))?
                .map(|entry| {
                    let path = entry
                        .map_err(|e| format!("Cannot read directory entry: {e}"))?
                        .path();
                    path_text(&path)?;
                    self.required_metadata(&path)
                })
                .collect()
        }
    }
    fn transfer_entries(
        &self,
        path: &Path,
        control: &TransferControl,
    ) -> Result<Vec<FileEntry>, String> {
        let mut entries = Vec::new();
        if let Some((_, sftp)) = &self.remote {
            let mut directory = sftp
                .opendir(path)
                .map_err(|e| format!("Cannot open directory {}: {e}", path.display()))?;
            loop {
                control.check()?;
                match directory.readdir() {
                    Ok((name, stat)) => {
                        if name == Path::new(".") || name == Path::new("..") {
                            continue;
                        }
                        let mut components = name.components();
                        if !matches!(components.next(), Some(Component::Normal(_)))
                            || components.next().is_some()
                        {
                            return Err("Server returned an invalid directory entry".into());
                        }
                        if entries.len() >= MAX_ENTRIES {
                            return Err("Transfer exceeds 250000 entries".into());
                        }
                        let child = path.join(name);
                        if child.parent() != Some(path) {
                            return Err("Server returned an invalid directory entry".into());
                        }
                        entries.push(remote_entry(&child, stat)?);
                    }
                    // libssh2 uses LIBSSH2_ERROR_FILE to mark the end of READDIR.
                    Err(error) if error.code() == ssh2::ErrorCode::Session(-16) => break,
                    Err(error) => {
                        return Err(format!("Cannot read directory {}: {error}", path.display()))
                    }
                }
            }
        } else {
            for child in fs::read_dir(path)
                .map_err(|e| format!("Cannot open directory {}: {e}", path.display()))?
            {
                control.check()?;
                if entries.len() >= MAX_ENTRIES {
                    return Err("Transfer exceeds 250000 entries".into());
                }
                let path = child
                    .map_err(|e| format!("Cannot read directory entry: {e}"))?
                    .path();
                path_text(&path)?;
                entries.push(self.required_metadata(&path)?);
            }
        }
        Ok(entries)
    }
    fn check_no_symlink(&self, path: &Path) -> Result<(), String> {
        let mut current = PathBuf::new();
        for component in path.components() {
            current.push(component);
            let meta = self.required_metadata(&current)?;
            if meta.kind == EntryKind::Symlink {
                return Err(format!(
                    "Symbolic links are not followed: {}",
                    current.display()
                ));
            }
        }
        Ok(())
    }
    fn check_parent(&self, path: &Path) -> Result<(), String> {
        self.check_no_symlink(path.parent().ok_or("Path has no parent")?)
    }
    fn mkdir(&self, path: &Path, permissions: u32) -> Result<(), String> {
        if let Some((_, sftp)) = &self.remote {
            sftp.mkdir(path, permissions as i32)
                .map_err(|e| format!("Cannot create {}: {e}", path.display()))
        } else {
            fs::create_dir(path).map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
            self.permissions(path, permissions)
        }
    }
    fn permissions(&self, path: &Path, permissions: u32) -> Result<(), String> {
        if let Some((_, sftp)) = &self.remote {
            let mut stat = empty_stat();
            stat.perm = Some(permissions);
            sftp.setstat(path, stat)
                .map_err(|e| format!("Cannot set permissions: {e}"))
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(permissions))
                    .map_err(|e| format!("Cannot set permissions: {e}"))
            }
            #[cfg(not(unix))]
            {
                let _ = (path, permissions);
                Err("POSIX permissions are not supported on this platform".into())
            }
        }
    }
    fn modified(&self, path: &Path, modified: Option<u64>) -> Result<(), String> {
        let Some(modified) = modified else {
            return Ok(());
        };
        if let Some((_, sftp)) = &self.remote {
            let mut stat = empty_stat();
            stat.mtime = Some(modified);
            stat.atime = Some(modified);
            sftp.setstat(path, stat)
                .map_err(|e| format!("Cannot preserve modification time: {e}"))
        } else {
            let time = UNIX_EPOCH
                .checked_add(Duration::from_secs(modified))
                .ok_or("Invalid modification time")?;
            File::open(path)
                .and_then(|file| file.set_times(fs::FileTimes::new().set_modified(time)))
                .map_err(|e| format!("Cannot preserve modification time: {e}"))
        }
    }
    fn rename(&self, source: &Path, target: &Path, overwrite: bool) -> Result<(), String> {
        if let Some((session, sftp)) = &self.remote {
            crate::sftp_rename::remote(session, sftp, source, target, overwrite)
        } else if overwrite {
            fs::rename(source, target)
                .map_err(|e| format!("Cannot rename {}: {e}", source.display()))
        } else {
            rename_local_exclusive(source, target)
        }
    }
    fn unlink(&self, path: &Path) -> Result<(), String> {
        if let Some((_, sftp)) = &self.remote {
            sftp.unlink(path).map_err(|e| e.to_string())
        } else {
            fs::remove_file(path).map_err(|e| e.to_string())
        }
    }
    fn remove_tree(&self, path: &Path, depth: usize) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err("Directory nesting exceeds 128 levels".into());
        }
        if self.required_metadata(path)?.kind == EntryKind::Directory {
            for entry in self.entries(path)? {
                self.remove_tree(Path::new(&entry.path), depth + 1)?;
            }
            if let Some((_, sftp)) = &self.remote {
                sftp.rmdir(path)
                    .map_err(|e| format!("Cannot remove directory: {e}"))
            } else {
                fs::remove_dir(path).map_err(|e| format!("Cannot remove directory: {e}"))
            }
        } else {
            self.unlink(path)
        }
    }
    fn reader(&self, path: &Path) -> Result<Box<dyn Read>, String> {
        if let Some((_, sftp)) = &self.remote {
            Ok(Box::new(sftp.open(path).map_err(|e| {
                format!("Cannot open {}: {e}", path.display())
            })?))
        } else {
            Ok(Box::new(File::open(path).map_err(|e| {
                format!("Cannot open {}: {e}", path.display())
            })?))
        }
    }
    fn writer(&self, path: &Path, mode: u32) -> Result<OutputFile, String> {
        if let Some((_, sftp)) = &self.remote {
            sftp.open_mode(
                path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE,
                mode as i32,
                OpenType::File,
            )
            .map(OutputFile::Remote)
            .map_err(|e| format!("Cannot create temporary file: {e}"))
        } else {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map(OutputFile::Local)
                .map_err(|e| format!("Cannot create temporary file: {e}"))
        }
    }
    fn read_text(&self, path: &Path) -> Result<TextFile, String> {
        self.check_no_symlink(path)?;
        let meta = self.required_metadata(path)?;
        if meta.kind != EntryKind::File {
            return Err("Only regular files can be edited".into());
        }
        if meta.size > MAX_TEXT_BYTES {
            return Err("Text editor supports files up to 2 MiB".into());
        }
        let mut bytes = Vec::new();
        self.reader(path)?
            .take(MAX_TEXT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Cannot read text: {e}"))?;
        if bytes.len() as u64 > MAX_TEXT_BYTES {
            return Err("Text editor supports files up to 2 MiB".into());
        }
        if bytes.contains(&0) {
            return Err("Binary files cannot be edited as text".into());
        }
        let revision = revision(&bytes);
        let content =
            String::from_utf8(bytes).map_err(|_| "Only UTF-8 text files can be edited")?;
        Ok(TextFile { content, revision })
    }
    fn publish(&self, temp: &Path, target: &Path, overwrite: bool) -> Result<(), String> {
        if !overwrite && self.remote.is_none() {
            fs::hard_link(temp, target).map_err(|e| {
                format!(
                    "Cannot publish {} without overwriting: {e}",
                    target.display()
                )
            })?;
            self.unlink(temp)
        } else {
            self.rename(temp, target, overwrite)
        }
    }
    fn write_atomic(
        &self,
        path: &Path,
        bytes: &[u8],
        mode: u32,
        overwrite: bool,
    ) -> Result<(), String> {
        self.check_parent(path)?;
        if let Some(meta) = self.metadata(path)? {
            if meta.kind != EntryKind::File || !overwrite {
                return Err("Destination exists or is not a regular file".into());
            }
        }
        let temp = temporary_path(path)?;
        let result = (|| {
            let mut file = self.writer(&temp, mode)?;
            file.write_all(bytes).map_err(|e| e.to_string())?;
            file.finish()?;
            self.permissions(&temp, mode)?;
            self.publish(&temp, path, overwrite)
        })();
        if result.is_err() {
            let _ = self.unlink(&temp);
        }
        result
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn rename_local_exclusive(source: &Path, target: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source =
        CString::new(source.as_os_str().as_bytes()).map_err(|_| "Invalid source filename")?;
    let target =
        CString::new(target.as_os_str().as_bytes()).map_err(|_| "Invalid destination filename")?;
    #[cfg(target_os = "macos")]
    let result = {
        extern "C" {
            fn renamex_np(
                from: *const std::ffi::c_char,
                to: *const std::ffi::c_char,
                flags: u32,
            ) -> i32;
        }
        // RENAME_EXCL atomically rejects an existing target, including directories.
        unsafe { renamex_np(source.as_ptr(), target.as_ptr(), 0x00000004) }
    };
    #[cfg(target_os = "linux")]
    let result = {
        extern "C" {
            fn renameat2(
                from_fd: i32,
                from: *const std::ffi::c_char,
                to_fd: i32,
                to: *const std::ffi::c_char,
                flags: u32,
            ) -> i32;
        }
        unsafe { renameat2(-100, source.as_ptr(), -100, target.as_ptr(), 1) }
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "Cannot rename without overwriting: {}",
            std::io::Error::last_os_error()
        ))
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn rename_local_exclusive(source: &Path, target: &Path) -> Result<(), String> {
    if fs::symlink_metadata(target).is_ok() {
        return Err("Destination already exists".into());
    }
    fs::rename(source, target).map_err(|e| format!("Cannot rename: {e}"))
}

enum OutputFile {
    Local(File),
    Remote(ssh2::File),
}
impl Write for OutputFile {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        match self {
            Self::Local(file) => file.write(bytes),
            Self::Remote(file) => file.write(bytes),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Self::Local(file) => file.flush(),
            Self::Remote(file) => file.flush(),
        }
    }
}
impl OutputFile {
    fn finish(mut self) -> Result<(), String> {
        self.flush()
            .map_err(|e| format!("Cannot flush transfer: {e}"))?;
        match self {
            Self::Local(file) => file
                .sync_all()
                .map_err(|e| format!("Cannot sync file: {e}")),
            Self::Remote(mut file) => file
                .close()
                .map_err(|e| format!("Cannot close remote file: {e}")),
        }
    }
}
fn temporary_path(path: &Path) -> Result<PathBuf, String> {
    Ok(path
        .parent()
        .ok_or("Path has no parent")?
        .join(format!(".port-forward-{}.part", Uuid::new_v4())))
}

struct PlanItem {
    source: PathBuf,
    target: PathBuf,
    entry: FileEntry,
}
#[allow(clippy::too_many_arguments)]
fn plan_tree(
    source: &Endpoint,
    target: &Endpoint,
    path: &Path,
    destination: &Path,
    overwrite: bool,
    depth: usize,
    plan: &mut Vec<PlanItem>,
    control: &TransferControl,
) -> Result<(), String> {
    control.check()?;
    if depth > MAX_DEPTH || plan.len() >= MAX_ENTRIES {
        return Err("Transfer exceeds 128 directory levels or 250000 entries".into());
    }
    let entry = source.required_metadata(path)?;
    if !matches!(entry.kind, EntryKind::File | EntryKind::Directory) {
        return Err(format!("Only files and directories can be transferred; symbolic links and special files are not followed: {}",path.display()));
    }
    if let Some(existing) = target.metadata(destination)? {
        if !overwrite || existing.kind != entry.kind {
            return Err(format!(
                "Destination already exists: {}",
                destination.display()
            ));
        }
    }
    plan.push(PlanItem {
        source: path.into(),
        target: destination.into(),
        entry: entry.clone(),
    });
    if entry.kind == EntryKind::Directory {
        for child in source.transfer_entries(path, control)? {
            let child_path = PathBuf::from(&child.path);
            let name = child_path.file_name().ok_or("Invalid filename")?;
            plan_tree(
                source,
                target,
                &child_path,
                &destination.join(name),
                overwrite,
                depth + 1,
                plan,
                control,
            )?;
        }
    }
    Ok(())
}

pub(crate) fn transfer_sftp(
    server: &ServerConfig,
    request: &TransferRequest,
    control: &TransferControl,
) -> Result<(), String> {
    control.check()?;
    let remote = Endpoint::new(Some(server))?;
    let local = Endpoint::new(None)?;
    let (source, target) = match request.direction {
        TransferDirection::Upload => (&local, &remote),
        TransferDirection::Download => (&remote, &local),
    };
    let destination = target.directory(Some(&request.destination))?;
    target.check_no_symlink(&destination)?;
    let mut plan = Vec::new();
    let mut names = HashSet::new();
    for path in &request.sources {
        control.check()?;
        let path = mutation_path(path)?;
        source.check_no_symlink(&path)?;
        let name = path.file_name().ok_or("Source has no filename")?;
        if !names.insert(name.to_os_string()) {
            return Err("Selected items have duplicate destination names".into());
        }
        plan_tree(
            source,
            target,
            &path,
            &destination.join(name),
            request.overwrite,
            0,
            &mut plan,
            control,
        )?;
    }
    let total = plan
        .iter()
        .filter(|item| item.entry.kind == EntryKind::File)
        .try_fold(0u64, |sum, item| {
            sum.checked_add(item.entry.size)
                .ok_or("Transfer size exceeds supported range")
        })?;
    let mut bytes = 0;
    let mut files = 0;
    control.progress(0, Some(total), 0, "")?;
    for item in &plan {
        control.check()?;
        target.check_parent(&item.target)?;
        if item.entry.kind == EntryKind::Directory {
            if target.metadata(&item.target)?.is_none() {
                target.mkdir(&item.target, 0o700)?;
            } else if target.required_metadata(&item.target)?.kind != EntryKind::Directory {
                return Err(format!("Destination changed: {}", item.target.display()));
            }
            continue;
        }
        if let Some(existing) = target.metadata(&item.target)? {
            if !request.overwrite || existing.kind != EntryKind::File {
                return Err(format!(
                    "Destination exists or changed: {}",
                    item.target.display()
                ));
            }
        }
        source.check_no_symlink(&item.source)?;
        let temp = temporary_path(&item.target)?;
        let result = (|| {
            let mut reader = source.reader(&item.source)?;
            let mut writer = target.writer(&temp, 0o600)?;
            let mut buffer = vec![0; 256 * 1024];
            let mut file_bytes = 0u64;
            loop {
                control.check()?;
                let read = reader
                    .read(&mut buffer)
                    .map_err(|e| format!("Cannot read {}: {e}", item.source.display()))?;
                if read == 0 {
                    break;
                }
                writer
                    .write_all(&buffer[..read])
                    .map_err(|e| format!("Cannot write {}: {e}", item.target.display()))?;
                bytes += read as u64;
                file_bytes += read as u64;
                control.progress(bytes, Some(total), files, &item.entry.path)?;
            }
            writer.finish()?;
            if file_bytes != item.entry.size {
                return Err(format!(
                    "Source changed size during transfer: {}",
                    item.source.display()
                ));
            }
            target.modified(&temp, item.entry.modified)?;
            target.permissions(&temp, item.entry.permissions.unwrap_or(0o644) & 0o777)?;
            control.check()?;
            target.publish(&temp, &item.target, request.overwrite)
        })();
        if result.is_err() {
            let _ = target.unlink(&temp);
        }
        result?;
        files += 1;
        control.progress(bytes, Some(total), files, &item.entry.path)?;
    }
    for item in plan
        .iter()
        .rev()
        .filter(|item| item.entry.kind == EntryKind::Directory)
    {
        control.check()?;
        target.check_no_symlink(&item.target)?;
        target.modified(&item.target, item.entry.modified)?;
        target.permissions(
            &item.target,
            item.entry.permissions.unwrap_or(0o755) & 0o777,
        )?;
    }
    control.progress(bytes, Some(total), files, "")
}

#[cfg(test)]
#[path = "../tests/support/sftp_integration.rs"]
mod integration_tests;

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("port-forward-test-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn cancellation_before_registration_is_not_lost() {
        let manager = TransferManager::default();
        manager.cancel("queued").unwrap();
        let cancelled = manager.register("server", "queued").unwrap();
        assert!(cancelled.load(Ordering::Relaxed));
        assert!(manager.register("server", "queued").is_err());
        manager.remove("queued");
        let fresh = manager.register("server", "queued").unwrap();
        assert!(!fresh.load(Ordering::Relaxed));
        let temp = Temp::new();
        fs::write(temp.0.join("file"), "data").unwrap();
        let control = TransferControl::for_test("scan");
        control.cancel_for_test();
        assert!(Endpoint::new(None)
            .unwrap()
            .transfer_entries(&temp.0, &control)
            .is_err());
    }
    #[test]
    fn paths_require_absolute_and_reject_roots_and_traversal() {
        assert!(absolute_path("relative").is_err());
        assert!(mutation_path("/").is_err());
        assert!(absolute_path("/tmp/../etc").is_err());
        assert!(absolute_path("/tmp/bad\0name").is_err());
        assert!(mutation_path("/tmp/space ' quote").is_ok());
    }
    #[test]
    fn atomic_write_preserves_existing_on_conflict() {
        let temp = Temp::new();
        let endpoint = Endpoint::new(None).unwrap();
        let path = temp.0.join("text");
        fs::write(&path, "old").unwrap();
        assert!(endpoint.write_atomic(&path, b"new", 0o644, false).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old");
        endpoint.write_atomic(&path, b"new", 0o644, true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    }
    #[test]
    fn text_revision_changes_and_binary_or_oversized_is_rejected() {
        let temp = Temp::new();
        let endpoint = Endpoint::new(None).unwrap();
        let path = temp.0.join("text");
        fs::write(&path, "one").unwrap();
        let first = endpoint.read_text(&path).unwrap();
        fs::write(&path, "two").unwrap();
        assert_ne!(first.revision, endpoint.read_text(&path).unwrap().revision);
        fs::write(&path, b"\0binary").unwrap();
        assert!(endpoint.read_text(&path).is_err());
        File::create(&path)
            .unwrap()
            .set_len(MAX_TEXT_BYTES + 1)
            .unwrap();
        assert!(endpoint.read_text(&path).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn recursive_delete_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;
        let temp = Temp::new();
        let endpoint = Endpoint::new(None).unwrap();
        let outside = temp.0.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), "data").unwrap();
        let tree = temp.0.join("tree");
        fs::create_dir(&tree).unwrap();
        symlink(&outside, tree.join("link")).unwrap();
        assert!(endpoint.check_no_symlink(&tree.join("link")).is_err());
        endpoint.remove_tree(&tree, 0).unwrap();
        assert!(outside.join("keep").exists());
    }
    #[test]
    fn publish_without_overwrite_is_exclusive() {
        let temp = Temp::new();
        let endpoint = Endpoint::new(None).unwrap();
        let src = temp.0.join("part");
        let dst = temp.0.join("target");
        fs::write(&src, "new").unwrap();
        fs::write(&dst, "old").unwrap();
        assert!(endpoint.publish(&src, &dst, false).is_err());
        assert_eq!(fs::read(&dst).unwrap(), b"old");
    }
}
