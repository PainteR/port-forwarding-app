use std::{
    collections::{HashMap, VecDeque},
    io::{self, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use chrono::Utc;
use ssh2::Channel;

use crate::{
    models::{ForwardConfig, ForwardKind, ForwardRuntimeStatus, RuntimeState, ServerConfig},
    ssh,
};

#[derive(Default)]
pub struct TunnelManager {
    handles: Mutex<HashMap<String, TunnelHandle>>,
}

struct TunnelHandle {
    stop: Arc<AtomicBool>,
    status: Arc<Mutex<ForwardRuntimeStatus>>,
    join: Option<JoinHandle<()>>,
}

impl TunnelManager {
    pub fn start(
        &self,
        forward: ForwardConfig,
        server: ServerConfig,
    ) -> Result<ForwardRuntimeStatus, String> {
        validate_forward(&forward)?;

        let stale_handle = {
            let mut handles = self
                .handles
                .lock()
                .map_err(|_| "Tunnel manager lock is poisoned".to_string())?;

            if let Some(handle) = handles.get(&forward.id) {
                let status = read_status(&handle.status)?;
                if is_runtime_active(&status.state) {
                    return Ok(status);
                }
            }

            handles.remove(&forward.id)
        };

        if let Some(mut handle) = stale_handle {
            handle.stop.store(true, Ordering::SeqCst);
            if let Some(join) = handle.join.take() {
                let _ = join.join();
            }
        }

        let local_listener = match forward.kind {
            ForwardKind::Local | ForwardKind::Dynamic => Some(bind_local_listener(&forward)?),
            ForwardKind::Remote => None,
        };

        let stop = Arc::new(AtomicBool::new(false));
        let status = Arc::new(Mutex::new(ForwardRuntimeStatus {
            forward_id: forward.id.clone(),
            state: RuntimeState::Starting,
            message: None,
            started_at: Some(Utc::now().to_rfc3339()),
            updated_at: Utc::now().to_rfc3339(),
            reconnects: 0,
        }));

        let thread_stop = Arc::clone(&stop);
        let thread_status = Arc::clone(&status);
        let thread_forward = forward.clone();
        let thread_server = server.clone();

        let thread_listener = local_listener;
        let join = thread::spawn(move || match thread_forward.kind {
            ForwardKind::Local | ForwardKind::Dynamic => {
                let listener = thread_listener
                    .expect("local and dynamic forwards should have a pre-bound listener");
                run_local_listener(
                    thread_server,
                    thread_forward,
                    listener,
                    thread_stop,
                    thread_status,
                )
            }
            ForwardKind::Remote => {
                run_remote_forward(thread_server, thread_forward, thread_stop, thread_status)
            }
        });

        let current = read_status(&status)?;

        let mut handles = self
            .handles
            .lock()
            .map_err(|_| "Tunnel manager lock is poisoned".to_string())?;

        handles.insert(
            forward.id.clone(),
            TunnelHandle {
                stop,
                status,
                join: Some(join),
            },
        );

        Ok(current)
    }

    pub fn stop(&self, forward_id: &str) -> Result<ForwardRuntimeStatus, String> {
        let handle = {
            let mut handles = self
                .handles
                .lock()
                .map_err(|_| "Tunnel manager lock is poisoned".to_string())?;
            handles.remove(forward_id)
        };

        let Some(mut handle) = handle else {
            return Ok(stopped_status(forward_id));
        };

        handle.stop.store(true, Ordering::SeqCst);
        update_status(
            &handle.status,
            RuntimeState::Stopping,
            Some("Stopping".to_string()),
            None,
        );

        if let Some(join) = handle.join.take() {
            let _ = join.join();
        }

        update_status(
            &handle.status,
            RuntimeState::Stopped,
            Some("Stopped".to_string()),
            None,
        );
        read_status(&handle.status)
    }

    pub fn statuses(&self) -> Result<Vec<ForwardRuntimeStatus>, String> {
        let handles = self
            .handles
            .lock()
            .map_err(|_| "Tunnel manager lock is poisoned".to_string())?;

        handles
            .values()
            .map(|handle| read_status(&handle.status))
            .collect()
    }
}

fn run_local_listener(
    server: ServerConfig,
    forward: ForwardConfig,
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    status: Arc<Mutex<ForwardRuntimeStatus>>,
) {
    let bind_addr = format!("{}:{}", forward.bind_host, forward.bind_port);

    if let Err(error) = listener.set_nonblocking(true) {
        update_status(
            &status,
            RuntimeState::Failed,
            Some(format!("Failed to configure listener {bind_addr}: {error}")),
            None,
        );
        return;
    }

    update_status(
        &status,
        RuntimeState::Running,
        Some(format!("Listening on {bind_addr}")),
        None,
    );

    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((socket, peer)) => {
                let connection_server = server.clone();
                let connection_forward = forward.clone();
                let connection_status = Arc::clone(&status);

                thread::spawn(move || {
                    let result = match connection_forward.kind {
                        ForwardKind::Local => handle_local_connection(
                            connection_server,
                            connection_forward,
                            socket,
                            peer.to_string(),
                        ),
                        ForwardKind::Dynamic => {
                            handle_dynamic_connection(connection_server, socket, peer.to_string())
                        }
                        ForwardKind::Remote => {
                            unreachable!("remote forwards do not use local listeners")
                        }
                    };

                    if let Err(error) = result {
                        update_status(
                            &connection_status,
                            RuntimeState::Running,
                            Some(format!("Connection failed: {error}")),
                            None,
                        );
                    }
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                update_status(
                    &status,
                    RuntimeState::Failed,
                    Some(format!("Listener failed: {error}")),
                    None,
                );
                return;
            }
        }
    }
}

fn run_remote_forward(
    server: ServerConfig,
    forward: ForwardConfig,
    stop: Arc<AtomicBool>,
    status: Arc<Mutex<ForwardRuntimeStatus>>,
) {
    let mut reconnects = 0;

    while !stop.load(Ordering::SeqCst) {
        update_status(
            &status,
            if reconnects == 0 {
                RuntimeState::Starting
            } else {
                RuntimeState::Reconnecting
            },
            Some("Opening remote SSH listener".to_string()),
            Some(reconnects),
        );

        match ssh::connect(&server).and_then(|session| {
            session.set_timeout(1000);
            let bind_host = if forward.bind_host.trim().is_empty() {
                None
            } else {
                Some(forward.bind_host.as_str())
            };
            let (mut listener, bound_port) = session
                .channel_forward_listen(forward.bind_port, bind_host, Some(64))
                .map_err(|error| format!("Failed to open remote forward: {error}"))?;

            update_status(
                &status,
                RuntimeState::Running,
                Some(format!(
                    "Remote listener active on {}:{}",
                    forward.bind_host, bound_port
                )),
                Some(reconnects),
            );

            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok(channel) => {
                        let connection_forward = forward.clone();
                        let connection_status = Arc::clone(&status);
                        let session = session.clone();

                        thread::spawn(move || {
                            if let Err(error) =
                                handle_remote_connection(&session, connection_forward, channel)
                            {
                                update_status(
                                    &connection_status,
                                    RuntimeState::Running,
                                    Some(format!("Remote connection failed: {error}")),
                                    None,
                                );
                            }
                        });
                    }
                    Err(error) => {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }

                        let message = error.to_string();
                        if message.to_ascii_lowercase().contains("timed out")
                            || message.to_ascii_lowercase().contains("would block")
                        {
                            continue;
                        }

                        return Err(format!("Remote listener failed: {error}"));
                    }
                }
            }

            Ok(())
        }) {
            Ok(()) => break,
            Err(error) => {
                reconnects += 1;
                update_status(
                    &status,
                    RuntimeState::Reconnecting,
                    Some(error),
                    Some(reconnects),
                );
                sleep_backoff(reconnects, &stop);
            }
        }
    }
}

