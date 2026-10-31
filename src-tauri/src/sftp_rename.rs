//! OpenSSH atomic file replacement over the negotiated SFTP extension.
//! libssh2's v3 RENAME flags do not implement posix-rename@openssh.com.
use std::{
    io::{Read, Write},
    path::Path,
};

use ssh2::{ErrorCode, RenameFlags, Session, Sftp};

const MAX_PACKET: usize = 256 * 1024;
const EXTENSION: &[u8] = b"posix-rename@openssh.com";
const REQUEST_ID: u32 = 1;

pub(crate) fn remote(
    session: &Session,
    sftp: &Sftp,
    source: &Path,
    target: &Path,
    overwrite: bool,
) -> Result<(), String> {
    if !overwrite {
        return sftp
            .rename(source, target, Some(RenameFlags::empty()))
            .map_err(|error| format!("SFTP rename failed: {error}"));
    }
    match sftp.lstat(target) {
        // The ordinary v3 operation already gives exclusive publication when no
        // replacement is needed. A target created after this check causes failure.
        Err(error) if matches!(error.code(), ErrorCode::SFTP(2) | ErrorCode::SFTP(10)) => {
            return sftp
                .rename(source, target, Some(RenameFlags::empty()))
                .map_err(|error| format!("SFTP rename failed: {error}"));
        }
        Ok(stat) if stat.is_file() => {}
        Ok(_) => return Err("Only regular files can be replaced atomically".into()),
        Err(error) => return Err(format!("Cannot inspect rename destination: {error}")),
    }
    if !sftp
        .lstat(source)
        .map_err(|error| format!("Cannot inspect rename source: {error}"))?
        .is_file()
    {
        return Err("Only regular files can replace an existing file".into());
    }
    let source = path_bytes(source)?;
    let target = path_bytes(target)?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("Cannot open atomic SFTP rename channel: {error}"))?;
    channel
        .subsystem("sftp")
        .map_err(|error| format!("Cannot start atomic SFTP rename subsystem: {error}"))?;
    let result = (|| {
        let mut init = vec![1]; // SSH_FXP_INIT
        init.extend_from_slice(&3u32.to_be_bytes());
        write_packet(&mut channel, &init)?;
        let version = read_packet(&mut channel)?;
        require_posix_rename(&version)?;
        let mut request = vec![200]; // SSH_FXP_EXTENDED
        request.extend_from_slice(&REQUEST_ID.to_be_bytes());
        push_string(&mut request, EXTENSION)?;
        push_string(&mut request, &source)?;
        push_string(&mut request, &target)?;
        write_packet(&mut channel, &request)?;
        parse_status(&read_packet(&mut channel)?, REQUEST_ID)
    })();
    // The status packet is the acknowledgement of the rename. A close failure
    // after it must not turn a committed replacement into a reported failure.
    let _ = channel.send_eof();
    let _ = channel.close();
    result
}

fn path_bytes(path: &Path) -> Result<Vec<u8>, String> {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    };
    #[cfg(not(unix))]
    let bytes = path
        .to_str()
        .ok_or("SFTP filename is not UTF-8")?
        .as_bytes()
        .to_vec();
    if bytes.is_empty() || bytes.contains(&0) || bytes.len() > MAX_PACKET - 64 {
        return Err("Invalid or oversized SFTP rename path".into());
    }
    Ok(bytes)
}

fn write_packet(writer: &mut impl Write, packet: &[u8]) -> Result<(), String> {
    if packet.is_empty() || packet.len() > MAX_PACKET {
        return Err("Invalid or oversized SFTP packet".into());
    }
    // ssh2::Channel::flush discards unread *incoming* channel data. Writes are
    // already sent by write_all; flushing here could discard the VERSION/STATUS.
    writer
        .write_all(&(packet.len() as u32).to_be_bytes())
        .and_then(|_| writer.write_all(packet))
        .map_err(|error| format!("Cannot send atomic SFTP rename request: {error}"))
}

fn read_packet(reader: &mut impl Read) -> Result<Vec<u8>, String> {
    let mut length = [0u8; 4];
    reader
        .read_exact(&mut length)
        .map_err(|error| format!("Cannot read atomic SFTP rename packet length: {error}"))?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_PACKET {
        return Err("Invalid or oversized SFTP response packet".into());
    }
    let mut packet = vec![0; length];
    reader
        .read_exact(&mut packet)
        .map_err(|error| format!("Incomplete atomic SFTP rename response: {error}"))?;
    Ok(packet)
}

fn push_string(packet: &mut Vec<u8>, value: &[u8]) -> Result<(), String> {
    if value.len() > MAX_PACKET
        || packet
            .len()
            .checked_add(4 + value.len())
            .is_none_or(|length| length > MAX_PACKET)
    {
        return Err("SFTP request strings exceed the packet limit".into());
    }
    packet.extend_from_slice(&(value.len() as u32).to_be_bytes());
    packet.extend_from_slice(value);
    Ok(())
}

