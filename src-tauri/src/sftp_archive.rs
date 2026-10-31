//! Optional tar/gzip streaming transport. SFTP remains the file-management transport.
//! A private staging directory keeps interrupted archives away from final paths.
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, BufReader, Read, Write},
    path::{Component, Path},
    thread,
    time::{Duration, Instant},
};

use flate2::{bufread::GzDecoder, write::GzEncoder, Compression};
use ssh2::{Channel, ErrorCode, Sftp};
use uuid::Uuid;

use crate::{
    models::ServerConfig,
    sftp::{TransferControl, TransferDirection, TransferRequest},
    ssh,
};

const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_DIAGNOSTICS: usize = 64 * 1024;

pub(crate) fn transfer(
    server: &ServerConfig,
    request: &TransferRequest,
    control: &TransferControl,
) -> Result<(), String> {
    control.check()?;
    let session = ssh::connect(server)?;
    session.set_timeout(5_000);
    let sftp = session.sftp().map_err(message)?;
    match request.direction {
        TransferDirection::Upload => upload(&session, &sftp, request, control),
        TransferDirection::Download => download(&session, &sftp, request, control),
    }
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn root_names(sources: &[String]) -> Result<Vec<String>, String> {
    if sources.is_empty() {
        return Err("Select at least one source".into());
    }
    let mut seen = HashSet::new();
    sources
        .iter()
        .map(|source| {
            let path = Path::new(source);
            if !path.is_absolute()
                || source.contains('\0')
                || path
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
            {
                return Err("Archive sources must be absolute paths without '..'".into());
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .ok_or("Cannot transfer a filesystem root")?
                .to_owned();
            if !seen.insert(name.clone()) {
                return Err(format!("Multiple sources have the same name: {name}"));
            }
            Ok(name)
        })
        .collect()
}

fn upload(
    session: &ssh2::Session,
    sftp: &Sftp,
    request: &TransferRequest,
    control: &TransferControl,
) -> Result<(), String> {
    let names = root_names(&request.sources)?;
    // Resolve the destination once; archive publication never traverses its children.
    let destination = sftp
        .realpath(Path::new(&request.destination))
        .map_err(message)?;
    if !sftp.stat(&destination).map_err(message)?.is_dir() {
        return Err("Upload destination must be a directory".into());
    }
    for name in &names {
        remote_conflict(sftp, &destination.join(name), request.overwrite)?;
    }
    for source in &request.sources {
        validate_local_ancestors(Path::new(source))?;
        validate_local_tree(Path::new(source), control, 0)?;
    }
    let stage = destination.join(format!(".port-forward-{}", Uuid::new_v4()));
    sftp.mkdir(&stage, 0o700).map_err(message)?;
    let result = (|| {
        control.check()?;
        let command = format!(
            "umask 000; exec tar -xzf - -C {} --no-same-owner --no-same-permissions",
            quote(stage.to_str().ok_or("Destination is not UTF-8")?),
        );
        let mut channel = session.channel_session().map_err(message)?;
        channel.exec(&command).map_err(message)?;
        session.set_blocking(false);
        let mut stream = ArchiveStream::new(channel, control);
        let packing = (|| {
            let encoded = GzEncoder::new(&mut stream, Compression::fast());
            let mut archive = tar::Builder::new(encoded);
            archive.follow_symlinks(false);
            for (source, name) in request.sources.iter().zip(&names) {
                append_tree(&mut archive, Path::new(source), Path::new(name), 0)?;
            }
            let encoded = archive.into_inner().map_err(message)?;
            encoded.finish().map_err(message)?;
            Ok::<_, String>(())
        })();
        if let Err(error) = packing {
            return Err(stream.failure(error, true));
        }
        stream.finish(true)?;
        session.set_blocking(true);
        // Preflight every root again before publishing any of them.
        for name in &names {
            remote_conflict(sftp, &destination.join(name), request.overwrite)?;
        }
        for name in &names {
            control.check()?;
            let source = stage.join(name);
            let destination = destination.join(name);
            crate::sftp_rename::remote(session, sftp, &source, &destination, request.overwrite)
                .map_err(|error| {
                    format!(
                        "Could not publish {} (earlier roots may be complete): {error}",
                        destination.display()
                    )
                })?;
        }
        Ok(())
    })();
    session.set_blocking(true);
    // Do not mask the original error if the connection has gone away. Cleanup
    // is best effort; the hidden stage can be removed from the file manager.
    session.set_timeout(1_000);
    let cleanup = remove_remote_tree(sftp, &stage, 0, Instant::now() + Duration::from_secs(2));
    match (result, cleanup) {
        (Ok(()), Err(error)) => Err(format!(
            "Files transferred, but staging cleanup failed: {error}"
        )),
        (Err(error), Err(cleanup)) => Err(format!(
            "{error}. Staging cleanup incomplete at {}: {cleanup}",
            stage.display()
        )),
        (result, _) => result,
    }
}

fn validate_local_tree(path: &Path, control: &TransferControl, depth: usize) -> Result<(), String> {
    control.check()?;
    if depth > 128 {
        return Err("Directory nesting exceeds 128 levels".into());
    }
    let metadata = fs::symlink_metadata(path).map_err(message)?;
    if metadata.is_dir() {
        for child in fs::read_dir(path).map_err(message)? {
            validate_local_tree(&child.map_err(message)?.path(), control, depth + 1)?;
        }
    } else if !metadata.is_file() {
        return Err(format!(
            "Archive transfer supports regular files and directories; unsupported entry: {}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_local_ancestors(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor)
            .map_err(message)?
            .file_type()
            .is_symlink()
        {
            return Err(format!(
                "Symbolic links are not followed: {}",
                ancestor.display()
            ));
        }
    }
    Ok(())
}

fn append_tree(
    archive: &mut tar::Builder<GzEncoder<&mut ArchiveStream<'_>>>,
    source: &Path,
    relative: &Path,
    depth: usize,
) -> Result<(), String> {
    let stream = archive.get_mut().get_mut();
    stream.control.check()?;
    stream.path = source.to_string_lossy().into_owned();
    if depth > 128 {
        return Err("Directory nesting exceeds 128 levels".into());
    }
    let metadata = fs::symlink_metadata(source).map_err(message)?;
    let mut header = tar::Header::new_gnu();
    header.set_metadata(&metadata);
    // Never propagate suid/sgid or ownership from the local user.
    header.set_mode(header.mode().map_err(message)? & 0o777);
    header.set_uid(0);
    header.set_gid(0);
    if metadata.is_dir() {
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        archive
            .append_data(&mut header, relative, io::empty())
            .map_err(message)?;
        for child in fs::read_dir(source).map_err(message)? {
            let child = child.map_err(message)?;
            append_tree(
                archive,
                &child.path(),
                &relative.join(child.file_name()),
                depth + 1,
            )?;
        }
    } else if metadata.is_file() {
        // Recheck after open so a replaced symlink is not read into the archive.
        let mut file = File::open(source).map_err(message)?;
        if fs::symlink_metadata(source)
            .map_err(message)?
            .file_type()
            .is_symlink()
        {
            return Err("Source changed into a symbolic link".into());
        }
        header.set_metadata(&file.metadata().map_err(message)?);
        header.set_mode(header.mode().map_err(message)? & 0o777);
        header.set_uid(0);
        header.set_gid(0);
        archive
            .append_data(&mut header, relative, &mut file)
            .map_err(message)?;
        let stream = archive.get_mut().get_mut();
        stream.files += 1;
        stream.report()?;
    } else {
        return Err(format!("Unsupported archive entry: {}", source.display()));
    }
    Ok(())
}

fn remote_conflict(sftp: &Sftp, path: &Path, overwrite: bool) -> Result<(), String> {
    match sftp.lstat(path) {
        Ok(stat) if overwrite && stat.is_file() => Ok(()),
        Ok(_) => Err(format!("Destination exists: {}. Archive mode can replace regular files; use SFTP to merge directories.", path.display())),
        Err(error) if error.code() == ErrorCode::SFTP(2) => Ok(()),
        Err(error) => Err(message(error)),
    }
}

fn download(
    session: &ssh2::Session,
    sftp: &Sftp,
    request: &TransferRequest,
    control: &TransferControl,
) -> Result<(), String> {
    let names = root_names(&request.sources)?;
    let destination = fs::canonicalize(&request.destination).map_err(message)?;
    if !destination.is_dir() {
        return Err("Download destination must be a directory".into());
    }
    for name in &names {
        local_conflict(&destination.join(name), request.overwrite)?;
    }
    let parent = Path::new(&request.sources[0])
        .parent()
        .ok_or("Invalid source")?;
    if request
        .sources
        .iter()
        .any(|source| Path::new(source).parent() != Some(parent))
    {
        return Err("Archive download sources must be in the same directory".into());
    }
    for source in &request.sources {
        for ancestor in Path::new(source).ancestors() {
            if sftp
                .lstat(ancestor)
                .map_err(message)?
                .perm
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err(format!(
                    "Symbolic links are not followed: {}",
                    ancestor.display()
                ));
            }
        }
        let stat = sftp.lstat(Path::new(source)).map_err(message)?;
        if !(stat.is_file() || stat.is_dir()) {
            return Err(format!("Unsupported archive source: {source}"));
        }
    }
    let stage = destination.join(format!(".port-forward-{}", Uuid::new_v4()));
    create_private_dir(&stage)?;
    let result = (|| {
        let command = format!(
            "export COPYFILE_DISABLE=1; exec tar -czf - -C {} -- {}",
            quote(parent.to_str().ok_or("Source is not UTF-8")?),
            names
                .iter()
                .map(|name| quote(name))
                .collect::<Vec<_>>()
                .join(" "),
        );
        let mut channel = session.channel_session().map_err(message)?;
        channel.exec(&command).map_err(message)?;
        session.set_blocking(false);
        let mut stream = ArchiveStream::new(channel, control);
        stream.files = match unpack_gzip(&mut stream, &stage, &names, control) {
            Ok(files) => files,
            Err(error) => return Err(stream.failure(error, false)),
        };
        stream.finish(false)?;
        session.set_blocking(true);
        for name in &names {
            local_conflict(&destination.join(name), request.overwrite)?;
            let source = stage.join(name);
            if !source.exists() {
                return Err(format!("Remote archive is missing selected entry: {name}"));
            }
        }
        for name in &names {
            control.check()?;
            let source = stage.join(name);
            let target = destination.join(name);
            if request.overwrite {
                // POSIX rename atomically replaces regular files; directories were
                // rejected above. Windows reports a conflict instead of deleting.
                fs::rename(&source, &target).map_err(message)?;
            } else {
                publish_local(&source, &target)?;
            }
        }
        Ok(())
    })();
    session.set_blocking(true);
    let cleanup = remove_local_stage(&stage);
    match (result, cleanup) {
        (Ok(()), Err(error)) => Err(format!(
            "Files transferred, but staging cleanup failed: {error}"
        )),
        (Err(error), Err(cleanup)) => Err(format!(
            "{error}. Staging cleanup incomplete at {}: {cleanup}",
            stage.display()
        )),
        (result, _) => result,
    }
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(message)
}

fn remove_local_stage(path: &Path) -> io::Result<()> {
    remove_local_stage_before(path, Instant::now() + Duration::from_secs(2))
}

fn remove_local_stage_before(path: &Path, deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Staging cleanup deadline exceeded",
        ));
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return fs::remove_file(path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    for entry in fs::read_dir(path)? {
        remove_local_stage_before(&entry?.path(), deadline)?;
    }
    fs::remove_dir(path)
}

fn local_conflict(path: &Path, overwrite: bool) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(stat) if overwrite && stat.is_file() => Ok(()),
        Ok(_) => Err(format!("Destination exists: {}. Archive mode can replace regular files; use SFTP to merge directories.", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(message(error)),
    }
}

// Publish using the platform's atomic no-replace rename operation.
fn publish_local(source: &Path, target: &Path) -> Result<(), String> {
    crate::sftp::rename_local_exclusive(source, target)
}

fn safe_archive_path(path: &Path, roots: &[String]) -> bool {
    let mut components = path.components();
    let root = match components.next() {
        Some(Component::Normal(root)) => root,
        _ => return false,
    };
    roots.iter().any(|name| root == name.as_str())
        && components.all(|component| matches!(component, Component::Normal(_)))
}

fn unpack_gzip<R: Read>(
    reader: R,
    stage: &Path,
    roots: &[String],
    control: &TransferControl,
) -> Result<u64, String> {
    let mut buffered = BufReader::new(reader);
    // BSD tar pads a compressed stdout stream with zero blocks. Decode exactly
    // one gzip member, verify its CRC, then validate the remaining padding.
    let files = unpack_archive(GzDecoder::new(&mut buffered), stage, roots, control)?;
    let mut padding = [0u8; 8192];
    loop {
        control.check()?;
        let count = buffered.read(&mut padding).map_err(message)?;
        if count == 0 {
            break;
        }
        if padding[..count].iter().any(|byte| *byte != 0) {
            return Err("Unexpected data after the gzip archive".into());
        }
    }
    Ok(files)
}

fn unpack_archive<R: Read>(
    reader: R,
    stage: &Path,
    roots: &[String],
    control: &TransferControl,
) -> Result<u64, String> {
    let mut archive = tar::Archive::new(reader);
    archive.set_preserve_ownerships(false);
    archive.set_preserve_permissions(false);
    archive.set_unpack_xattrs(false);
    archive.set_overwrite(false);
    let mut directories = Vec::new();
    let mut files = 0;
    for (index, entry) in archive.entries().map_err(message)?.enumerate() {
        control.check()?;
        if index >= 250_000 {
            return Err("Archive exceeds 250000 entries".into());
        }
        let mut entry = entry.map_err(message)?;
        let path = entry.path().map_err(message)?.into_owned();
        if !safe_archive_path(&path, roots) {
            return Err(format!(
                "Rejected unexpected archive path: {}",
                path.display()
            ));
        }
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir() || kind.is_hard_link()) {
            return Err(format!(
                "Archive contains a link or special file: {}. Use regular files and directories.",
                path.display()
            ));
        }
        if path.components().count() > 129 {
            return Err("Directory nesting exceeds 128 levels".into());
        }
        if kind.is_dir() {
            // Delay restrictive modes until all children have been extracted.
            fs::create_dir_all(stage.join(&path)).map_err(message)?;
            directories.push((
                path,
                entry.header().mode().map_err(message)? & 0o777,
                entry.header().mtime().map_err(message)?,
            ));
            continue;
        }
        if kind.is_hard_link() {
            let target = entry
                .link_name()
                .map_err(message)?
                .ok_or("Archive hard link is missing its target")?;
            if !safe_archive_path(&target, roots)
                || !fs::symlink_metadata(stage.join(&target))
                    .map_err(message)?
                    .is_file()
            {
                return Err("Archive hard link must point to an already extracted regular file in the selected roots".into());
            }
        }
        if !entry.unpack_in(stage).map_err(message)? {
            return Err("Archive path escaped the staging directory".into());
        }
        files += 1;
    }
    // tar's end marker precedes the gzip trailer. Consume the decoder to verify
    // CRC/truncation and drain the channel before checking remote exit status.
    io::copy(&mut archive.into_inner(), &mut io::sink()).map_err(message)?;
    directories.sort_by_key(|(path, _, _)| std::cmp::Reverse(path.components().count()));
    for (path, mode, mtime) in directories {
        control.check()?;
        let destination = stage.join(path);
        let time = std::time::UNIX_EPOCH
            .checked_add(Duration::from_secs(mtime))
            .ok_or("Invalid archive modification time")?;
        File::open(&destination)
            .and_then(|file| file.set_times(fs::FileTimes::new().set_modified(time)))
            .map_err(message)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(destination, fs::Permissions::from_mode(mode)).map_err(message)?;
        }
    }
    Ok(files)
}