fn handle_local_connection(
    server: ServerConfig,
    forward: ForwardConfig,
    socket: TcpStream,
    peer: String,
) -> Result<(), String> {
    let target_host = forward
        .target_host
        .as_deref()
        .ok_or_else(|| "Local forward target host is missing".to_string())?;
    let target_port = forward
        .target_port
        .ok_or_else(|| "Local forward target port is missing".to_string())?;

    let session = ssh::connect(&server)?;
    let channel = session
        .channel_direct_tcpip(target_host, target_port, Some((peer.as_str(), 0)))
        .map_err(|error| format!("Failed to open direct-tcpip channel: {error}"))?;

    bridge_tcp_channel(&session, socket, channel)
}

fn handle_dynamic_connection(
    server: ServerConfig,
    mut socket: TcpStream,
    peer: String,
) -> Result<(), String> {
    let request = read_socks5_request(&mut socket)?;
    let session = ssh::connect(&server)?;
    let channel = session
        .channel_direct_tcpip(&request.host, request.port, Some((peer.as_str(), 0)))
        .map_err(|error| {
            let _ = write_socks5_reply(&mut socket, 0x05);
            format!(
                "Failed to open SOCKS target {}:{}: {error}",
                request.host, request.port
            )
        })?;

    write_socks5_reply(&mut socket, 0x00)?;
    bridge_tcp_channel(&session, socket, channel)
}

