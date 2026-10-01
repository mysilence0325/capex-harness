#!/usr/bin/env python3
"""SSH driver for the DSH multi-tenant deployment VM.

Usage:
  python vm.py run "<shell command>"      run a command through bash -lc
  python vm.py script <local.sh>          upload and run a local bash script
  python vm.py put <local> <remote>       upload one file
  python vm.py get <remote> <local>       download one file

Connection facts come from the environment: VM_HOST and VM_PASS are required,
VM_USER defaults to root. No host or password is stored in this file.

Usage:
  $env:VM_HOST = '10.0.0.5'; $env:VM_PASS = '...'
  python vm.py run "docker ps"
"""

from __future__ import annotations

import os
import posixpath
import sys
import uuid

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_local_env() -> None:
    """Load KEY=VALUE lines from ./local.env beside this script.

    The file is gitignored and holds this operator's connection facts, so no
    host or password lives in the tracked source. Real environment variables
    always win.
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "local.env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if stripped == "" or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


load_local_env()

HOST = os.environ["VM_HOST"]
USER = os.environ.get("VM_USER", "root")
PASSWORD = os.environ["VM_PASS"]


def connect() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        HOST,
        username=USER,
        password=PASSWORD,
        timeout=30,
        banner_timeout=30,
        auth_timeout=30,
    )
    return client


def run(client: paramiko.SSHClient, command: str, timeout: float | None = None) -> int:
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    status = stdout.channel.recv_exit_status()
    if out:
        sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    return status


def sftp_put(client: paramiko.SSHClient, local: str, remote: str) -> None:
    with client.open_sftp() as sftp:
        sftp.put(local, remote)


def sftp_get(client: paramiko.SSHClient, remote: str, local: str) -> None:
    with client.open_sftp() as sftp:
        sftp.get(remote, local)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        sys.stderr.write(__doc__ or "")
        return 2
    action = argv[1]
    client = connect()
    try:
        if action == "run":
            return run(client, f"bash -lc {shell_quote(argv[2])}")
        if action == "script":
            local = argv[2]
            remote = f"/tmp/dsh-{uuid.uuid4().hex[:8]}.sh"
            sftp_put(client, local, remote)
            return run(client, f"bash -lc {shell_quote(f'bash {remote}')}")
        if action == "put":
            remote = argv[3]
            run(client, f"mkdir -p {shell_quote(posixpath.dirname(remote))}")
            sftp_put(client, argv[2], remote)
            return 0
        if action == "get":
            sftp_get(client, argv[2], argv[3])
            return 0
    finally:
        client.close()
    sys.stderr.write(f"unknown action: {action}\n")
    return 2


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
