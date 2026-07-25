"""Outbound network restrictions for agent tools (§15.2).

Two guards, both fail-closed:

* :func:`check_url` refuses URLs that resolve to private/loopback/link-local
  address space, non-HTTP schemes, and hosts outside the workspace's
  ``networkAllowlist``. Resolution happens *before* the request, because a
  hostname the agent controls can point at ``169.254.169.254`` (cloud metadata)
  or at a service on the user's LAN — the classic SSRF shape.
* :func:`check_command` blocks shell commands that are really network clients
  (``curl``, ``wget``, ``nc``, an inline ``import socket``…), so the agent uses
  the audited ``fetch_url`` path instead of an unaudited subprocess.

Response handling limits (:data:`FETCH_TIMEOUT_SECONDS`,
:data:`MAX_RESPONSE_BYTES`) and header stripping
(:func:`strip_sensitive_headers`) live here too, so every caller gets the same
posture rather than re-deriving it.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from urllib.parse import urlparse

from zocai_gateway.security import log_security_event

__all__ = [
    "BLOCKED_COMMAND_PATTERNS",
    "FETCH_TIMEOUT_SECONDS",
    "MAX_RESPONSE_BYTES",
    "NETWORK_COMMAND_ERROR",
    "STRIPPED_RESPONSE_HEADERS",
    "CommandCheck",
    "UrlCheck",
    "check_command",
    "check_url",
    "is_private_address",
    "strip_sensitive_headers",
]

#: Hard timeout for a tool-initiated fetch (§15.2).
FETCH_TIMEOUT_SECONDS = 10.0

#: Maximum bytes read from a response body (§15.2: 1 MB).
MAX_RESPONSE_BYTES = 1024 * 1024

#: Response headers never handed back to the model (§15.2). ``Set-Cookie`` would
#: leak session state into the transcript; ``Authorization`` echoes a credential.
STRIPPED_RESPONSE_HEADERS = frozenset(
    {"set-cookie", "set-cookie2", "authorization", "proxy-authorization", "cookie"}
)

#: Only these schemes are ever fetched. ``file://`` would turn the network tool
#: into an unconstrained file reader, bypassing workspace confinement.
_ALLOWED_SCHEMES = frozenset({"http", "https"})

NETWORK_COMMAND_ERROR = "Network commands are restricted. Use the fetch_url tool instead."

#: Command shapes that are network clients in disguise (§15.2).
#:
#: Each binary is matched with a *token* boundary — no surrounding word,
#: dot, or dash character — rather than a whitespace boundary. That is what makes
#: quoting and path prefixes ineffective as evasion (``sh -c "curl …"``,
#: ``/usr/bin/curl``, ``$(curl …)`` all match) while ordinary words containing
#: the same letters do not (``curliness``, ``concurrency``, ``net_worker.py``).
_BOUNDARY = r"(?<![\w.-])"
_END = r"(?![\w.-])"


def _binary(name: str) -> re.Pattern[str]:
    return re.compile(_BOUNDARY + re.escape(name) + _END, re.IGNORECASE)


BLOCKED_COMMAND_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("curl", _binary("curl")),
    ("wget", _binary("wget")),
    ("nc", _binary("nc")),
    ("netcat", _binary("netcat")),
    ("socat", _binary("socat")),
    ("ssh", _binary("ssh")),
    ("scp", _binary("scp")),
    (
        # rsync is only blocked with a remote target (``host:path`` or ``://``);
        # a purely local rsync is a legitimate copy.
        "rsync",
        re.compile(
            _BOUNDARY + r"rsync" + _END + r"[^\n]*?(?:\S+@\S+:|\b[\w.-]+:[^\s/]|://)",
            re.IGNORECASE,
        ),
    ),
    (
        "python-socket",
        re.compile(
            r"python[0-9.]*\s+-c\b[^\n]*?(?:import\s+socket|socket\s*\.\s*socket"
            r"|urllib|requests|httpx)",
            re.IGNORECASE,
        ),
    ),
    (
        "node-net",
        re.compile(
            r"node\s+-e\b[^\n]*?require\s*\(\s*['\"]?(?:net|http|https|dgram|tls)",
            re.IGNORECASE,
        ),
    ),
)


@dataclass(frozen=True, slots=True)
class UrlCheck:
    """Outcome of validating a fetch target."""

    allowed: bool
    reason: str = ""
    #: True when the host is simply not allowlisted, so the caller should raise a
    #: ``decision_required`` rather than a hard refusal (§15.2).
    needs_approval: bool = False
    host: str = ""
    resolved: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class CommandCheck:
    """Outcome of screening a shell command."""

    allowed: bool
    reason: str = ""
    #: Which pattern matched, for the audit record.
    matched: str = ""


def is_private_address(address: str) -> bool:
    """Whether ``address`` is in non-public address space (§15.2).

    Covers the four ranges the spec names plus the ones that matter in practice
    and share the same risk: link-local (``169.254.0.0/16``, which is where cloud
    metadata services live), unique-local IPv6, and the IPv6 loopback.
    """
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    return bool(
        parsed.is_private
        or parsed.is_loopback
        or parsed.is_link_local
        or parsed.is_reserved
        or parsed.is_unspecified
        or parsed.is_multicast
    )


def _resolve(host: str) -> tuple[str, ...]:
    """All addresses ``host`` resolves to, or ``()`` when resolution fails."""
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError, OSError):
        return ()
    addresses = [str(info[4][0]) for info in infos]
    return tuple(dict.fromkeys(addresses))


def _host_allowed(host: str, allowlist: Iterable[str]) -> bool:
    """Whether ``host`` matches an allowlist entry.

    An entry matches the host itself or any subdomain of it, so
    ``example.com`` covers ``api.example.com`` without needing a wildcard
    syntax — but never ``notexample.com``.
    """
    target = host.lower().rstrip(".")
    for raw in allowlist:
        entry = str(raw).strip().lower().lstrip("*.").rstrip(".")
        if not entry:
            continue
        if target == entry or target.endswith(f".{entry}"):
            return True
    return False


def check_url(
    url: str,
    *,
    allowlist: Iterable[str] = (),
    enforce_allowlist: bool | None = None,
    run_id: str = "",
) -> UrlCheck:
    """Validate a fetch target against the §15.2 rules.

    Order matters: scheme, then address space, then allowlist. Address space is
    checked before the allowlist so an allowlisted hostname that resolves to a
    private address is still refused — otherwise the allowlist would become an
    SSRF bypass.
    """
    parsed = urlparse(url.strip())
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        reason = f"only http/https URLs may be fetched (got {parsed.scheme or 'none'!r})"
        log_security_event("network_blocked", reason, url=url, run_id=run_id or None)
        return UrlCheck(allowed=False, reason=reason)

    host = parsed.hostname or ""
    if not host:
        reason = "URL has no host"
        log_security_event("network_blocked", reason, url=url, run_id=run_id or None)
        return UrlCheck(allowed=False, reason=reason)

    # A literal private address needs no DNS lookup.
    candidates = (host,) if is_private_address(host) else _resolve(host)
    if any(is_private_address(address) for address in candidates):
        reason = (
            f"{host} resolves to a private or loopback address; "
            "fetching internal services is not permitted"
        )
        log_security_event(
            "network_blocked",
            reason,
            url=url,
            host=host,
            resolved=list(candidates),
            run_id=run_id or None,
        )
        return UrlCheck(allowed=False, reason=reason, host=host, resolved=candidates)

    entries = tuple(allowlist)
    should_enforce_allowlist = bool(entries) if enforce_allowlist is None else enforce_allowlist
    if should_enforce_allowlist and not _host_allowed(host, entries):
        reason = f"{host} is not in the workspace network allowlist"
        log_security_event(
            "network_not_allowlisted", reason, url=url, host=host, run_id=run_id or None
        )
        return UrlCheck(
            allowed=False, reason=reason, needs_approval=True, host=host, resolved=candidates
        )

    return UrlCheck(allowed=True, host=host, resolved=candidates)


def strip_sensitive_headers(headers: Mapping[str, str]) -> dict[str, str]:
    """Drop credential/session headers before returning a response (§15.2)."""
    return {
        key: value for key, value in headers.items() if key.lower() not in STRIPPED_RESPONSE_HEADERS
    }


def check_command(command: str, *, run_id: str = "") -> CommandCheck:
    """Screen a shell command for network clients (§15.2).

    Matching is done on the raw command string rather than on a parsed argv,
    because the shapes worth blocking hide inside quoted arguments
    (``sh -c "curl …"``, ``python -c 'import socket'``) that an argv-only check
    would miss.
    """
    text = command or ""
    for name, pattern in BLOCKED_COMMAND_PATTERNS:
        if pattern.search(text):
            log_security_event(
                "network_command_blocked",
                f"blocked network command ({name})",
                command=text[:400],
                run_id=run_id or None,
            )
            return CommandCheck(allowed=False, reason=NETWORK_COMMAND_ERROR, matched=name)
    return CommandCheck(allowed=True)
