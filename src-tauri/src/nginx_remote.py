"""Single-request remote Nginx helper. Input/output is JSON; no user shell code."""

import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import uuid


MAX_CONTENT = 256 * 1024
MAX_REQUEST = 1024 * 1024
RESPONSE_PREFIX = "__PORT_FORWARD_NGINX_JSON__"


class NginxError(Exception):
    pass


def config_tokens(content):
    tokens, word = [], []
    word_started = False
    quote = None
    escaped = False
    comment = False
    variable_brace = False
    for char in content:
        if comment:
            if char == "\n":
                comment = False
            else:
                continue
        if escaped:
            word.append(char)
            word_started = True
            escaped = False
            continue
        if char == "\\":
            escaped = True
            word_started = True
            continue
        if quote:
            if char == quote:
                quote = None
            else:
                word.append(char)
            continue
        if char in "\"'":
            quote = char
            word_started = True
        elif char == "#":
            if word_started:
                tokens.append(("value", "".join(word)))
                word = []
                word_started = False
            comment = True
        elif char == "{" and word and word[-1] == "$":
            word.append(char)
            variable_brace = True
        elif variable_brace:
            word.append(char)
            if char == "}":
                variable_brace = False
        elif char in "{};":
            if word_started:
                tokens.append(("value", "".join(word)))
                word = []
                word_started = False
            tokens.append(("symbol", char))
        elif char.isspace():
            if word_started:
                tokens.append(("value", "".join(word)))
                word = []
                word_started = False
        else:
            word.append(char)
            word_started = True
    if quote or escaped or variable_brace:
        raise NginxError("Unterminated quoted value in configuration")
    if word_started:
        tokens.append(("value", "".join(word)))
    return tokens


def parse_servers(content):
    root = {"name": "", "directives": [], "children": []}
    stack, pending = [root], []
    for kind, token in config_tokens(content):
        if kind == "symbol" and token == "{":
            if not pending:
                raise NginxError("Unnamed configuration block")
            block = {"name": pending[0], "directives": [], "children": []}
            stack[-1]["children"].append(block)
            stack.append(block)
            pending = []
        elif kind == "symbol" and token == "}":
            if len(stack) == 1 or pending:
                raise NginxError("Unbalanced configuration block")
            stack.pop()
        elif kind == "symbol" and token == ";":
            if pending:
                stack[-1]["directives"].append((pending[0], pending[1:]))
            pending = []
        else:
            pending.append(token)
    if len(stack) != 1 or pending:
        raise NginxError("Incomplete configuration block or directive")

    servers = []

    def visit(block):
        if block["name"] == "server":
            values = {}
            for key, args in block["directives"]:
                values.setdefault(key, []).append(args)
            names = [name for args in values.get("server_name", []) for name in args]
            tls = bool(values.get("ssl_certificate")) or any(
                "ssl" in args for args in values.get("listen", [])
            )
            servers.append({"names": names, "tls": tls, "values": values})
        for child in block["children"]:
            visit(child)

    visit(root)
    return servers


def safe_filename(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", value):
        raise NginxError("Use a file name without directories or special characters")
    if ".." in value:
        raise NginxError("Parent-directory sequences are not allowed in file names")
    return value


def safe_absolute_path(value, label):
    if not isinstance(value, str) or not value.startswith("/") or any(
        char in value for char in "\x00\r\n"
    ):
        raise NginxError(label + " must be an absolute path")
    path = Path(value)
    if ".." in path.parts or path == Path("/"):
        raise NginxError(label + " must not contain parent-directory segments or be /")
    return path


def validate_content(value):
    if not isinstance(value, str) or not value.strip():
        raise NginxError("Configuration content is empty")
    if "\x00" in value or len(value.encode("utf-8")) > MAX_CONTENT:
        raise NginxError("Configuration must be UTF-8 text smaller than 256 KiB")
    return value if value.endswith("\n") else value + "\n"


def domain_name(value):
    if not isinstance(value, str):
        raise NginxError("A domain name is required")
    value = value.lower().rstrip(".")
    if len(value) > 253 or "." not in value or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in value.split(".")
    ):
        raise NginxError("Use a valid ASCII domain name; wildcard certificates require DNS validation")
    return value


