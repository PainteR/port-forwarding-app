use std::{
    collections::{HashMap, VecDeque},
    io::{self, Read, Write},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use ssh2::{ErrorCode, ExtendedData};
use tauri::ipc::Channel;
use uuid::Uuid;

use crate::{models::ServerConfig, ssh};

const MAX_SESSIONS: usize = 8;
const MAX_INPUT_CHUNK: usize = 16 * 1024;
const MAX_QUEUED_INPUT: usize = 256 * 1024;
const OUTPUT_WINDOW: usize = 128 * 1024;
const READ_CHUNK: usize = 16 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(8);

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalEvent {
    Ready,
    Data {
        data: Vec<u8>,
    },
    Closed {
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
        message: Option<String>,
    },
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalHandle>>>>,
}

struct TerminalHandle {
    server_id: String,
    control: Mutex<Control>,
    wake: Condvar,
}

#[derive(Default)]
struct Control {
    stopped: bool,
    input: VecDeque<Vec<u8>>,
    queued_input: usize,
    resize: Option<(u32, u32)>,
    unacknowledged: usize,
}

impl Control {
    fn enqueue(&mut self, data: Vec<u8>) -> Result<(), String> {
        if self.stopped {
            return Err("Terminal session is closed".to_string());
        }
        if data.len() > MAX_INPUT_CHUNK {
            return Err("Terminal input chunk exceeds 16 KiB".to_string());
        }
        if self.queued_input + data.len() > MAX_QUEUED_INPUT {
            return Err("Terminal input queue is full".to_string());
        }
        if !data.is_empty() {
            self.queued_input += data.len();
            self.input.push_back(data);
        }
        Ok(())
    }

    fn acknowledge(&mut self, bytes: usize) -> Result<(), String> {
        if bytes > self.unacknowledged {
            return Err("Terminal acknowledgement exceeds pending output".to_string());
        }
        self.unacknowledged -= bytes;
        Ok(())
    }
}

impl TerminalHandle {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Control>, String> {
        self.control
            .lock()
            .map_err(|_| "Terminal session lock is poisoned".to_string())
    }

    fn stop(&self) {
        if let Ok(mut control) = self.control.lock() {
            control.stopped = true;
            control.input.clear();
        }
        self.wake.notify_one();
    }

    fn stopped(&self) -> bool {
        self.control.lock().map_or(true, |control| control.stopped)
    }
}

impl TerminalManager {
    pub fn open(
        &self,
        server: ServerConfig,
        session_id: String,
        cols: u32,
        rows: u32,
        events: Channel<TerminalEvent>,
    ) -> Result<(), String> {
        Uuid::parse_str(&session_id).map_err(|_| "Invalid terminal session ID".to_string())?;
        validate_size(cols, rows)?;
        let handle = Arc::new(TerminalHandle {
            server_id: server.id.clone(),
            control: Mutex::new(Control::default()),
            wake: Condvar::new(),
        });
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Terminal manager lock is poisoned".to_string())?;
        if sessions.contains_key(&session_id) {
            return Err("Terminal session already exists".to_string());
        }
        if sessions.len() >= MAX_SESSIONS {
            return Err("Close a terminal before opening another (maximum 8 sessions)".to_string());
        }
        sessions.insert(session_id.clone(), Arc::clone(&handle));
        let registry = Arc::clone(&self.sessions);
        let worker_id = session_id.clone();
        let spawned = thread::Builder::new()
            .name("ssh-terminal".to_string())
            .spawn(move || {
                let result = run_terminal(&server, cols, rows, &events, &handle);
                let (exit_code, message) = match result {
                    Ok(exit_code) => (exit_code, None),
                    Err(_) if handle.stopped() => (None, None),
                    Err(message) => (None, Some(message)),
                };
                handle.stop();
                // Remove before notifying the UI so a closed session occupies no slot.
                if let Ok(mut sessions) = registry.lock() {
                    sessions.remove(&worker_id);
                }
                let _ = events.send(TerminalEvent::Closed { exit_code, message });
            });
        if let Err(error) = spawned {
            sessions.remove(&session_id);
            return Err(format!("Failed to start terminal worker: {error}"));
        }
        Ok(())
    }

    pub fn write(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        let handle = self.find(session_id)?;
        handle.lock()?.enqueue(data)?;
        handle.wake.notify_one();
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        validate_size(cols, rows)?;
        let handle = self.find(session_id)?;
        handle.lock()?.resize = Some((cols, rows));
        handle.wake.notify_one();
        Ok(())
    }

    pub fn acknowledge(&self, session_id: &str, bytes: usize) -> Result<(), String> {
        // A final xterm write callback can acknowledge after the remote shell exited.
        let handle = match self.find(session_id) {
            Ok(handle) => handle,
            Err(_) => return Ok(()),
        };
        handle.lock()?.acknowledge(bytes)?;
        handle.wake.notify_one();
        Ok(())
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        if let Ok(handle) = self.find(session_id) {
            handle.stop();
        }
        Ok(())
    }

    pub fn close_for_server(&self, server_id: &str) {
        if let Ok(sessions) = self.sessions.lock() {
            for handle in sessions.values().filter(|item| item.server_id == server_id) {
                handle.stop();
            }
        }
    }

    pub fn close_all(&self) {
        if let Ok(sessions) = self.sessions.lock() {
            for handle in sessions.values() {
                handle.stop();
            }
        }
    }

    fn find(&self, session_id: &str) -> Result<Arc<TerminalHandle>, String> {
        self.sessions
            .lock()
            .map_err(|_| "Terminal manager lock is poisoned".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Terminal session is closed".to_string())
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        self.close_all();
    }
}

fn validate_size(cols: u32, rows: u32) -> Result<(), String> {
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err("Terminal dimensions must be 2–1000 columns and 1–1000 rows".to_string());
    }
    Ok(())
}

struct PendingInput {
    data: Vec<u8>,
    offset: usize,
}

impl PendingInput {
    fn write_to(&mut self, writer: &mut impl Write) -> io::Result<usize> {
        match writer.write(&self.data[self.offset..]) {
            Ok(0) => Err(io::Error::new(io::ErrorKind::WriteZero, "SSH input closed")),
            Ok(size) => {
                self.offset += size;
                Ok(size)
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(0),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => Ok(0),
            Err(error) => Err(error),
        }
    }

    fn finished(&self) -> bool {
        self.offset == self.data.len()
    }
}

fn run_terminal(
    server: &ServerConfig,
    cols: u32,
    rows: u32,
    events: &Channel<TerminalEvent>,
    handle: &TerminalHandle,
) -> Result<Option<i32>, String> {
    if handle.stopped() {
        return Ok(None);
    }
    let session = ssh::connect(server)?;
    if handle.stopped() {
        return Ok(None);
    }
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("Failed to open SSH terminal: {error}"))?;
    channel
        .handle_extended_data(ExtendedData::Merge)
        .map_err(|error| format!("Failed to configure terminal output: {error}"))?;
    channel
        .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
        .map_err(|error| format!("Failed to request remote terminal: {error}"))?;
    if handle.stopped() {
        return Ok(None);
    }
    channel
        .shell()
        .map_err(|error| format!("Failed to start remote shell: {error}"))?;
    session.set_blocking(false);
    events
        .send(TerminalEvent::Ready)
        .map_err(|_| "Terminal view disconnected".to_string())?;

    let mut buffer = [0_u8; READ_CHUNK];
    let mut pending_input: Option<PendingInput> = None;
    let mut pending_resize = None;
    let mut next_keepalive = Instant::now() + Duration::from_secs(20);
    while !handle.stopped() {
        let mut progressed = false;
        let read_limit = {
            let mut control = handle.lock()?;
            if pending_input.is_none() {
                pending_input = control
                    .input
                    .pop_front()
                    .map(|data| PendingInput { data, offset: 0 });
            }
            if pending_resize.is_none() {
                pending_resize = control.resize.take();
            }
            (OUTPUT_WINDOW - control.unacknowledged).min(READ_CHUNK)
        };

        if let Some((cols, rows)) = pending_resize {
            match channel.request_pty_size(cols, rows, None, None) {
                Ok(()) => {
                    pending_resize = None;
                    progressed = true;
                }
                Err(error) if would_block(&error) => {}
                Err(error) => return Err(format!("Failed to resize remote terminal: {error}")),
            }
        }
        if let Some(input) = &mut pending_input {
            let size = input
                .write_to(&mut channel)
                .map_err(|error| format!("Failed to write terminal input: {error}"))?;
            handle.lock()?.queued_input -= size;
            progressed |= size != 0;
            if input.finished() {
                pending_input = None;
            }
        }
        if read_limit != 0 {
            match channel.read(&mut buffer[..read_limit]) {
                Ok(0) if channel.eof() => break,
                Ok(0) => {}
                Ok(size) => {
                    // Reserve before sending: JS can acknowledge immediately.
                    handle.lock()?.unacknowledged += size;
                    events
                        .send(TerminalEvent::Data {
                            data: buffer[..size].to_vec(),
                        })
                        .map_err(|_| "Terminal view disconnected".to_string())?;
                    progressed = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(format!("Failed to read terminal output: {error}")),
            }
        }
        if Instant::now() >= next_keepalive {
            match session.keepalive_send() {
                Ok(seconds) => {
                    next_keepalive = Instant::now() + Duration::from_secs(u64::from(seconds.max(1)))
                }
                Err(error) if would_block(&error) => {
                    next_keepalive = Instant::now() + Duration::from_secs(1)
                }
                Err(error) => return Err(format!("SSH terminal disconnected: {error}")),
            }
        }
        if !progressed {
            let control = handle.lock()?;
            if !control.stopped {
                drop(handle.wake.wait_timeout(control, POLL_INTERVAL));
            }
        }
    }

    if handle.stopped() {
        // Keep cleanup nonblocking; dropping this dedicated session closes its socket.
        let _ = channel.close();
        return Ok(None);
    }
    // EOF can precede the SSH close/exit-status packet. Give it a bounded drain.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match channel.close() {
            Ok(()) => break,
            Err(error) if would_block(&error) && Instant::now() < deadline && !handle.stopped() => {
                thread::sleep(POLL_INTERVAL);
            }
            _ => return Ok(None),
        }
    }
    loop {
        match channel.wait_close() {
            Ok(()) => return Ok(channel.exit_status().ok()),
            Err(error) if would_block(&error) && Instant::now() < deadline && !handle.stopped() => {
                thread::sleep(POLL_INTERVAL);
            }
            _ => return Ok(None),
        }
    }
}

