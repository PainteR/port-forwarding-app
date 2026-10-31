"""Isolated transaction tests: nginx and certbot are temporary fake executables."""

import importlib.util
import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


HELPER = Path(__file__).resolve().parents[1] / "src" / "nginx_remote.py"
SPEC = importlib.util.spec_from_file_location("nginx_remote", HELPER)
nginx = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(nginx)


FAKE_NGINX = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(sys.argv[sys.argv.index('-c') + 1]).parent
control_path = Path(os.environ['FAKE_CONTROL'])
control = json.loads(control_path.read_text())
with open(os.environ['FAKE_COMMANDS'], 'a') as output:
    output.write(json.dumps({'program': 'nginx', 'args': sys.argv[1:]}) + '\n')
entries = [entry for entry in sorted((root / 'sites-enabled').iterdir()) if entry.is_file()]
if control.get('direct_include'):
    entries += [Path(control['direct_include'])]
contents = [entry.read_text() for entry in entries]
if '-s' in sys.argv:
    if control.get('fail_reload_once'):
        control['fail_reload_once'] = False
        control_path.write_text(json.dumps(control))
        print('reload failed', file=sys.stderr)
        sys.exit(1)
    print('signal process started', file=sys.stderr)
    sys.exit(0)
if control.get('fail_tests') or any('INVALID_CONFIG' in content for content in contents):
    print('nginx configuration test failed', file=sys.stderr)
    sys.exit(1)
if control.get('fail_https_test') and any('listen 443 ssl' in content for content in contents):
    print('could not load SSL certificate', file=sys.stderr)
    sys.exit(1)
if '-T' in sys.argv:
    print('# configuration file ' + str(root / 'nginx.conf') + ':')
    print((root / 'nginx.conf').read_text())
    if not control.get('ignore_sites'):
        for entry, content in zip(entries, contents):
            print('# configuration file ' + str(entry) + ':')
            print(content)
print('syntax is ok; configuration test is successful', file=sys.stderr)
'''


FAKE_CERTBOT = r'''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
control = json.loads(Path(os.environ['FAKE_CONTROL']).read_text())
with open(os.environ['FAKE_COMMANDS'], 'a') as output:
    output.write(json.dumps({'program': 'certbot', 'args': sys.argv[1:]}) + '\n')
if control.get('certbot_fail'):
    print('ACME challenge validation failed', file=sys.stderr)
    sys.exit(1)
if control.get('pause_for_termination'):
    time.sleep(10)
if control.get('external_change'):
    Path(control['external_change']).write_text('server { listen 80; server_name externally-edited.example.com; }\n')