fn handle_remote_connection(
    session: &ssh2::Session,
    forward: ForwardConfig,
    channel: Channel,
) -> Result<(), String> {
    let target_host = forward
        .target_host
        .as_deref()
        .ok_or_else(|| "Remote forward target host is missing".to_string())?;
    let target_port = forward
        .target_port
        .ok_or_else(|| "Remote forward target port is missing".to_string())?;
    let socket = TcpStream::connect((target_host, target_port)).map_err(|error| {
        format!("Failed to connect local target {target_host}:{target_port}: {error}")
    })?;

    bridge_tcp_channel(session, socket, channel)
}

fn bridge_tcp_channel(
    session: &ssh2::Session,
    mut socket: TcpStream,
    mut channel: Channel,
) -> Result<(), String> {
    socket
        .set_nonblocking(true)
        .map_err(|error| format!("Failed to set TCP socket nonblocking: {error}"))?;
    session.set_blocking(false);

    let mut tcp_to_ssh = VecDeque::new();
    let mut ssh_to_tcp = VecDeque::new();
    let mut tcp_eof = false;
    let mut ssh_eof = false;
    let mut tcp_shutdown = false;
    let mut sent_channel_eof = false;
    let mut buffer = [0_u8; 16 * 1024];

    loop {
        if !tcp_eof && tcp_to_ssh.len() < 1024 * 1024 {
            match socket.read(&mut buffer) {
                Ok(0) => tcp_eof = true,
                Ok(size) => tcp_to_ssh.extend(&buffer[..size]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("TCP read failed: {error}")),
            }
        }

        if !ssh_eof && ssh_to_tcp.len() < 1024 * 1024 {
            match channel.read(&mut buffer) {
                Ok(0) => {
                    if channel.eof() {
                        ssh_eof = true;
                    }
                }
                Ok(size) => ssh_to_tcp.extend(&buffer[..size]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("SSH channel read failed: {error}")),
            }
        }

        drain_to_writer(&mut tcp_to_ssh, &mut channel)
            .map_err(|error| format!("SSH channel write failed: {error}"))?;
        drain_to_writer(&mut ssh_to_tcp, &mut socket)
            .map_err(|error| format!("TCP write failed: {error}"))?;

        if tcp_eof && tcp_to_ssh.is_empty() && !sent_channel_eof {
            let _ = channel.send_eof();
            sent_channel_eof = true;
        }

        if ssh_eof && ssh_to_tcp.is_empty() && !tcp_shutdown {
            let _ = socket.shutdown(Shutdown::Write);
            tcp_shutdown = true;
        }

        if tcp_eof && ssh_eof && tcp_to_ssh.is_empty() && ssh_to_tcp.is_empty() {
            break;
        }

        thread::sleep(Duration::from_millis(5));
    }

    session.set_blocking(true);
    Ok(())
}