fn remove_remote_tree(
    sftp: &Sftp,
    path: &Path,
    depth: usize,
    deadline: Instant,
) -> Result<(), String> {
    if Instant::now() >= deadline {
        return Err("Staging cleanup deadline exceeded".into());
    }
    if depth > 130 {
        return Err("Staging directory is too deeply nested to clean up".into());
    }
    if sftp.lstat(path).map_err(message)?.is_dir() {
        sftp.setstat(
            path,
            ssh2::FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: Some(0o700),
                atime: None,
                mtime: None,
            },
        )
        .map_err(message)?;
        let mut directory = sftp.opendir(path).map_err(message)?;
        loop {
            if Instant::now() >= deadline {
                return Err("Staging cleanup deadline exceeded".into());
            }
            let name = match directory.readdir() {
                Ok((name, _)) => name,
                Err(error) if error.code() == ErrorCode::Session(-16) => break,
                Err(error) => return Err(message(error)),
            };
            if name == Path::new(".") || name == Path::new("..") {
                continue;
            }
            if name.components().count() != 1
                || !matches!(name.components().next(), Some(Component::Normal(_)))
            {
                return Err("Server returned an invalid staging directory entry".into());
            }
            let child = path.join(name);
            remove_remote_tree(sftp, &child, depth + 1, deadline)?;
        }
        directory.close().map_err(message)?;
        sftp.rmdir(path).map_err(message)
    } else {
        sftp.unlink(path).map_err(message)
    }
}

