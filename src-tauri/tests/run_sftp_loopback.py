#!/usr/bin/env python3
"""Run opt-in Rust transfer tests against an ephemeral, loopback-only sshd.

Requires sshd, ssh-keygen, Cargo, and a current account accepted by sshd.
No saved application profiles, account authorized_keys, or known_hosts are used.
"""
import getpass
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time


def main():
    sshd = shutil.which("sshd") or "/usr/sbin/sshd"
    if not Path(sshd).is_file():
        raise SystemExit("OpenSSH sshd is required")
    project = Path(__file__).resolve().parents[1]
    parent = "/private/tmp" if Path("/private/tmp").is_dir() else "/tmp"
    with tempfile.TemporaryDirectory(prefix="port-forward-sftp-test-", dir=parent) as temporary:
        root = Path(temporary)
        for name in ("host_key", "user_key"):
            subprocess.run(["ssh-keygen", "-q", "-t", "rsa", "-b", "2048", "-N", "", "-m", "PEM", "-f", str(root / name)], check=True)
        (root / "authorized_keys").write_text((root / "user_key.pub").read_text())
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        (root / "known_hosts").write_text(f"[127.0.0.1]:{port} " + (root / "host_key.pub").read_text())
        config = root / "sshd_config"
        config.write_text("\n".join([
            f"Port {port}", "ListenAddress 127.0.0.1",
            f"HostKey {root}/host_key", f"PidFile {root}/sshd.pid",
            f"AuthorizedKeysFile {root}/authorized_keys", f"AllowUsers {getpass.getuser()}",
            "StrictModes no", "UsePAM no", "PasswordAuthentication no",
            "KbdInteractiveAuthentication no", "PubkeyAuthentication yes",
            "Subsystem sftp internal-sftp", "LogLevel ERROR", "UseDNS no",
        ]) + "\n")
        subprocess.run([sshd, "-t", "-f", str(config)], check=True)
        with (root / "sshd.log").open("w+") as log:
            daemon = subprocess.Popen([sshd, "-D", "-e", "-f", str(config)], stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    if daemon.poll() is not None:
                        log.seek(0)
                        raise RuntimeError("Fixture sshd failed: " + log.read())
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                            break
                    except OSError:
                        time.sleep(0.02)
                else:
                    raise RuntimeError("Fixture sshd did not open its loopback port")
                environment = dict(os.environ, SFTP_TEST_PORT=str(port), SFTP_TEST_KEY=str(root / "user_key"), SFTP_TEST_KNOWN_HOSTS=str(root / "known_hosts"), SFTP_TEST_ROOT=str(root), USER=getpass.getuser())
                result = subprocess.run(["cargo", "test", "--lib", "loopback_", "--", "--ignored", "--nocapture"], cwd=project, env=environment)
                if result.returncode:
                    log.seek(0)
                    print(log.read())
                return result.returncode
            finally:
                daemon.terminate()
                try:
                    daemon.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    daemon.kill()
                    daemon.wait()


if __name__ == "__main__":
    raise SystemExit(main())