print('Certificate saved successfully')
'''


class NginxRemoteTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="port-forward-nginx-test-")
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / "nginx"
        self.available = self.root / "sites-available"
        self.enabled = self.root / "sites-enabled"
        self.available.mkdir(parents=True)
        self.enabled.mkdir()
        (self.root / "nginx.conf").write_text("events {}\nhttp { include sites-enabled/*; }\n")
        self.bin = self.base / "bin"
        self.bin.mkdir()
        for name, content in (("nginx", FAKE_NGINX), ("certbot", FAKE_CERTBOT)):
            path = self.bin / name
            path.write_text(content)
            path.chmod(0o755)
        self.control = self.base / "control.json"
        self.control.write_text("{}")
        self.commands = self.base / "commands.jsonl"
        self.environment = patch.dict(os.environ, {
            "PATH": str(self.bin) + os.pathsep + os.environ.get("PATH", ""),
            "FAKE_CONTROL": str(self.control),
            "FAKE_COMMANDS": str(self.commands),
        })
        self.environment.start()
        self.settings = {"configDir": str(self.root), "webroot": str(self.base / "webroot"), "useSudo": False}
        self.manager = nginx.Manager(self.settings)

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def set_control(self, **values):
        self.control.write_text(json.dumps(values))

    def calls(self):
        return [json.loads(line) for line in self.commands.read_text().splitlines()] if self.commands.exists() else []

    def create_site(self, name="example.com.conf", content=None, enabled=False):
        path = self.available / name
        path.write_text(content or "server { listen 80; server_name example.com www.example.com; }\n")
        if enabled:
            (self.enabled / name).symlink_to("../sites-available/" + name)
        return self.manager.site(name)

    def save_request(self, site=None, content=None, enabled=True):
        return {"fileName": site["fileName"] if site else "new.example.com.conf", "content": content or "server { listen 80; server_name new.example.com; }\n", "enabled": enabled, "create": site is None, "expectedRevision": site["revision"] if site else None}

    def final_configuration(self, domain="example.com", aliases=None):
        names = " ".join([domain] + (aliases or []))
        return "server {\n listen 443 ssl;\n listen [::]:443 ssl;\n server_name " + names + ";\n ssl_certificate /etc/letsencrypt/live/" + domain + "/fullchain.pem;\n ssl_certificate_key /etc/letsencrypt/live/" + domain + "/privkey.pem;\n location / { proxy_pass http://127.0.0.1:3000; }\n}\nserver { listen 80; server_name " + names + "; include nginxconfig.io/letsencrypt.conf; location / { return 301 https://" + domain + "$request_uri; } }\n"

    def provision_request(self, site=None, **overrides):
        request = {"fileName": site["fileName"] if site else "example.com.conf", "domain": "example.com", "aliases": ["www.example.com"], "email": "info@example.com", "content": self.final_configuration(aliases=["www.example.com"]), "create": site is None, "expectedRevision": site["revision"] if site else None, "forceRenewal": False}
        request.update(overrides)
        return request

    def test_inventory_is_read_only_and_preserves_primary_domain_order(self):
        self.create_site(content="server { listen 80; server_name example.com api.example.com; }\n", enabled=True)
        before = {str(path) for path in self.root.rglob("*")}
        inventory = self.manager.inventory()
        self.assertEqual(inventory["sites"][0]["domains"], ["example.com", "api.example.com"])
        self.assertTrue(inventory["sites"][0]["enabled"])
        self.assertEqual(inventory["warnings"], [])
        self.assertEqual(before, {str(path) for path in self.root.rglob("*")})

    def test_parser_handles_literal_braces_comments_and_variables(self):
        content = 'server { listen 443 ssl; server_name example.com; ssl_certificate "/certificate.pem"; location / { return 200 "{#;}"; add_header X-Value ${host}; } } # server_name ignored.example.com;\n'
        servers = nginx.parse_servers(content)
        self.assertEqual(servers[0]["names"], ["example.com"])
        self.assertTrue(servers[0]["tls"])

    def test_disabled_draft_can_reference_missing_certificates_without_reloading(self):
        request = self.save_request(content=self.final_configuration(), enabled=False)
        result = self.manager.mutate("save", request)
        self.assertTrue(result["success"], result["log"])
        self.assertFalse(result["site"]["enabled"])
        self.assertIn("syntax has not been tested", result["log"])
        self.assertEqual(len(self.calls()), 1)
        self.assertIn("-T", self.calls()[0]["args"])
        self.assertEqual(stat.S_IMODE(Path(result["backupPath"]).stat().st_mode), 0o600)

    def test_active_save_tests_loaded_site_before_reload_and_preserves_permissions(self):
        site = self.create_site(enabled=True)
        (self.available / site["fileName"]).chmod(0o600)
        result = self.manager.mutate("save", self.save_request(site))
        self.assertTrue(result["success"], result["log"])
        self.assertEqual(["-T" in call["args"] for call in self.calls()], [True, False])
        self.assertEqual(stat.S_IMODE((self.available / site["fileName"]).stat().st_mode), 0o600)
        self.assertNotIn("server_name", result["log"], "nginx -T dump must not appear in logs")

    def test_invalid_active_configuration_restores_file_without_reload(self):
        site = self.create_site(enabled=True)
        result = self.manager.mutate("save", self.save_request(site, content="INVALID_CONFIG\n"))
        self.assertFalse(result["success"])
        self.assertEqual((self.available / site["fileName"]).read_text(), site["content"])
        self.assertEqual(os.readlink(self.enabled / site["fileName"]), "../sites-available/" + site["fileName"])
        self.assertEqual(len(self.calls()), 1)
        self.assertIn("restored", result["log"])

    def test_failed_reload_restores_and_reloads_original_configuration(self):
        site = self.create_site(enabled=True)
        self.set_control(fail_reload_once=True)
        result = self.manager.mutate("save", self.save_request(site))
        self.assertFalse(result["success"])
        self.assertEqual((self.available / site["fileName"]).read_text(), site["content"])
        self.assertEqual(len(self.calls()), 4)
        self.assertIn("Reload signal sent for the restored configuration", result["log"])

    def test_enable_checks_effective_include_and_rolls_back_unloaded_site(self):
        site = self.create_site()
        self.set_control(ignore_sites=True)
        result = self.manager.mutate("set_enabled", {"fileName": site["fileName"], "enabled": True, "create": False, "expectedRevision": site["revision"]})
        self.assertFalse(result["success"])
        self.assertIn("not included by nginx.conf", result["log"])
        self.assertFalse((self.enabled / site["fileName"]).exists())
        self.assertEqual(len(self.calls()), 1)

    def test_disabled_draft_is_rejected_when_directly_included(self):
        site = self.create_site()
        self.set_control(direct_include=str(self.available / site["fileName"]))
        result = self.manager.mutate("save", self.save_request(site, enabled=False))
        self.assertFalse(result["success"])
        self.assertIn("remains included", result["log"])
        self.assertEqual((self.available / site["fileName"]).read_text(), site["content"])

    def test_concurrent_operation_lock_prevents_mutation(self):
        path = self.root / ".port-forward-nginx.lock"
        with path.open("a") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.manager.mutate("save", self.save_request(enabled=False))
        self.assertFalse(result["success"])
        self.assertIn("Another Nginx operation", result["log"])
        self.assertFalse((self.available / "new.example.com.conf").exists())

    def test_disabling_removes_all_links_to_selected_site(self):
        site = self.create_site(enabled=True)
        (self.enabled / "alias.conf").symlink_to("../sites-available/" + site["fileName"])
        site = self.manager.site(site["fileName"])
        result = self.manager.mutate("set_enabled", {"fileName": site["fileName"], "enabled": False, "create": False, "expectedRevision": site["revision"]})
        self.assertTrue(result["success"], result["log"])
        self.assertEqual(list(self.enabled.iterdir()), [])
        self.assertTrue((self.available / site["fileName"]).exists())

    def test_revision_conflict_and_file_collision_do_not_overwrite(self):
        site = self.create_site()
        changed = "server { listen 80; server_name changed.example.com; }\n"
        (self.available / site["fileName"]).write_text(changed)
        result = self.manager.mutate("save", self.save_request(site))
        self.assertFalse(result["success"])
        self.assertIn("changed since", result["log"])
        self.assertEqual((self.available / site["fileName"]).read_text(), changed)
        result = self.manager.mutate("save", {**self.save_request(), "fileName": site["fileName"]})
        self.assertFalse(result["success"])
        self.assertIn("already exists", result["log"])
        self.assertFalse((self.root / ".port-forward-backups").exists())

    def test_traversal_and_symlink_escapes_are_rejected(self):
        for name in ("../nginx.conf", "nested/site.conf", "bad;name.conf", "$(touch-pwn).conf"):
            with self.subTest(name=name):
                result = self.manager.mutate("save", {**self.save_request(), "fileName": name})
                self.assertFalse(result["success"])
        outside = self.base / "outside.conf"
        outside.write_text("do not overwrite")
        (self.available / "escape.conf").symlink_to(outside)
        result = self.manager.mutate("save", {**self.save_request(), "fileName": "escape.conf"})
        self.assertFalse(result["success"])
        self.assertEqual(outside.read_text(), "do not overwrite")
        (self.enabled / "new.example.com.conf").symlink_to(outside)
        result = self.manager.mutate("save", self.save_request())
        self.assertFalse(result["success"])
        self.assertEqual(os.readlink(self.enabled / "new.example.com.conf"), str(outside))

    def test_webroot_symlink_escape_is_rejected_before_creating_directories(self):
        outside = self.base / "outside-webroot"
        outside.mkdir()
        link = self.base / "webroot-link"
        link.symlink_to(outside)
        manager = nginx.Manager({**self.settings, "webroot": str(link / "new-directory")})
        result = manager.mutate("provision", self.provision_request())
        self.assertFalse(result["success"])
        self.assertIn("must not be symlinks", result["log"])
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse((self.available / "example.com.conf").exists())

    def test_certificate_flow_bootstraps_then_installs_https_with_fixed_lineage(self):
        request = self.provision_request()
        result = self.manager.mutate("provision", request)
        self.assertTrue(result["success"], result["log"])
        self.assertEqual((self.available / request["fileName"]).read_text(), request["content"])
        self.assertTrue((self.enabled / request["fileName"]).is_symlink())
        calls = self.calls()
        self.assertEqual([call["program"] for call in calls], ["nginx", "nginx", "certbot", "nginx", "nginx"])
        cert_args = calls[2]["args"]
        self.assertEqual(cert_args[cert_args.index("--cert-name") + 1], "example.com")
        self.assertIn("--keep-until-expiring", cert_args)
        self.assertNotIn("--force-renewal", cert_args)
        self.assertEqual([cert_args[index + 1] for index, arg in enumerate(cert_args) if arg == "-d"], ["example.com", "www.example.com"])
        self.assertTrue((self.base / "webroot" / ".well-known" / "acme-challenge").is_dir())

    def test_explicit_force_renewal_is_forwarded(self):
        result = self.manager.mutate("provision", self.provision_request(forceRenewal=True))
        self.assertTrue(result["success"], result["log"])
        cert = next(call for call in self.calls() if call["program"] == "certbot")
        self.assertIn("--force-renewal", cert["args"])
        self.assertNotIn("--keep-until-expiring", cert["args"])

    def test_certificate_failure_restores_new_file_link_and_running_configuration(self):
        self.set_control(certbot_fail=True)
        result = self.manager.mutate("provision", self.provision_request())
        self.assertFalse(result["success"])
        self.assertFalse((self.available / "example.com.conf").exists())
        self.assertFalse(os.path.lexists(self.enabled / "example.com.conf"))
        self.assertIn("ACME challenge validation failed", result["log"])
        self.assertIn("Reload signal sent for the restored configuration", result["log"])
        self.assertEqual([call["program"] for call in self.calls()], ["nginx", "nginx", "certbot", "nginx", "nginx"])

    def test_final_https_failure_restores_preexisting_disabled_draft(self):
        site = self.create_site(content="# original disabled draft\n")
        self.set_control(fail_https_test=True)
        result = self.manager.mutate("provision", self.provision_request(site))
        self.assertFalse(result["success"])
        self.assertEqual((self.available / site["fileName"]).read_text(), site["content"])
        self.assertFalse(os.path.lexists(self.enabled / site["fileName"]))
        self.assertIn("could not load SSL certificate", result["log"])

    def test_provision_rejects_active_tls_without_changing_it(self):
        site = self.create_site(content=self.final_configuration(aliases=["www.example.com"]), enabled=True)
        result = self.manager.mutate("provision", self.provision_request(site))
        self.assertFalse(result["success"])
        self.assertIn("already serves HTTPS", result["log"])
        self.assertEqual((self.available / site["fileName"]).read_text(), site["content"])
        self.assertEqual(self.calls(), [])

    def test_provision_rejects_domain_and_certificate_path_mismatch(self):
        for content in (self.final_configuration("other.example.com"), self.final_configuration(aliases=["unrequested.example.com"])):
            with self.subTest(content=content):
                result = self.manager.mutate("provision", self.provision_request(content=content))
                self.assertFalse(result["success"])
                self.assertFalse((self.available / "example.com.conf").exists())
                self.assertEqual(self.calls(), [])

    def test_provision_detects_conflicts_in_enabled_regular_and_external_files(self):
        duplicate = "server { listen 80; server_name example.com; }\n"
        for external in (False, True):
            with self.subTest(external=external):
                entry = self.enabled / "unmanaged.conf"
                if external:
                    target = self.base / "external.conf"
                    target.write_text(duplicate)
                    entry.symlink_to(target)
                else:
                    entry.write_text(duplicate)
                result = self.manager.mutate("provision", self.provision_request())
                self.assertFalse(result["success"])
                self.assertIn("already enabled", result["log"])
                self.assertEqual(self.calls(), [])
                entry.unlink()

    def test_external_edit_during_certbot_is_not_overwritten_by_rollback(self):
        self.set_control(external_change=str(self.available / "example.com.conf"))
        result = self.manager.mutate("provision", self.provision_request())
        self.assertFalse(result["success"])
        self.assertIn("ROLLBACK NEEDS ATTENTION", result["log"])
        self.assertIn("externally-edited.example.com", (self.available / "example.com.conf").read_text())
        self.assertTrue(Path(result["backupPath"]).is_file())

    def test_helper_cli_uses_framed_json(self):
        self.create_site()
        payload = {"operation": "list", "settings": self.settings}
        result = subprocess.run([sys.executable, str(HELPER)], input=json.dumps(payload), text=True, capture_output=True, check=True)
        self.assertTrue(result.stdout.startswith(nginx.RESPONSE_PREFIX))
        response = json.loads(result.stdout.removeprefix(nginx.RESPONSE_PREFIX))
        self.assertEqual(response["sites"][0]["fileName"], "example.com.conf")

    def test_interrupted_helper_rolls_back_while_certbot_is_running(self):
        self.set_control(pause_for_termination=True)
        process = subprocess.Popen([sys.executable, str(HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write(json.dumps({"operation": "provision", "settings": self.settings, "request": self.provision_request()}))
            process.stdin.close()
            process.stdin = None
            deadline = time.monotonic() + 5
            while not any(call["program"] == "certbot" for call in self.calls()):
                if process.poll() is not None or time.monotonic() > deadline:
                    self.fail("Fake certbot did not start")
                time.sleep(0.01)
            process.terminate()
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, stderr)
            result = json.loads(stdout.removeprefix(nginx.RESPONSE_PREFIX))
            self.assertFalse(result["success"])
            self.assertIn("Remote session interrupted", result["log"])
            self.assertIn("Reload signal sent for the restored configuration", result["log"])
            self.assertFalse((self.available / "example.com.conf").exists())
            self.assertFalse(os.path.lexists(self.enabled / "example.com.conf"))
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate()


if __name__ == "__main__":
    unittest.main()
