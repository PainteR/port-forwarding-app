//! Opt-in loopback SSH tests. Never use a production server for this fixture.
use super::*;
use crate::models::AuthConfig;
use std::{env, thread};

struct Fixture {
    root: PathBuf,
    server: ServerConfig,
}

impl Fixture {
    fn from_env() -> Option<Self> {
        let port = env::var("SFTP_TEST_PORT").ok()?.parse().unwrap();
        let key = env::var("SFTP_TEST_KEY").expect("SFTP_TEST_KEY is required");
        let base =
            fs::canonicalize(env::var("SFTP_TEST_ROOT").expect("SFTP_TEST_ROOT is required"))
                .unwrap();
        assert!(base.starts_with("/private/tmp") || base.starts_with("/tmp"));
        let root = base.join(format!("fixture-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Some(Self {
            root,
            server: ServerConfig {
                id: "loopback-integration-only".into(),
                name: "Loopback fixture".into(),
                host: "127.0.0.1".into(),
                port,
                username: env::var("USER").unwrap(),
                auth: AuthConfig::KeyFile {
                    private_key_path: key,
                    passphrase: None,
                },
                connect_timeout_ms: Some(5_000),
            },
        })
    }

    fn dir(&self, name: &str) -> PathBuf {
        let path = self.root.join(name);
        fs::create_dir_all(&path).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fn writable(path: &Path) {
            if let Ok(meta) = fs::symlink_metadata(path) {
                if meta.is_dir() {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
                    }
                    if let Ok(entries) = fs::read_dir(path) {
                        for e in entries.flatten() {
                            writable(&e.path());
                        }
                    }
                }
            }
        }
        writable(&self.root);
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn request(
    mode: TransferMode,
    direction: TransferDirection,
    sources: &[PathBuf],
    destination: &Path,
    overwrite: bool,
) -> TransferRequest {
    TransferRequest {
        transfer_id: Uuid::new_v4().to_string(),
        direction,
        sources: sources
            .iter()
            .map(|p| p.to_str().unwrap().to_owned())
            .collect(),
        destination: destination.to_str().unwrap().to_owned(),
        mode,
        overwrite,
    }
}

fn transfer(
    server: &ServerConfig,
    request: &TransferRequest,
    control: &TransferControl,
) -> Result<(), String> {
    match request.mode {
        TransferMode::Sftp => transfer_sftp(server, request, control),
        TransferMode::Archive => crate::sftp_archive::transfer(server, request, control),
    }
}

#[test]
#[ignore = "requires isolated loopback SSH fixture"]
fn loopback_sftp_and_archive_roundtrip() {
    let fixture = Fixture::from_env()
        .expect("Run tests/run_sftp_loopback.py to create the isolated SSH fixture");
    for mode in [TransferMode::Sftp, TransferMode::Archive] {
        let prefix = format!("{mode:?}");
        let source_parent = fixture.dir(&format!("{prefix}-source"));
        let name = "-project ' $(touch INJECTION)\nтест";
        let source = source_parent.join(name);
        fs::create_dir_all(source.join("nested/empty")).unwrap();
        fs::write(
            source.join("nested/data.txt"),
            "Привет\nstreaming transfer\n",
        )
        .unwrap();
        fs::write(source.join("empty.txt"), []).unwrap();
        fs::write(
            source.join("binary.dat"),
            (0..=255).cycle().take(200_000).collect::<Vec<u8>>(),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(source.join("nested"), fs::Permissions::from_mode(0o555)).unwrap();
        }
        let remote = fixture.dir(&format!("{prefix}-remote"));
        let download = fixture.dir(&format!("{prefix}-download"));
        let upload = request(
            mode,
            TransferDirection::Upload,
            std::slice::from_ref(&source),
            &remote,
            false,
        );
        transfer(
            &fixture.server,
            &upload,
            &TransferControl::for_test(&upload.transfer_id),
        )
        .unwrap_or_else(|e| panic!("{mode:?} upload: {e}"));
        fs::hard_link(
            remote.join(name).join("nested/data.txt"),
            remote.join(name).join("hard-linked.txt"),
        )
        .unwrap();
        let download_request = request(
            mode,
            TransferDirection::Download,
            &[remote.join(name)],
            &download,
            false,
        );
        transfer(
            &fixture.server,
            &download_request,
            &TransferControl::for_test(&download_request.transfer_id),
        )
        .unwrap_or_else(|e| panic!("{mode:?} download: {e}"));
        for file in ["nested/data.txt", "empty.txt", "binary.dat"] {
            assert_eq!(
                fs::read(source.join(file)).unwrap(),
                fs::read(download.join(name).join(file)).unwrap()
            );
        }
        assert!(download.join(name).join("nested/empty").is_dir());
        assert_eq!(
            fs::read(download.join(name).join("hard-linked.txt")).unwrap(),
            fs::read(source.join("nested/data.txt")).unwrap()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(download.join(name).join("nested"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o555
            );
        }
        assert!(
            transfer(
                &fixture.server,
                &upload,
                &TransferControl::for_test(&upload.transfer_id)
            )
            .is_err(),
            "{mode:?} must refuse an existing destination"
        );
        assert!(!fixture.root.join("INJECTION").exists());
        assert!(fs::read_dir(&remote).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".port-forward-")));
    }
}

