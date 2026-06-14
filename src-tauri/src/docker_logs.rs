use std::{
    collections::HashMap,
    io::{self, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use chrono::Utc;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::{
    models::{DockerLogChunk, DockerLogSession, DockerLogStopped, DockerLogStream, ServerConfig},
    ssh,
};

#[derive(Default)]
pub struct DockerLogManager {
    sessions: Mutex<HashMap<String, DockerLogHandle>>,
}

struct DockerLogHandle {
    server_id: String,
    stop: Arc<AtomicBool>,
}

impl DockerLogManager {
    pub fn start(
        &self,
        app: AppHandle,
        server: ServerConfig,
        container_id: String,
        container_name: String,
        initial_logs: String,
    ) -> Result<DockerLogSession, String> {
        validate_container_id(&container_id)?;

        let session = DockerLogSession {
            session_id: Uuid::new_v4().to_string(),
            server_id: server.id.clone(),
            container_id,
            container_name,
            initial_logs,
            started_at: Utc::now().to_rfc3339(),
        };

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread_session_id = session.session_id.clone();
        let thread_container_id = session.container_id.clone();

        thread::spawn(move || {
            follow_logs(
                app,
                server,
                thread_session_id,
                thread_container_id,
                thread_stop,
            );
        });

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Docker log manager lock is poisoned".to_string())?;

        sessions.insert(
            session.session_id.clone(),
            DockerLogHandle {
                server_id: session.server_id.clone(),
                stop,
            },
        );

        Ok(session)
    }

    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        let handle = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Docker log manager lock is poisoned".to_string())?;
            sessions.remove(session_id)
        };

        stop_handle(handle);
        Ok(())
    }

    pub fn stop_sessions_for_server(&self, server_id: &str) -> Result<(), String> {
        let handles = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Docker log manager lock is poisoned".to_string())?;

            let session_ids = sessions
                .iter()
                .filter_map(|(session_id, handle)| {
                    (handle.server_id == server_id).then(|| session_id.clone())
                })
                .collect::<Vec<_>>();

            session_ids
                .into_iter()
                .filter_map(|session_id| sessions.remove(&session_id))
                .collect::<Vec<_>>()
        };

        for handle in handles {
            stop_handle(Some(handle));
        }

        Ok(())
    }
}

pub fn docker_logs_command(container_id: &str, tail: u16, follow: bool) -> Result<String, String> {
    validate_container_id(container_id)?;

    let follow_flag = if follow { " -f" } else { "" };
    Ok(format!(
        "docker logs --tail {tail}{follow_flag} {container_id} 2>&1"
    ))
}

fn follow_logs(
    app: AppHandle,
    server: ServerConfig,
    session_id: String,
    container_id: String,
    stop: Arc<AtomicBool>,
) {
    let result = follow_logs_result(&app, &server, &session_id, &container_id, &stop);
    let message = result.err();

    if let Some(message) = message.as_deref() {
        emit_chunk(&app, &session_id, DockerLogStream::System, message);
    }

    let _ = app.emit(
        "docker-log-stopped",
        DockerLogStopped {
            session_id,
            message,
            timestamp: Utc::now().to_rfc3339(),
        },
    );
}

fn follow_logs_result(
    app: &AppHandle,
    server: &ServerConfig,
    session_id: &str,
    container_id: &str,
    stop: &AtomicBool,
) -> Result<(), String> {
    let session = ssh::connect(server)?;

    let mut channel = session
        .channel_session()
        .map_err(|error| format!("Failed to open Docker log channel: {error}"))?;
    let command = docker_logs_command(container_id, 0, true)?;

    channel
        .exec(&command)
        .map_err(|error| format!("Failed to execute Docker logs: {error}"))?;

    session.set_blocking(false);
    let mut buffer = [0_u8; 16 * 1024];

    while !stop.load(Ordering::SeqCst) {
        match channel.read(&mut buffer) {
            Ok(0) => {
                if channel.eof() {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Ok(size) => {
                let text = String::from_utf8_lossy(&buffer[..size]).to_string();
                emit_chunk(app, session_id, DockerLogStream::Stdout, &text);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return Err(format!("Failed to read Docker logs: {error}"));
            }
        }
    }

    if stop.load(Ordering::SeqCst) {
        let _ = channel.close();
        return Ok(());
    }

    session.set_blocking(true);
    let _ = channel.close();
    let _ = channel.wait_close();

    if !stop.load(Ordering::SeqCst) {
        match channel.exit_status() {
            Ok(0) => {}
            Ok(status) => return Err(format!("Docker logs exited with status {status}")),
            Err(error) => return Err(format!("Failed to read Docker logs exit status: {error}")),
        }
    }

    Ok(())
}

fn emit_chunk(app: &AppHandle, session_id: &str, stream: DockerLogStream, text: &str) {
    if text.is_empty() {
        return;
    }

    let _ = app.emit(
        "docker-log-chunk",
        DockerLogChunk {
            session_id: session_id.to_string(),
            stream,
            text: text.to_string(),
            timestamp: Utc::now().to_rfc3339(),
        },
    );
}

fn stop_handle(handle: Option<DockerLogHandle>) {
    let Some(handle) = handle else {
        return;
    };

    handle.stop.store(true, Ordering::SeqCst);
}

fn validate_container_id(container_id: &str) -> Result<(), String> {
    if container_id.trim().is_empty() {
        return Err("Container id is required".to_string());
    }

    if !container_id.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err("Container id is invalid".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::docker_logs_command;

    #[test]
    fn docker_logs_command_reads_initial_tail() {
        assert_eq!(
            docker_logs_command("abc123", 1000, false).expect("command should build"),
            "docker logs --tail 1000 abc123 2>&1"
        );
    }

    #[test]
    fn docker_logs_command_follows_without_replaying_tail() {
        assert_eq!(
            docker_logs_command("abc123", 0, true).expect("command should build"),
            "docker logs --tail 0 -f abc123 2>&1"
        );
    }

    #[test]
    fn docker_logs_command_rejects_shell_input() {
        assert!(docker_logs_command("abc123;rm", 1000, false).is_err());
    }
}