fn would_block(error: &ssh2::Error) -> bool {
    error.code() == ErrorCode::Session(-37)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PartialWriter {
        bytes: Vec<u8>,
        calls: usize,
    }

    impl Write for PartialWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.calls += 1;
            if self.calls == 2 {
                return Err(io::ErrorKind::WouldBlock.into());
            }
            let size = bytes.len().min(2);
            self.bytes.extend_from_slice(&bytes[..size]);
            Ok(size)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn partial_writes_and_would_block_preserve_exact_input() {
        let data = "ls\r\u{3}Привет\r".as_bytes().to_vec();
        let mut input = PendingInput {
            data: data.clone(),
            offset: 0,
        };
        let mut writer = PartialWriter {
            bytes: Vec::new(),
            calls: 0,
        };
        while !input.finished() {
            input.write_to(&mut writer).unwrap();
        }
        assert_eq!(writer.bytes, data);
    }

    #[test]
    fn input_is_ordered_and_bounded_without_partial_acceptance() {
        let mut control = Control::default();
        for _ in 0..MAX_QUEUED_INPUT / MAX_INPUT_CHUNK {
            control.enqueue(vec![1; MAX_INPUT_CHUNK]).unwrap();
        }
        assert!(control.enqueue(vec![2]).is_err());
        assert_eq!(control.queued_input, MAX_QUEUED_INPUT);
        assert!(control
            .input
            .iter()
            .all(|chunk| chunk.iter().all(|byte| *byte == 1)));
        assert!(Control::default()
            .enqueue(vec![0; MAX_INPUT_CHUNK + 1])
            .is_err());
    }

    #[test]
    fn acknowledgement_releases_only_accounted_bytes() {
        let mut control = Control {
            unacknowledged: OUTPUT_WINDOW,
            ..Control::default()
        };
        assert!(control.acknowledge(OUTPUT_WINDOW + 1).is_err());
        assert_eq!(control.unacknowledged, OUTPUT_WINDOW);
        control.acknowledge(12).unwrap();
        assert_eq!(control.unacknowledged, OUTPUT_WINDOW - 12);
        control.acknowledge(OUTPUT_WINDOW - 12).unwrap();
        assert_eq!(control.unacknowledged, 0);
    }

    #[test]
    fn closing_server_and_app_sessions_cancels_pending_input() {
        let manager = TerminalManager::default();
        let handles = ["server-a", "server-b"].map(|server_id| {
            let mut control = Control::default();
            control.enqueue(b"pending command\r".to_vec()).unwrap();
            Arc::new(TerminalHandle {
                server_id: server_id.to_string(),
                control: Mutex::new(control),
                wake: Condvar::new(),
            })
        });
        for (index, handle) in handles.iter().enumerate() {
            manager
                .sessions
                .lock()
                .unwrap()
                .insert(index.to_string(), Arc::clone(handle));
        }

        manager.close_for_server("server-a");
        assert!(handles[0].stopped());
        assert!(handles[0].lock().unwrap().input.is_empty());
        assert!(!handles[1].stopped());
        assert!(!handles[1].lock().unwrap().input.is_empty());

        manager.close_all();
        assert!(handles[1].stopped());
        assert!(handles[1].lock().unwrap().input.is_empty());
        assert!(manager.write("1", b"new input".to_vec()).is_err());
    }

    #[test]
    fn dimensions_and_event_contract_are_validated() {
        assert!(validate_size(0, 24).is_err());
        assert!(validate_size(80, 0).is_err());
        assert!(validate_size(u32::MAX, 24).is_err());
        assert!(validate_size(80, 24).is_ok());
        assert_eq!(
            serde_json::to_value(TerminalEvent::Closed {
                exit_code: Some(3),
                message: None
            })
            .unwrap(),
            serde_json::json!({"type":"closed", "exitCode":3, "message":null})
        );
        assert_eq!(
            serde_json::to_value(TerminalEvent::Data {
                data: vec![240, 159]
            })
            .unwrap(),
            serde_json::json!({"type":"data", "data":[240, 159]})
        );
    }
}
