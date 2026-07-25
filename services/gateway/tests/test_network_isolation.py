"""Tests for outbound network restrictions (§15.2)."""

from __future__ import annotations

from pathlib import Path

import pytest
from zocai_gateway.net_guard import (
    FETCH_TIMEOUT_SECONDS,
    MAX_RESPONSE_BYTES,
    NETWORK_COMMAND_ERROR,
    check_command,
    check_url,
    is_private_address,
    strip_sensitive_headers,
)
from zocai_gateway.react import TOOL_SPECS
from zocai_gateway.toolsets import FullToolset


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ZOC_STUDIO_HOME", str(tmp_path))


# ── private address detection ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "address",
    [
        "10.0.0.1",  # 10.0.0.0/8
        "10.255.255.254",
        "172.16.0.1",  # 172.16.0.0/12
        "172.31.255.254",
        "192.168.1.1",  # 192.168.0.0/16
        "127.0.0.1",  # 127.0.0.0/8
        "127.1.2.3",
        "169.254.169.254",  # cloud metadata
        "::1",  # IPv6 loopback
        "fd00::1",  # IPv6 unique-local
        "0.0.0.0",
    ],
)
def test_private_ranges_are_recognised(address: str) -> None:
    assert is_private_address(address) is True


@pytest.mark.parametrize("address", ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"])
def test_public_addresses_are_allowed(address: str) -> None:
    assert is_private_address(address) is False


def test_non_addresses_are_not_treated_as_private() -> None:
    assert is_private_address("example.com") is False
    assert is_private_address("") is False


# ── URL screening ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "http://10.0.0.5/admin",
        "http://127.0.0.1:8080/health",
        "https://192.168.1.10/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]:9000/",
    ],
)
def test_private_targets_are_refused(url: str) -> None:
    verdict = check_url(url)
    assert verdict.allowed is False
    assert "private or loopback" in verdict.reason
    # A hard refusal, not something to prompt the user about.
    assert verdict.needs_approval is False


@pytest.mark.parametrize(
    "url", ["file:///etc/passwd", "ftp://example.com/x", "gopher://x", "notaurl"]
)
def test_non_http_schemes_are_refused(url: str) -> None:
    verdict = check_url(url)
    assert verdict.allowed is False
    assert verdict.needs_approval is False


def test_missing_host_is_refused() -> None:
    assert check_url("http:///path").allowed is False


def test_allowlisted_public_host_is_permitted() -> None:
    verdict = check_url("https://example.com/docs", allowlist=["example.com"])
    assert verdict.allowed is True
    assert verdict.host == "example.com"


def test_subdomains_of_an_allowlisted_host_are_permitted() -> None:
    assert check_url("https://api.example.com/v1", allowlist=["example.com"]).allowed is True


def test_lookalike_domain_is_not_allowlisted() -> None:
    verdict = check_url("https://notexample.com/", allowlist=["example.com"])
    assert verdict.allowed is False
    assert verdict.needs_approval is True


def test_non_allowlisted_host_asks_for_approval_rather_than_failing() -> None:
    verdict = check_url("https://example.org/", allowlist=["example.com"])
    assert verdict.allowed is False
    assert verdict.needs_approval is True
    assert "allowlist" in verdict.reason


def test_empty_allowlist_means_unrestricted_public_access() -> None:
    # With no allowlist configured the address-space rule is still the gate.
    assert check_url("https://example.com/", allowlist=[]).allowed is True


def test_allowlist_cannot_whitelist_a_private_target() -> None:
    """An allowlisted name that resolves privately must still be refused.

    Otherwise the allowlist would become an SSRF bypass.
    """
    verdict = check_url("http://127.0.0.1/", allowlist=["127.0.0.1"])
    assert verdict.allowed is False
    assert "private or loopback" in verdict.reason


# ── header stripping + limits ─────────────────────────────────────────────────


def test_credential_and_session_headers_are_stripped() -> None:
    cleaned = strip_sensitive_headers(
        {
            "Content-Type": "text/html",
            "Set-Cookie": "session=abc",
            "Authorization": "Bearer token",
            "X-Custom": "keep me",
        }
    )
    assert cleaned == {"Content-Type": "text/html", "X-Custom": "keep me"}