#[test]
#[ignore = "requires isolated loopback SSH fixture"]
fn loopback_cancel_preserves_existing_file() {
    let fixture = Fixture::from_env()
        .expect("Run tests/run_sftp_loopback.py to create the isolated SSH fixture");
    for mode in [TransferMode::Sftp, TransferMode::Archive] {
        for direction in [TransferDirection::Upload, TransferDirection::Download] {
            let source = fixture.dir(&format!("{mode:?}-{direction:?}-source"));
            let remote = fixture.dir(&format!("{mode:?}-{direction:?}-target"));
            // A large file guarantees cancellation after transport starts, including
            // on a loopback connection. No production paths are touched.
            let input = source.join("large.bin");
            let mut file = File::create(&input).unwrap();
            let mut block = vec![0u8; 1024 * 1024];
            let mut state = 0x12345678u32;
            for byte in &mut block {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                *byte = state as u8;
            }
            for _ in 0..64 {
                file.write_all(&block).unwrap();
            }
            drop(file);
            fs::write(remote.join("large.bin"), b"original remains intact").unwrap();
            let req = request(mode, direction, &[input], &remote, true);
            let control = Arc::new(TransferControl::for_test(&req.transfer_id));
            let cancel = control.clone();
            let worker = thread::spawn(move || {
                let start = Instant::now();
                while start.elapsed() < Duration::from_secs(10) {
                    if cancel.last_event.lock().unwrap().1.bytes_transferred > 0 {
                        cancel.cancel_for_test();
                        return true;
                    }
                    thread::sleep(Duration::from_millis(1));
                }
                cancel.cancel_for_test();
                false
            });
            let result = transfer(&fixture.server, &req, &control);
            assert!(worker.join().unwrap(), "{mode:?}: transfer never started");
            assert!(
                result.is_err(),
                "{mode:?}: cancelled transfer unexpectedly succeeded"
            );
            assert_eq!(
                fs::read(remote.join("large.bin")).unwrap(),
                b"original remains intact"
            );
            assert!(
                fs::read_dir(&remote).unwrap().all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".port-forward-")),
                "{mode:?}: partial/staging file remains"
            );
        }
    }
}

#[test]
#[ignore = "requires isolated loopback SSH fixture"]
fn loopback_sftp_file_operations() {
    let fixture = Fixture::from_env()
        .expect("Run tests/run_sftp_loopback.py to create the isolated SSH fixture");
    let remote = Endpoint::new(Some(&fixture.server)).unwrap();
    let directory = fixture.root.join("remote operations");
    remote.mkdir(&directory, 0o700).unwrap();
    let file = directory.join("notes.txt");
    remote.write_atomic(&file, b"hello", 0o640, false).unwrap();
    let text = remote.read_text(&file).unwrap();
    assert_eq!(text.content, "hello");
    assert!(!text.revision.is_empty());
    remote
        .write_atomic(&file, b"edited remote text", 0o640, true)
        .unwrap();
    let saved = remote.read_text(&file).unwrap();
    assert_eq!(saved.content, "edited remote text");
    assert_ne!(saved.revision, text.revision);
    let renamed = directory.join("renamed.txt");
    remote.rename(&file, &renamed, false).unwrap();
    remote.permissions(&renamed, 0o600).unwrap();
    assert_eq!(
        remote
            .required_metadata(&renamed)
            .unwrap()
            .permissions
            .unwrap()
            & 0o777,
        0o600
    );
    assert_eq!(remote.entries(&directory).unwrap().len(), 1);
    remote.remove_tree(&directory, 0).unwrap();
    assert!(!directory.exists());
}

#[test]
#[ignore = "requires isolated loopback SSH fixture"]
fn loopback_atomic_file_replacement() {
    let fixture = Fixture::from_env()
        .expect("Run tests/run_sftp_loopback.py to create the isolated SSH fixture");
    for mode in [TransferMode::Sftp, TransferMode::Archive] {
        for direction in [TransferDirection::Upload, TransferDirection::Download] {
            let source = fixture.dir(&format!("{mode:?}-{direction:?}-source"));
            let target = fixture.dir(&format!("{mode:?}-{direction:?}-target"));
            let file = source.join("replace ' тест.txt");
            fs::write(&file, "replacement contents").unwrap();
            fs::write(target.join(file.file_name().unwrap()), "original").unwrap();
            let mut req = request(mode, direction, &[file], &target, false);
            assert!(transfer(
                &fixture.server,
                &req,
                &TransferControl::for_test(&req.transfer_id)
            )
            .is_err());
            assert_eq!(
                fs::read(target.join("replace ' тест.txt")).unwrap(),
                b"original"
            );
            req.overwrite = true;
            transfer(
                &fixture.server,
                &req,
                &TransferControl::for_test(&req.transfer_id),
            )
            .unwrap_or_else(|error| panic!("{mode:?}/{direction:?}: {error}"));
            assert_eq!(
                fs::read(target.join("replace ' тест.txt")).unwrap(),
                b"replacement contents"
            );
        }
    }
}