fn drain_to_writer<W: Write>(buffer: &mut VecDeque<u8>, writer: &mut W) -> io::Result<()> {
    while !buffer.is_empty() {
        let (front, _) = buffer.as_slices();
        if front.is_empty() {
            break;
        }

        match writer.write(front) {
            Ok(0) => break,
            Ok(size) => {
                buffer.drain(..size);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => return Err(error),
        }
    }

    Ok(())
}

fn read_socks5_request(socket: &mut TcpStream) -> Result<SocksRequest, String> {
    let mut header = [0_u8; 2];
    socket
        .read_exact(&mut header)
        .map_err(|error| format!("Failed to read SOCKS greeting: {error}"))?;

    if header[0] != 0x05 {
        return Err("Only SOCKS5 is supported".to_string());
    }

    let mut methods = vec![0_u8; header[1] as usize];
    socket
        .read_exact(&mut methods)
        .map_err(|error| format!("Failed to read SOCKS methods: {error}"))?;
    socket
        .write_all(&[0x05, 0x00])
        .map_err(|error| format!("Failed to write SOCKS method selection: {error}"))?;

    let mut request_header = [0_u8; 4];
    socket
        .read_exact(&mut request_header)
        .map_err(|error| format!("Failed to read SOCKS request: {error}"))?;

    if request_header[0] != 0x05 || request_header[1] != 0x01 {
        let _ = write_socks5_reply(socket, 0x07);
        return Err("Only SOCKS CONNECT requests are supported".to_string());
    }

    let host = match request_header[3] {
        0x01 => {
            let mut bytes = [0_u8; 4];
            socket
                .read_exact(&mut bytes)
                .map_err(|error| format!("Failed to read SOCKS IPv4 address: {error}"))?;
            std::net::Ipv4Addr::from(bytes).to_string()
        }
        0x03 => {
            let mut length = [0_u8; 1];
            socket
                .read_exact(&mut length)
                .map_err(|error| format!("Failed to read SOCKS domain length: {error}"))?;
            let mut bytes = vec![0_u8; length[0] as usize];
            socket
                .read_exact(&mut bytes)
                .map_err(|error| format!("Failed to read SOCKS domain: {error}"))?;
            String::from_utf8(bytes).map_err(|error| format!("Invalid SOCKS domain: {error}"))?
        }
        0x04 => {
            let mut bytes = [0_u8; 16];
            socket
                .read_exact(&mut bytes)
                .map_err(|error| format!("Failed to read SOCKS IPv6 address: {error}"))?;
            std::net::Ipv6Addr::from(bytes).to_string()
        }
        _ => {
            let _ = write_socks5_reply(socket, 0x08);
            return Err("Unsupported SOCKS address type".to_string());
        }
    };

    let mut port = [0_u8; 2];
    socket
        .read_exact(&mut port)
        .map_err(|error| format!("Failed to read SOCKS port: {error}"))?;

    Ok(SocksRequest {
        host,
        port: u16::from_be_bytes(port),
    })
}

fn write_socks5_reply(socket: &mut TcpStream, code: u8) -> Result<(), String> {
    socket
        .write_all(&[0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .map_err(|error| format!("Failed to write SOCKS reply: {error}"))
}

fn validate_forward(forward: &ForwardConfig) -> Result<(), String> {
    if forward.bind_host.trim().is_empty() {
        return Err("Bind host is required".to_string());
    }

    if forward.bind_port == 0 {
        return Err("Bind port is required".to_string());
    }

    if forward.kind != ForwardKind::Dynamic {
        if forward
            .target_host
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            return Err("Target host is required".to_string());
        }
        if forward.target_port.unwrap_or_default() == 0 {
            return Err("Target port is required".to_string());
        }
    }

    Ok(())
}

fn bind_local_listener(forward: &ForwardConfig) -> Result<TcpListener, String> {
    let bind_addr = format!("{}:{}", forward.bind_host, forward.bind_port);
    TcpListener::bind(&bind_addr)
        .map_err(|error| format!("Local port {bind_addr} is unavailable: {error}"))
}

fn is_runtime_active(state: &RuntimeState) -> bool {
    matches!(
        state,
        RuntimeState::Starting
            | RuntimeState::Running
            | RuntimeState::Reconnecting
            | RuntimeState::Stopping
    )
}

fn update_status(
    status: &Arc<Mutex<ForwardRuntimeStatus>>,
    state: RuntimeState,
    message: Option<String>,
    reconnects: Option<u32>,
) {
    if let Ok(mut status) = status.lock() {
        status.state = state;
        status.message = message;
        status.updated_at = Utc::now().to_rfc3339();
        if let Some(reconnects) = reconnects {
            status.reconnects = reconnects;
        }
    }
}

fn read_status(status: &Arc<Mutex<ForwardRuntimeStatus>>) -> Result<ForwardRuntimeStatus, String> {
    status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "Tunnel status lock is poisoned".to_string())
}

fn stopped_status(forward_id: &str) -> ForwardRuntimeStatus {
    ForwardRuntimeStatus {
        forward_id: forward_id.to_string(),
        state: RuntimeState::Stopped,
        message: Some("Stopped".to_string()),
        started_at: None,
        updated_at: Utc::now().to_rfc3339(),
        reconnects: 0,
    }
}

fn sleep_backoff(reconnects: u32, stop: &AtomicBool) {
    let seconds = reconnects.min(5);
    for _ in 0..seconds * 10 {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

struct SocksRequest {
    host: String,
    port: u16,
}

#[cfg(test)]
mod tests {
    use super::{bind_local_listener, TunnelManager};
    use crate::models::{AuthConfig, ForwardConfig, ForwardKind, ForwardSource, ServerConfig};
    use std::net::TcpListener;

    #[test]
    fn local_forward_reports_busy_bind_port_before_starting() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test port should bind");
        let port = listener
            .local_addr()
            .expect("test listener should have local address")
            .port();
        let forward = test_forward(ForwardKind::Local, port);

        let error =
            bind_local_listener(&forward).expect_err("occupied local port should be rejected");

        assert!(error.contains("127.0.0.1"));
        assert!(error.contains(&port.to_string()));
        assert!(error.contains("unavailable"));
    }

    #[test]
    fn dynamic_forward_reports_busy_bind_port_before_starting() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test port should bind");
        let port = listener
            .local_addr()
            .expect("test listener should have local address")
            .port();
        let forward = test_forward(ForwardKind::Dynamic, port);

        let error =
            bind_local_listener(&forward).expect_err("occupied dynamic port should be rejected");

        assert!(error.contains("127.0.0.1"));
        assert!(error.contains(&port.to_string()));
        assert!(error.contains("unavailable"));
    }

    #[test]
    fn start_rejects_busy_local_port_synchronously() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test port should bind");
        let port = listener
            .local_addr()
            .expect("test listener should have local address")
            .port();
        let manager = TunnelManager::default();
        let forward = test_forward(ForwardKind::Local, port);

        let error = manager
            .start(forward, test_server())
            .expect_err("occupied local port should be rejected before opening SSH");

        assert!(error.contains("127.0.0.1"));
        assert!(error.contains(&port.to_string()));
        assert!(error.contains("unavailable"));
        assert!(
            manager
                .statuses()
                .expect("statuses should be readable")
                .is_empty(),
            "failed starts should not leave runtime handles"
        );
    }

    fn test_forward(kind: ForwardKind, bind_port: u16) -> ForwardConfig {
        ForwardConfig {
            id: "test-forward".to_string(),
            server_id: "test-server".to_string(),
            name: "Test forward".to_string(),
            kind,
            bind_host: "127.0.0.1".to_string(),
            bind_port,
            target_host: Some("127.0.0.1".to_string()),
            target_port: Some(8080),
            enabled: true,
            auto_start: false,
            source: ForwardSource::Manual {},
        }
    }

    fn test_server() -> ServerConfig {
        ServerConfig {
            id: "test-server".to_string(),
            name: "Test server".to_string(),
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "test".to_string(),
            auth: AuthConfig::Agent,
            connect_timeout_ms: Some(10),
        }
    }
}