def operation_result(success, log, site=None, backup=None):
    return {"success": success, "log": "\n".join(log), "site": site, "backupPath": backup}


class Manager:
    def __init__(self, settings):
        configured_root = safe_absolute_path(settings.get("configDir", "/etc/nginx"), "Nginx directory")
        self.root = configured_root.resolve()
        if self.root != configured_root:
            raise NginxError("Nginx directory must not contain symlink components")
        if not self.root.is_dir():
            raise NginxError("Nginx directory does not exist: " + str(self.root))
        self.available = self.root / "sites-available"
        self.enabled = self.root / "sites-enabled"
        for directory in (self.available, self.enabled):
            if not directory.is_dir() or directory.is_symlink() or directory.resolve().parent != self.root:
                raise NginxError("Expected a real sites-available/sites-enabled directory under " + str(self.root))
        self.webroot = safe_absolute_path(settings.get("webroot", "/var/www/_letsencrypt"), "ACME webroot")

    def file_path(self, name):
        path = self.available / safe_filename(name)
        if path.is_symlink():
            raise NginxError("Refusing to manage a symlink in sites-available: " + name)
        if path.exists() and not path.is_file():
            raise NginxError("Site is not a regular file: " + name)
        return path

    def links(self, name):
        target = self.available / safe_filename(name)
        links = {}
        for entry in self.enabled.iterdir():
            if entry.is_symlink() and entry.resolve() == target:
                safe_filename(entry.name)
                links[entry.name] = os.readlink(entry)
        return links

    def capture(self, name):
        path = self.file_path(name)
        links = self.links(name)
        if path.exists():
            info = path.stat()
            data = path.read_bytes()
            if len(data) > MAX_CONTENT:
                raise NginxError("Site configuration exceeds the 256 KiB editor limit: " + name)
            return {"data": data, "links": links, "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid}
        return {"data": None, "links": links, "mode": 0o644, "uid": os.geteuid(), "gid": os.getegid()}

    def revision(self, state):
        digest = hashlib.sha256()
        digest.update(b"missing" if state["data"] is None else b"present\0" + state["data"])
        digest.update(json.dumps(state["links"], sort_keys=True).encode("utf-8"))
        return digest.hexdigest()

    def site(self, name, include_content=True):
        state = self.capture(name)
        if state["data"] is None:
            raise NginxError("Site does not exist: " + name)
        try:
            content = state["data"].decode("utf-8")
        except UnicodeDecodeError:
            raise NginxError("Site is not UTF-8 text: " + name)
        try:
            servers = parse_servers(content)
        except NginxError:
            servers = []
        site = {"fileName": name, "enabled": bool(state["links"]), "revision": self.revision(state), "domains": list(dict.fromkeys(name for server in servers for name in server["names"])), "hasTls": any(server["tls"] for server in servers)}
        if include_content:
            site["content"] = content
        return site

    def inventory(self):
        sites, warnings = [], []
        for entry in sorted(self.available.iterdir(), key=lambda item: item.name):
            if entry.name.startswith("."):
                continue
            try:
                sites.append(self.site(entry.name, include_content=False))
            except (OSError, NginxError) as error:
                warnings.append(str(error))
        for entry in self.enabled.iterdir():
            if entry.name.startswith("."):
                continue
            if not entry.is_symlink():
                warnings.append("Enabled entry is not a symlink and is not managed: " + entry.name)
            elif not entry.exists():
                warnings.append("Broken enabled symlink: " + entry.name)
            elif entry.resolve().parent != self.available:
                warnings.append("Enabled symlink points outside sites-available and is not managed: " + entry.name)
        return {"sites": sites, "warnings": warnings}

    @contextlib.contextmanager
    def lock(self):
        lock_path = self.root / ".port-forward-nginx.lock"
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise NginxError("Another Nginx operation is running for this server; wait for it to finish")
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def executable(self, name):
        path = shutil.which(name, path=os.environ.get("PATH", "") + ":/usr/sbin:/sbin:/usr/local/sbin")
        if not path:
            raise NginxError(name + " is not installed or not in PATH")
        return path

    def run(self, args, log, timeout=30, log_stdout=True):
        log.append("$ " + " ".join(args))
        try:
            result = subprocess.run(args, cwd=self.root, capture_output=True, text=True, errors="replace", timeout=timeout)
        except subprocess.TimeoutExpired:
            raise NginxError("Command timed out after " + str(timeout) + " seconds: " + args[0])
        output = "\n".join(part.strip() for part in ((result.stdout if log_stdout else ""), result.stderr) if part.strip())
        if output:
            log.append(output[-32768:])
        if result.returncode != 0:
            raise NginxError("Command failed with exit status " + str(result.returncode))
        return result

    def test(self, log, site_name=None, expect_loaded=True, reject_conflicts=False):
        result = self.run([self.executable("nginx"), "-T" if site_name else "-t", "-c", str(self.root / "nginx.conf")], log, log_stdout=False)
        if reject_conflicts and "conflicting server name" in result.stderr.lower():
            raise NginxError("Nginx reported a conflicting server name; resolve it before issuing a certificate")
        if site_name:
            target = self.available / site_name
            loaded = any(Path(path).resolve() == target for path in re.findall(r"(?m)^# configuration file (.+):\s*$", result.stdout))
            if loaded != expect_loaded:
                if expect_loaded:
                    raise NginxError("The site is not included by nginx.conf; configure its sites-enabled include before applying it")
                raise NginxError("The site remains included by nginx.conf after disabling its symlink; remove the direct include before disabling it")

    def reload(self, log):
        self.run([self.executable("nginx"), "-c", str(self.root / "nginx.conf"), "-s", "reload"], log)
        log.append("Nginx configuration validated; reload signal sent.")

    def test_or_reload(self, reload=False):
        log = []
        try:
            with self.lock():
                self.test(log)
                if reload:
                    self.reload(log)
            return operation_result(True, log)
        except (NginxError, OSError) as error:
            log.append(str(error))
            return operation_result(False, log)

    def preflight(self, request):
        name = safe_filename(request.get("fileName"))
        state = self.capture(name)
        if request.get("create"):
            if state["data"] is not None or state["links"]:
                raise NginxError("A site with this file name already exists; choose another name or refresh before editing")
        elif state["data"] is None:
            raise NginxError("Site does not exist; refresh the list")
        elif not request.get("expectedRevision") or request["expectedRevision"] != self.revision(state):
            raise NginxError("Site changed since it was opened; reload it before saving")
        named_link = self.enabled / name
        if os.path.lexists(named_link) and not (named_link.is_symlink() and named_link.resolve() == self.available / name):
            raise NginxError("An unrelated sites-enabled entry already uses this file name: " + name)
        return name, state

    def validate_provision(self, request, name, state, content):
        primary = domain_name(request.get("domain"))
        raw_aliases = request.get("aliases", [])
        if not isinstance(raw_aliases, list) or len(raw_aliases) > 99:
            raise NginxError("Aliases must be a list of at most 99 domain names")
        names = list(dict.fromkeys([primary] + [domain_name(alias) for alias in raw_aliases]))
        email = request.get("email", "")
        if not isinstance(email, str) or len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise NginxError("A valid certificate contact email is required")
        if state["data"] is not None and state["links"]:
            try:
                original_servers = parse_servers(state["data"].decode("utf-8"))
            except (NginxError, UnicodeDecodeError):
                raise NginxError("The enabled site's current configuration cannot be inspected safely; fix its syntax or disable it before certificate provisioning")
            if any(server["tls"] for server in original_servers):
                raise NginxError("This site already serves HTTPS. Save configuration changes normally, or disable it before certificate provisioning to avoid interrupting working TLS")
        tls_servers = [server for server in parse_servers(content) if server["tls"]]
        if not tls_servers:
            raise NginxError("The final configuration must contain an HTTPS server block")
        expected_cert = "/etc/letsencrypt/live/" + primary + "/fullchain.pem"
        expected_key = "/etc/letsencrypt/live/" + primary + "/privkey.pem"
        covered = set()
        for server in tls_servers:
            server_names = {value.lower().rstrip(".") for value in server["names"]}
            if not server_names or not server_names.issubset(set(names)):
                raise NginxError("HTTPS server_name values must match the requested certificate domains")
            if server["values"].get("ssl_certificate") != [[expected_cert]] or server["values"].get("ssl_certificate_key") != [[expected_key]]:
                raise NginxError("HTTPS certificate paths must use " + expected_cert + " and " + expected_key)
            covered.update(server_names)
        if covered != set(names):
            raise NginxError("Every requested certificate domain must appear in an HTTPS server_name")
        for entry in self.enabled.iterdir():
            if entry.resolve() == self.available / name or not entry.is_file():
                continue
            try:
                if entry.stat().st_size > MAX_CONTENT:
                    raise NginxError("Enabled config is too large to inspect: " + entry.name)
                others = parse_servers(entry.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, NginxError) as error:
                raise NginxError("Could not check enabled domains in " + entry.name + ": " + str(error))
            if any(domain_matches(pattern, domain) for server in others for pattern in server["names"] for domain in names):
                raise NginxError("A requested domain is already enabled in " + entry.name)
        self.executable("nginx")
        self.executable("certbot")
        return primary, names, email

    def prepare_webroot(self):
        for directory in (self.webroot, self.webroot / ".well-known", self.webroot / ".well-known" / "acme-challenge"):
            if directory.is_symlink() or directory.resolve() != directory:
                raise NginxError("ACME webroot directories must not be symlinks: " + str(directory))
            directory.mkdir(mode=0o755, parents=True, exist_ok=True)
            if not directory.is_dir() or directory.resolve() != directory:
                raise NginxError("ACME webroot must resolve to its configured absolute directory")

    def mutate(self, operation, request):
        log, transaction = [], None
        try:
            with self.lock():
                try:
                    name, original = self.preflight(request)
                    content = validate_content(request.get("content")) if operation != "set_enabled" else None
                    if operation == "provision":
                        primary, domains, email = self.validate_provision(request, name, original, content)
                        self.prepare_webroot()
                    transaction = Transaction(self, name, original)
                    log.append("Backup: " + transaction.backup)
                    if operation == "provision":
                        transaction.write(bootstrap_configuration(domains, self.webroot))
                        transaction.set_enabled(True)
                        self.test(log, name, reject_conflicts=True)
                        transaction.reload_attempted = True
                        self.reload(log)
                        certbot = [self.executable("certbot"), "certonly", "--webroot", "-w", str(self.webroot), "--cert-name", primary]
                        for domain in domains:
                            certbot += ["-d", domain]
                        certbot += ["--email", email, "-n", "--agree-tos", "--force-renewal" if request.get("forceRenewal") else "--keep-until-expiring"]
                        self.run(certbot, log, timeout=300)
                        transaction.write(content)
                        self.test(log, name, reject_conflicts=True)
                        self.reload(log)
                        log.append("Certificate command completed and HTTPS configuration installed.")
                    else:
                        enabled = request.get("enabled")
                        if not isinstance(enabled, bool):
                            raise NginxError("Enabled must be true or false")
                        if content is not None:
                            transaction.write(content)
                        transaction.set_enabled(enabled)
                        if enabled or original["links"]:
                            self.test(log, name, expect_loaded=enabled)
                            transaction.reload_attempted = True
                            self.reload(log)
                        else:
                            self.test(log, name, expect_loaded=False)
                            log.append("Saved disabled draft; it is not loaded by Nginx and its syntax has not been tested.")
                    return operation_result(True, log, self.site(name), transaction.backup)
                except Exception as error:
                    log.append(str(error))
                    if transaction:
                        transaction.rollback(log)
                    site = None
                    if transaction and transaction.original["data"] is not None:
                        try:
                            site = self.site(transaction.name)
                        except (OSError, NginxError):
                            pass
                    return operation_result(False, log, site, transaction.backup if transaction else None)
        except (NginxError, OSError) as error:
            log.append(str(error))
            return operation_result(False, log)


class Transaction:
    def __init__(self, manager, name, original):
        self.manager, self.name, self.original = manager, name, original
        self.owned = original
        self.reload_attempted = False
        directory = manager.root / ".port-forward-backups"
        if directory.is_symlink():
            raise NginxError("Backup directory must not be a symlink")
        directory.mkdir(mode=0o700, exist_ok=True)
        self.backup = str(directory / (name + "." + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "." + uuid.uuid4().hex + ".json"))
        backup = {"fileName": name, "content": original["data"].decode("utf-8") if original["data"] is not None else None, "links": original["links"], "mode": original["mode"], "uid": original["uid"], "gid": original["gid"]}
        descriptor = os.open(self.backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(backup, handle)
            handle.flush()
            os.fsync(handle.fileno())

    def assert_owned(self):
        if self.manager.revision(self.manager.capture(self.name)) != self.manager.revision(self.owned):
            raise NginxError("Site changed externally during the operation; reload it before continuing")

    def remember(self):
        self.owned = self.manager.capture(self.name)

    def atomic_write(self, content, state):
        descriptor, temporary = tempfile.mkstemp(prefix=".port-forward-", dir=self.manager.available)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
                os.fchmod(handle.fileno(), state["mode"])
                if os.geteuid() == 0:
                    os.fchown(handle.fileno(), state["uid"], state["gid"])
            os.replace(temporary, self.manager.available / self.name)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def write(self, content):
        self.assert_owned()
        self.atomic_write(content.encode("utf-8"), self.original)
        self.remember()

    def set_enabled(self, enabled):
        self.assert_owned()
        links = self.manager.links(self.name)
        if enabled and not links:
            target = self.manager.enabled / self.name
            if os.path.lexists(target):
                raise NginxError("Enabled file name became occupied: " + self.name)
            os.symlink("../sites-available/" + self.name, target)
            self.remember()
        elif not enabled:
            for name in links:
                self.assert_owned()
                os.unlink(self.manager.enabled / name)
                self.remember()

    def rollback(self, log):
        try:
            self.assert_owned()
            current_links = self.manager.links(self.name)
            for name in current_links:
                os.unlink(self.manager.enabled / name)
            if self.original["data"] is None:
                path = self.manager.file_path(self.name)
                if path.exists():
                    path.unlink()
            else:
                self.atomic_write(self.original["data"], self.original)
            for name, target in self.original["links"].items():
                path = self.manager.enabled / name
                if os.path.lexists(path):
                    raise NginxError("Cannot restore enabled symlink because its name is occupied: " + name)
                os.symlink(target, path)
            self.remember()
            log.append("Previous site file and enabled links restored.")
            if self.reload_attempted:
                self.manager.test(log)
                self.manager.reload(log)
                log.append("Reload signal sent for the restored configuration.")
        except Exception as error:
            log.append("ROLLBACK NEEDS ATTENTION: " + str(error) + ". Backup remains at " + self.backup)


def domain_matches(pattern, domain):
    pattern = pattern.lower().rstrip(".")
    if pattern.startswith("*."):
        return domain.endswith(pattern[1:])
    if pattern.startswith("."):
        return domain == pattern[1:] or domain.endswith(pattern)
    if pattern.endswith(".*"):
        return domain.startswith(pattern[:-1])
    return pattern == domain


def bootstrap_configuration(domains, webroot):
    path = str(webroot).replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$")
    return "server {\n    listen 80;\n    listen [::]:80;\n    server_name " + " ".join(domains) + ";\n\n    location ^~ /.well-known/acme-challenge/ {\n        root \"" + path + "\";\n        default_type text/plain;\n        try_files $uri =404;\n    }\n\n    location / {\n        return 503;\n    }\n}\n"


def dispatch(payload):
    manager = Manager(payload.get("settings", {}))
    operation = payload.get("operation")
    if operation == "list":
        return manager.inventory()
    if operation == "read":
        return manager.site(safe_filename(payload.get("fileName")))
    if operation == "test":
        return manager.test_or_reload()
    if operation == "reload":
        return manager.test_or_reload(reload=True)
    if operation in ("save", "set_enabled", "provision"):
        request = payload.get("request")
        if not isinstance(request, dict):
            raise NginxError("Operation request must be an object")
        return manager.mutate(operation, request)
    raise NginxError("Unknown Nginx operation")


def main():
    def interrupted(signum, _frame):
        raise NginxError("Remote session interrupted by signal " + str(signum) + "; attempting rollback")

    for signum in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(signum, interrupted)
    try:
        content = sys.stdin.read(MAX_REQUEST + 1)
        if len(content.encode("utf-8")) > MAX_REQUEST:
            raise NginxError("Request exceeds 1 MiB")
        payload = json.loads(content)
        if not isinstance(payload, dict):
            raise NginxError("Request must be a JSON object")
        print(RESPONSE_PREFIX + json.dumps(dispatch(payload)))
    except Exception as error:
        print(RESPONSE_PREFIX + json.dumps({"error": str(error)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
