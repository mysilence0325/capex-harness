#!/usr/bin/env python3
"""Deploy the DSH multi-tenant stack to the VM.

Uploads the project to /opt/dsh-mt, seeds tenants, renders and starts the
stack, opens the firewall port, and prints the entry URL plus credentials.

Usage: python deploy.py [--tenants alpha,beta,gamma] [--skip-up]
"""

from __future__ import annotations

import argparse
import posixpath
import re
import sys

import vm

LOCAL_ROOT = "."
REMOTE_ROOT = "/opt/dsh-mt"

UPLOAD_FILES = [
    "README.md",
    ".env",
    "tenants.json",
    "gateway/server.js",
    "gateway/Dockerfile",
    "bin/render.js",
    "bin/registry.js",
    "bin/mt.sh",
    "bin/smoke.sh",
]

DEFAULT_TENANTS = [
    ("alpha", "alice", "Alpha 团队", 8091),
    ("beta", "bob", "Beta 团队", 8092),
    ("gamma", "carol", "Gamma 团队", 8093),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenants", default=",".join(t[0] for t in DEFAULT_TENANTS))
    parser.add_argument("--skip-up", action="store_true")
    parser.add_argument("--reset", action="store_true", help="remove the remote project directory first")
    args = parser.parse_args()

    wanted = [t.strip() for t in args.tenants.split(",") if t.strip()]
    plan = [t for t in DEFAULT_TENANTS if t[0] in wanted]

    client = vm.connect()
    try:
        print("==> preparing remote directory")
        if args.reset:
            run_or_fail(client, f"rm -rf {REMOTE_ROOT}")
        run_or_fail(client, f"mkdir -p {REMOTE_ROOT}/gateway {REMOTE_ROOT}/bin")

        print("==> uploading project files")
        for relative in UPLOAD_FILES:
            remote = posixpath.join(REMOTE_ROOT, relative)
            vm.run(client, f"mkdir -p {posixpath.dirname(remote)}")
            vm.sftp_put(client, f"{LOCAL_ROOT}/{relative}", remote)
        run_or_fail(client, f"chmod +x {REMOTE_ROOT}/bin/*.sh {REMOTE_ROOT}/bin/*.js")

        print("==> seeding tenants")
        credentials: list[tuple[str, str, str]] = []
        for tenant_id, user, title, edge_port in plan:
            output = capture(client, (
                f"cd {REMOTE_ROOT} && docker run --rm -v {REMOTE_ROOT}:/w -w /w node:22-bookworm-slim "
                f"node bin/registry.js add {tenant_id} --user {user} --title '{title}' --edge-port {edge_port}"
            ))
            match = re.search(r"password:\s*(\S+)", output)
            if match is None:
                print(output)
                print(f"!! could not seed tenant {tenant_id}", file=sys.stderr)
                return 1
            credentials.append((tenant_id, user, match.group(1)))
            print(f"    {tenant_id}: user={user} password={match.group(1)}")

        if args.skip_up:
            print("==> --skip-up: stopping before build/start")
            return 0

        print("==> rendering and starting the stack")
        status = vm.run(client, f"cd {REMOTE_ROOT} && bin/mt.sh up", timeout=900)
        if status != 0:
            vm.run(client, f"cd {REMOTE_ROOT} && docker-compose logs --tail=40")
            return status

        print("==> opening the firewall port")
        run_or_fail(client, "firewall-cmd --permanent --add-port=8090/tcp >/dev/null && firewall-cmd --reload >/dev/null", allow_failure=True)

        print("\n==> credentials")
        for tenant_id, user, password in credentials:
            print(f"    {tenant_id}: {user} / {password}")
    finally:
        client.close()
    return 0


def capture(client, command: str) -> str:
    _, stdout, stderr = client.exec_command(command, timeout=600)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    stdout.channel.recv_exit_status()
    return out + err


def run_or_fail(client, command: str, allow_failure: bool = False) -> None:
    status = vm.run(client, command)
    if status != 0 and not allow_failure:
        raise SystemExit(f"remote command failed ({status}): {command}")


if __name__ == "__main__":
    raise SystemExit(main())