struct ArchiveStream<'a> {
    channel: Channel,
    control: &'a TransferControl,
    bytes: u64,
    files: u64,
    path: String,
    stderr: Vec<u8>,
    last_activity: Instant,
    diagnostic_deadline: Option<Instant>,
}

impl<'a> ArchiveStream<'a> {
    fn new(channel: Channel, control: &'a TransferControl) -> Self {
        Self {
            channel,
            control,
            bytes: 0,
            files: 0,
            path: "Streaming tar + gzip".into(),
            stderr: Vec::new(),
            last_activity: Instant::now(),
            diagnostic_deadline: None,
        }
    }

    fn report(&self) -> Result<(), String> {
        self.control
            .progress(self.bytes, None, self.files, &self.path)
    }

    fn check(&self) -> io::Result<()> {
        self.control.check().map_err(io::Error::other)?;
        if self
            .diagnostic_deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Remote command diagnostics timed out",
            ));
        }
        if self.last_activity.elapsed() > IDLE_TIMEOUT {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Archive stream idle for 60 seconds",
            ));
        }
        Ok(())
    }

    fn failure(&mut self, error: String, upload: bool) -> String {
        if self.control.is_cancelled() {
            return error;
        }
        self.diagnostic_deadline = Some(Instant::now() + Duration::from_secs(2));
        match self.finish(upload) {
            Err(remote) if remote != error => format!("{error}. {remote}"),
            _ if !self.stderr.is_empty() => {
                format!("{error}. {}", String::from_utf8_lossy(&self.stderr).trim())
            }
            _ => error,
        }
    }

    fn diagnostics(&mut self) -> io::Result<()> {
        let mut buffer = [0u8; 8192];
        loop {
            match self.channel.stderr().read(&mut buffer) {
                Ok(0) => return Ok(()),
                Ok(count) => {
                    self.last_activity = Instant::now();
                    let remaining = MAX_DIAGNOSTICS.saturating_sub(self.stderr.len());
                    self.stderr
                        .extend_from_slice(&buffer[..count.min(remaining)]);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                Err(error) => return Err(error),
            }
            self.check()?;
        }
    }

    fn finish(&mut self, upload: bool) -> Result<(), String> {
        if upload {
            loop {
                self.check().map_err(message)?;
                self.diagnostics().map_err(message)?;
                match self.channel.send_eof() {
                    Ok(()) => break,
                    Err(error) if error.code() == ErrorCode::Session(-37) => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => return Err(message(error)),
                }
            }
        }
        let mut buffer = [0u8; 32768];
        loop {
            self.check().map_err(message)?;
            self.diagnostics().map_err(message)?;
            match self.channel.read(&mut buffer) {
                Ok(0) if self.channel.eof() => break,
                Ok(0) => thread::sleep(Duration::from_millis(5)),
                Ok(_) => self.last_activity = Instant::now(),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) => return Err(message(error)),
            }
        }
        self.diagnostics().map_err(message)?;
        loop {
            self.check().map_err(message)?;
            match self.channel.wait_close() {
                Ok(()) => break,
                Err(error) if error.code() == ErrorCode::Session(-37) => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) => return Err(message(error)),
            }
        }
        let status = self.channel.exit_status().map_err(message)?;
        if status != 0 {
            return Err(format!(
                "Remote tar exited with {status}: {}",
                String::from_utf8_lossy(&self.stderr).trim()
            ));
        }
        self.report()
    }
}