def test_limits_match_the_documented_values() -> None:
    assert FETCH_TIMEOUT_SECONDS == 10.0
    assert MAX_RESPONSE_BYTES == 1024 * 1024


# ── command screening ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "command",
    [
        "curl https://example.com",
        "/usr/bin/curl -s https://example.com",
        "wget http://example.com/file",
        "nc -l 4444",
        "netcat example.com 80",
        "socat TCP-LISTEN:8080 -",
        "ssh user@host 'ls'",
        "scp file user@host:/tmp/",
        "rsync -a ./src user@host:/backup/",
        "rsync -a ./src rsync://host/mod",
        "python -c 'import socket; socket.socket()'",
        'python3 -c "import urllib.request"',
        "node -e 'require(\"net\").connect(80)'",
        'sh -c "curl https://example.com"',
        "echo hi; curl https://example.com",
        "echo hi && wget http://x",
    ],
)
def test_network_commands_are_blocked(command: str) -> None:
    verdict = check_command(command)
    assert verdict.allowed is False
    assert verdict.reason == NETWORK_COMMAND_ERROR


@pytest.mark.parametrize(
    "command",
    [
        "pytest -q",
        "npm run build",
        "cargo test --workspace",
        "git status",
        "rsync -a ./src ./dest",  # purely local copy
        "python -c 'print(1 + 1)'",
        "node -e 'console.log(1)'",
        "cat src/net_worker.py",  # 'nc' inside a word must not match
        "ls concurrency/",
        "grep -r curliness .",  # 'curl' inside a word
    ],
)
def test_ordinary_commands_are_allowed(command: str) -> None:
    assert check_command(command).allowed is True


def test_empty_command_is_allowed() -> None:
    assert check_command("").allowed is True


# ── toolset integration ──────────────────────────────────────────────────────


def test_run_shell_refuses_a_network_command_without_spawning(tmp_path: Path) -> None:
    toolset = FullToolset(tmp_path)

    completed = toolset.run_shell(["curl", "https://example.com"])

    assert completed.returncode == 126
    assert completed.stderr == NETWORK_COMMAND_ERROR
    assert completed.stdout == ""


def test_run_shell_still_runs_ordinary_commands(tmp_path: Path) -> None:
    toolset = FullToolset(tmp_path)
    completed = toolset.run_shell(["echo", "hello"])
    assert completed.returncode == 0
    assert "hello" in completed.stdout


def test_fetch_url_refuses_a_private_target_without_a_request(tmp_path: Path) -> None:
    result = FullToolset(tmp_path).fetch_url("http://127.0.0.1:9/")
    assert result.ok is False
    assert "private or loopback" in result.error
    assert result.body == ""


def test_fetch_url_flags_a_non_allowlisted_host_for_approval(tmp_path: Path) -> None:
    result = FullToolset(tmp_path).fetch_url("https://example.org/", allowlist=["example.com"])
    assert result.ok is False
    assert result.needs_approval is True


def test_fetch_url_refuses_file_scheme(tmp_path: Path) -> None:
    result = FullToolset(tmp_path).fetch_url("file:///etc/passwd")
    assert result.ok is False
    assert result.needs_approval is False


def test_read_only_toolset_has_no_network_access() -> None:
    from zocai_gateway.toolsets import ReadOnlyToolset

    # Capability-gated, not runtime-checked: the method simply does not exist.
    assert not hasattr(ReadOnlyToolset("."), "fetch_url")
    assert not hasattr(ReadOnlyToolset("."), "run_shell")


def test_enforced_empty_allowlist_requires_approval() -> None:
    verdict = check_url(
        "https://example.com/",
        allowlist=(),
        enforce_allowlist=True,
    )
    assert verdict.allowed is False
    assert verdict.needs_approval is True


def test_full_toolset_enforces_configured_empty_allowlist(tmp_path: Path) -> None:
    result = FullToolset(tmp_path, network_allowlist=()).fetch_url("https://example.com/")
    assert result.ok is False
    assert result.needs_approval is True


def test_react_exposes_fetch_url_as_the_only_native_network_tool() -> None:
    names = {spec.name for spec in TOOL_SPECS}
    assert "fetch_url" in names
    assert names.isdisjoint({"curl", "wget", "ssh", "netcat"})