struct Packet<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Packet<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self, String> {
        if bytes.is_empty() || bytes.len() > MAX_PACKET {
            return Err("Invalid SFTP response size".into());
        }
        Ok(Self { bytes, offset: 0 })
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or("Invalid SFTP response length")?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or("Truncated SFTP response")?;
        self.offset = end;
        Ok(value)
    }
    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn number(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| "Truncated SFTP number")?,
        ))
    }
    fn string(&mut self) -> Result<&'a [u8], String> {
        let length = self.number()? as usize;
        self.take(length)
    }
    fn done(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn require_posix_rename(bytes: &[u8]) -> Result<(), String> {
    let mut packet = Packet::new(bytes)?;
    if packet.byte()? != 2 || packet.number()? != 3 {
        return Err("Server did not negotiate SFTP version 3".into());
    }
    let mut supported = false;
    while !packet.done() {
        let name = packet.string()?;
        let version = packet.string()?;
        if name == EXTENSION {
            if version != b"1" {
                return Err(
                    "Server advertises an unsupported atomic rename extension version".into(),
                );
            }
            supported = true;
        }
    }
    if supported {
        Ok(())
    } else {
        Err("Server does not support atomic file replacement (posix-rename@openssh.com); the original file was kept".into())
    }
}

fn parse_status(bytes: &[u8], request_id: u32) -> Result<(), String> {
    let mut packet = Packet::new(bytes)?;
    if packet.byte()? != 101 {
        return Err("Expected an SFTP rename status response".into());
    }
    if packet.number()? != request_id {
        return Err("SFTP rename response ID does not match the request".into());
    }
    let status = packet.number()?;
    let description = packet.string()?;
    let _language = packet.string()?;
    if !packet.done() {
        return Err("SFTP rename status contains unexpected trailing data".into());
    }
    if status == 0 {
        return Ok(());
    }
    let description = String::from_utf8_lossy(description)
        .chars()
        .take(256)
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if description.is_empty() {
        Err(format!("Atomic SFTP rename failed with status {status}; the server did not confirm replacement"))
    } else {
        Err(format!(
            "Atomic SFTP rename failed with status {status}: {description}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn version(extension: bool) -> Vec<u8> {
        let mut packet = vec![2];
        packet.extend_from_slice(&3u32.to_be_bytes());
        if extension {
            push_string(&mut packet, EXTENSION).unwrap();
            push_string(&mut packet, b"1").unwrap();
        }
        packet
    }
    fn status(id: u32, code: u32, message: &[u8]) -> Vec<u8> {
        let mut packet = vec![101];
        packet.extend_from_slice(&id.to_be_bytes());
        packet.extend_from_slice(&code.to_be_bytes());
        push_string(&mut packet, message).unwrap();
        push_string(&mut packet, b"").unwrap();
        packet
    }
    #[test]
    fn requires_explicit_supported_extension() {
        assert!(require_posix_rename(&version(true)).is_ok());
        assert!(require_posix_rename(&version(false)).is_err());
        let mut wrong = version(true);
        *wrong.last_mut().unwrap() = b'2';
        assert!(require_posix_rename(&wrong).is_err());
        let mut odd = version(true);
        odd.push(0);
        assert!(require_posix_rename(&odd).is_err());
        let mut v4 = version(true);
        v4[4] = 4;
        assert!(require_posix_rename(&v4).is_err());
        assert!(require_posix_rename(&[2]).is_err());
    }
    #[test]
    fn validates_status_type_id_code_and_string_lengths() {
        assert!(parse_status(&status(1, 0, b"Success"), 1).is_ok());
        assert!(parse_status(&status(2, 0, b"Success"), 1).is_err());
        let denied = parse_status(&status(1, 3, b"Permission\n\x1bdenied"), 1).unwrap_err();
        assert!(denied.contains("status 3"));
        assert!(!denied.contains('\n'));
        assert!(!denied.contains('\x1b'));
        let mut wrong_type = status(1, 0, b"");
        wrong_type[0] = 104;
        assert!(parse_status(&wrong_type, 1).is_err());
        let mut truncated = status(1, 0, b"ok");
        truncated.pop();
        assert!(parse_status(&truncated, 1).is_err());
        let mut malformed = status(1, 0, b"ok");
        malformed[9..13].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(parse_status(&malformed, 1).is_err());
        let mut trailing = status(1, 0, b"");
        trailing.push(0);
        assert!(parse_status(&trailing, 1).is_err());
    }
    #[test]
    fn sending_packets_does_not_flush_incoming_channel_data() {
        struct ChannelWriter(Vec<u8>);
        impl Write for ChannelWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::Error::other(
                    "Channel flush would discard the response",
                ))
            }
        }
        let mut channel = ChannelWriter(Vec::new());
        write_packet(&mut channel, &version(true)).unwrap();
        assert_eq!(
            read_packet(&mut channel.0.as_slice()).unwrap(),
            version(true)
        );
    }
    #[test]
    fn packet_framing_bounds_allocation_and_detects_eof() {
        for length in [0u32, MAX_PACKET as u32 + 1, u32::MAX] {
            assert!(read_packet(&mut &length.to_be_bytes()[..]).is_err());
        }
        assert!(read_packet(&mut &[0, 0][..]).is_err());
        assert!(read_packet(&mut &[0, 0, 0, 2, 1][..]).is_err());
        let mut framed = Vec::new();
        write_packet(&mut framed, &version(true)).unwrap();
        assert_eq!(read_packet(&mut framed.as_slice()).unwrap(), version(true));
        let mut request = vec![0; MAX_PACKET - 1];
        assert!(push_string(&mut request, b"a").is_err());
        assert!(write_packet(&mut Vec::new(), &[]).is_err());
    }
}