impl Read for ArchiveStream<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            self.check()?;
            self.diagnostics()?;
            match self.channel.read(buffer) {
                Ok(0) if self.channel.eof() => return Ok(0),
                Ok(0) => thread::sleep(Duration::from_millis(5)),
                Ok(count) => {
                    self.bytes += count as u64;
                    self.last_activity = Instant::now();
                    self.report().map_err(io::Error::other)?;
                    return Ok(count);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) => return Err(error),
            }
        }
    }
}

impl Write for ArchiveStream<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            self.check()?;
            self.diagnostics()?;
            match self.channel.write(buffer) {
                Ok(0) => thread::sleep(Duration::from_millis(5)),
                Ok(count) => {
                    self.bytes += count as u64;
                    self.last_activity = Instant::now();
                    self.report().map_err(io::Error::other)?;
                    return Ok(count);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) => return Err(error),
            }
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        self.check()
    }
}

impl Drop for ArchiveStream<'_> {
    fn drop(&mut self) {
        // Nonblocking best effort: signal the remote process on cancellation or
        // archive errors instead of leaving it waiting for another input block.
        let _ = self.channel.send_eof();
        let _ = self.channel.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_archive(link: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut archive = tar::Builder::new(&mut bytes);
            let mut dir = tar::Header::new_gnu();
            dir.set_mode(0o555);
            dir.set_mtime(1234567890);
            dir.set_entry_type(tar::EntryType::Directory);
            dir.set_size(0);
            archive
                .append_data(&mut dir, "project", io::empty())
                .unwrap();
            if link {
                let mut header = tar::Header::new_gnu();
                header.set_mode(0o777);
                header.set_size(0);
                header.set_entry_type(tar::EntryType::Symlink);
                archive
                    .append_link(&mut header, "project/escape", "/tmp")
                    .unwrap();
            } else {
                let mut file = tar::Header::new_gnu();
                file.set_mode(0o644);
                file.set_size(5);
                archive
                    .append_data(&mut file, "project/a 'привет'.txt", &b"hello"[..])
                    .unwrap();
            }
            archive.finish().unwrap();
        }
        bytes
    }

    #[test]
    fn streaming_extraction_preserves_readonly_directory_and_checks_gzip_crc() {
        let stage = std::env::temp_dir().join(format!("archive-unpack-{}", Uuid::new_v4()));
        create_private_dir(&stage).unwrap();
        let control = TransferControl::for_test("unpack");
        let tar = fixture_archive(false);
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&tar).unwrap();
        let mut gzip = encoder.finish().unwrap();
        // Model BSD tar's padding on its compressed stdout stream.
        gzip.resize(gzip.len() + 1024, 0);
        let count = unpack_gzip(gzip.as_slice(), &stage, &["project".into()], &control).unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            fs::read(stage.join("project/a 'привет'.txt")).unwrap(),
            b"hello"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(stage.join("project"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o555
            );
        }
        remove_local_stage(&stage).unwrap();
        create_private_dir(&stage).unwrap();
        let crc = gzip.len() - 1024 - 8;
        gzip[crc] ^= 1;
        assert!(unpack_gzip(gzip.as_slice(), &stage, &["project".into()], &control).is_err());
        remove_local_stage(&stage).unwrap();
    }

    #[test]
    fn extraction_rejects_links_and_unselected_roots() {
        let stage = std::env::temp_dir().join(format!("archive-untrusted-{}", Uuid::new_v4()));
        create_private_dir(&stage).unwrap();
        let control = TransferControl::for_test("untrusted");
        assert!(unpack_archive(
            fixture_archive(true).as_slice(),
            &stage,
            &["project".into()],
            &control
        )
        .unwrap_err()
        .contains("link or special"));
        remove_local_stage(&stage).unwrap();
        create_private_dir(&stage).unwrap();
        assert!(unpack_archive(
            fixture_archive(false).as_slice(),
            &stage,
            &["different".into()],
            &control
        )
        .unwrap_err()
        .contains("unexpected archive path"));
        remove_local_stage(&stage).unwrap();
    }

    #[test]
    fn gzip_extraction_rejects_nonzero_trailing_data() {
        let stage = std::env::temp_dir().join(format!("archive-trailer-{}", Uuid::new_v4()));
        create_private_dir(&stage).unwrap();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&fixture_archive(false)).unwrap();
        let mut data = encoder.finish().unwrap();
        data.extend_from_slice(b"unexpected second payload");
        let control = TransferControl::for_test("trailer");
        assert!(
            unpack_gzip(data.as_slice(), &stage, &["project".into()], &control)
                .unwrap_err()
                .contains("Unexpected data")
        );
        remove_local_stage(&stage).unwrap();
    }

    #[test]
    fn extraction_accepts_contained_hardlinks_and_rejects_escape() {
        for target in ["project/original", "../outside"] {
            let stage = std::env::temp_dir().join(format!("archive-hardlink-{}", Uuid::new_v4()));
            create_private_dir(&stage).unwrap();
            let mut data = Vec::new();
            {
                let mut archive = tar::Builder::new(&mut data);
                let mut original = tar::Header::new_gnu();
                original.set_mode(0o644);
                original.set_size(4);
                archive
                    .append_data(&mut original, "project/original", &b"data"[..])
                    .unwrap();
                let mut link = tar::Header::new_gnu();
                link.set_entry_type(tar::EntryType::Link);
                link.set_size(0);
                link.set_mode(0o644);
                archive
                    .append_link(&mut link, "project/link", target)
                    .unwrap();
                archive.finish().unwrap();
            }
            let control = TransferControl::for_test("hardlink");
            let result = unpack_archive(data.as_slice(), &stage, &["project".into()], &control);
            if target.starts_with("project/") {
                assert_eq!(result.unwrap(), 2);
                assert_eq!(fs::read(stage.join("project/link")).unwrap(), b"data");
            } else {
                assert!(result.unwrap_err().contains("hard link"));
            }
            remove_local_stage(&stage).unwrap();
        }
    }

    #[test]
    fn archive_names_and_paths_reject_traversal_and_duplicates() {
        assert!(root_names(&["/one/a".into(), "/two/a".into()]).is_err());
        assert!(root_names(&["/".into()]).is_err());
        assert!(root_names(&["/one/../a".into()]).is_err());
        assert!(root_names(&["relative".into()]).is_err());
        let roots = vec!["project".into()];
        for path in ["../project/a", "/project/a", "project/../../a", "other/a"] {
            assert!(!safe_archive_path(Path::new(path), &roots), "{path}");
        }
        assert!(safe_archive_path(Path::new("project/a b/'file'"), &roots));
        assert_eq!(quote("a'b\n;$(touch bad)"), "'a'\\''b\n;$(touch bad)'");
    }

    #[test]
    fn exclusive_publication_preserves_existing_file() {
        let root = std::env::temp_dir().join(format!("archive-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let source = root.join("source");
        let target = root.join("target");
        fs::write(&source, b"new").unwrap();
        fs::write(&target, b"old").unwrap();
        assert!(publish_local(&source, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old");
        fs::remove_dir_all(root).unwrap();
    }
}
