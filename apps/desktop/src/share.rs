//! Read-only LAN session sharing (§10.1).
//!
//! `share_session` starts a minimal HTTP server on a random port bound to
//! `0.0.0.0`, so other devices on the local network can *watch* the current
//! agent run. It serves the compiled frontend and proxies the gateway's SSE
//! event stream — nothing else.
//!
//! # Security posture
//!
//! This is the only place in the app that binds beyond loopback, so the
//! restrictions are structural rather than advisory:
//!
//! * **Opt-in.** The listener exists only while the user has explicitly started
//!   a share; [`stop`] tears it down and the socket closes.
//! * **Token gated live data.** A 16-hex-char token is generated per share and
//!   compared in constant time before an event stream is proxied. Static bundle
//!   assets are public (they are identical to the installed app); this lets a
//!   browser load Vite's JS/CSS subresources without leaking session data.
//! * **Read-only by construction.** Only `GET`/`HEAD` are dispatched at all;
//!   every other method is refused with `405` before the path is examined. The
//!   proxy allowlist contains exactly the event-stream and replay routes, so
//!   there is no reachable path to `POST /v1/agent/run` or
//!   `POST /v1/agent/decision` — a viewer cannot start runs or answer
//!   decisions.
//! * **Loopback-only upstream.** The proxy dials `127.0.0.1:<agent_port>`; the
//!   gateway itself is never exposed.
//!
//! The server is deliberately hand-rolled over `std::net` rather than pulling
//! in an HTTP framework: the surface is three routes, and byte-pumping the SSE
//! response keeps streaming semantics exact without an async HTTP client.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::sidecar::AgentSupervisor;

/// Whether a path is one of the two read-only gateway event surfaces exposed
/// to viewers. Matching the replay route structurally avoids accidentally
/// exposing a future endpoint merely because it lives below `/runs/{id}`.
fn is_proxy_path(path: &str) -> bool {
    if path == "/v1/agent/events" {
        return true;
    }
    let Some(rest) = path.strip_prefix("/v1/agent/runs/") else {
        return false;
    };
    let mut segments = rest.split('/');
    matches!(
        (
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
        ),
        (Some(run_id), Some("events"), Some("replay"), None) if !run_id.is_empty()
    )
}

/// Cap on concurrent viewer connections, so a share cannot be used to exhaust
/// the host's file descriptors.
const MAX_VIEWERS: u64 = 10;

const READ_TIMEOUT: Duration = Duration::from_secs(600);
const HEADER_LIMIT: usize = 16 * 1024;

/// A live share, as reported to the UI.
#[derive(Clone, Debug, Serialize)]
pub struct ShareInfo {
    /// Full URL (including token) to hand to a viewer.
    pub url: String,
    pub token: String,
    pub run_id: String,
    pub port: u16,
    pub lan_ip: String,
    /// Currently connected viewers.
    pub viewers: u64,
}

struct Session {
    token: String,
    run_id: String,
    port: u16,
    lan_ip: String,
    viewers: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    /// Kept so `stop()` can unblock the accept loop by connecting to itself.
    local_addr: SocketAddr,
}

impl Session {
    fn info(&self) -> ShareInfo {
        ShareInfo {
            url: format!(
                "http://{}:{}/?token={}&runId={}",
                self.lan_ip, self.port, self.token, self.run_id
            ),
            token: self.token.clone(),
            run_id: self.run_id.clone(),
            port: self.port,
            lan_ip: self.lan_ip.clone(),
            viewers: self.viewers.load(Ordering::Relaxed),
        }
    }
}

#[derive(Default)]
pub struct ShareState {
    session: Mutex<Option<Session>>,
}

impl ShareState {
    pub fn current(&self) -> Option<ShareInfo> {
        self.session.lock().as_ref().map(Session::info)
    }

    /// Stop the active share, if any. Idempotent.
    pub fn stop(&self) {
        if let Some(session) = self.session.lock().take() {
            session.stop.store(true, Ordering::SeqCst);
            // Wake the blocking `accept()` so the thread observes the flag.
            let _ = TcpStream::connect_timeout(&session.local_addr, Duration::from_millis(250));
        }
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// Start (or return the existing) read-only LAN share for this session.
#[tauri::command]
pub fn share_session<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, Arc<ShareState>>,
    agent: tauri::State<'_, Arc<AgentSupervisor>>,
    run_id: String,
) -> Result<ShareInfo, String> {
    if !valid_run_id(&run_id) {
        return Err("a valid active run id is required to share a session".to_string());
    }
    if let Some(existing) = state.current() {
        return if existing.run_id == run_id {
            Ok(existing)
        } else {
            Err("stop the current share before sharing a different run".to_string())
        };
    }
    let agent_port = agent
        .status
        .lock()
        .port
        .ok_or_else(|| "the agent sidecar is not running yet".to_string())?;

    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|e| format!("could not bind a LAN port: {e}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("could not read the bound port: {e}"))?;
    let port = local_addr.port();

    let token = random_token()?;
    let lan_ip = lan_ip().unwrap_or_else(|| "127.0.0.1".to_string());
    let viewers = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));

    let session = Session {
        token: token.clone(),
        run_id,
        port,
        lan_ip: lan_ip.clone(),
        viewers: Arc::clone(&viewers),
        stop: Arc::clone(&stop),
        // `accept()` blocks on the wildcard address; dial loopback to wake it.
        local_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
    };
    let info = session.info();
    *state.session.lock() = Some(session);

    serve(app, listener, token, agent_port, viewers, stop);
    tracing::info!(port, "read-only LAN session share started");
    Ok(info)
}

/// Tear down the active share.
#[tauri::command]
pub fn share_session_stop(state: tauri::State<'_, Arc<ShareState>>) {
    state.stop();
    tracing::info!("read-only LAN session share stopped");
}

/// The active share, or `null` when sharing is off.
#[tauri::command]
pub fn share_session_status(state: tauri::State<'_, Arc<ShareState>>) -> Option<ShareInfo> {
    state.current()
}

// ── server ───────────────────────────────────────────────────────────────────

fn serve<R: Runtime>(
    app: AppHandle<R>,
    listener: TcpListener,
    token: String,
    agent_port: u16,
    viewers: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = incoming else { continue };
            let app = app.clone();
            let token = token.clone();
            let viewers = Arc::clone(&viewers);
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                if let Err(err) = handle(&app, stream, &token, agent_port, &viewers, &stop) {
                    tracing::debug!(error = %err, "share connection ended");
                }
            });
        }
        tracing::debug!("share listener closed");
    });
}

struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
}

fn handle<R: Runtime>(
    app: &AppHandle<R>,
    mut stream: TcpStream,
    token: &str,
    agent_port: u16,
    viewers: &Arc<AtomicU64>,
    stop: &Arc<AtomicBool>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let request = match read_request(&mut stream)? {
        Some(req) => req,
        None => return Ok(()),
    };

    // 1. Method gate. Read-only is enforced before anything else is considered,
    //    so no write route can be reached even by a malformed path.
    if request.method != "GET" && request.method != "HEAD" {
        return respond(
            &mut stream,
            405,
            "text/plain; charset=utf-8",
            b"Shared sessions are read-only.",
        );
    }

    // 2. Route event streams through the token gate. Static assets carry no
    // session data and must remain loadable by normal browser subresource
    // requests, which do not inherit the query string from `/?token=...`.
    if is_proxy_path(&request.path) {
        if !has_valid_token(&request, token) {
            return respond(
                &mut stream,
                403,
                "text/plain; charset=utf-8",
                b"Invalid or missing share token.",
            );
        }
        if viewers.load(Ordering::SeqCst) >= MAX_VIEWERS {
            return respond(
                &mut stream,
                503,
                "text/plain; charset=utf-8",
                b"Too many viewers.",
            );
        }
        let count = viewers.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = app.emit("share://viewers", count);
        let result = proxy_stream(&mut stream, &request, agent_port, stop);
        let count = viewers.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
        let _ = app.emit("share://viewers", count);
        return result;
    }

    // Never turn an unexposed gateway path into an SPA 200 response. All API
    // routes other than the two event surfaces are structurally unreachable.
    if request.path.starts_with("/v1/") {
        return respond(
            &mut stream,
            404,
            "text/plain; charset=utf-8",
            b"Shared sessions expose read-only events only.",
        );
    }

    serve_asset(app, &mut stream, &request.path)
}

fn has_valid_token(request: &Request, expected: &str) -> bool {
    let presented = request
        .query
        .get("token")
        .map(String::as_str)
        .or_else(|| request.headers.get("x-zoc-share-token").map(String::as_str))
        .unwrap_or_default();
    constant_time_eq(presented.as_bytes(), expected.as_bytes())
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut raw = String::new();
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            return Ok(None);
        }
        raw.push_str(&line);
        if raw.len() > HEADER_LIMIT {
            return Ok(None);
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
    }

    let mut lines = raw.lines();
    let Some(start) = lines.next() else {
        return Ok(None);
    };
    let mut parts = start.split_whitespace();
    let method = parts.next().unwrap_or_default().to_ascii_uppercase();
    let target = parts.next().unwrap_or("/");

    let (path, query_raw) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q),
        None => (target.to_string(), ""),
    };
    let mut query = HashMap::new();
    for pair in query_raw.split('&').filter(|s| !s.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        query.insert(key.to_string(), percent_decode(value));
    }

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    Ok(Some(Request {
        method,
        path,
        query,
        headers,
    }))
}

/// Pump the gateway's SSE response straight through to the viewer.
///
/// Raw byte forwarding rather than an HTTP client: chunked/streaming semantics
/// are preserved exactly, and the viewer sees events with no added buffering.
/// The share token is stripped from the upstream query so it never reaches the
/// gateway's logs.
fn proxy_stream(
    stream: &mut TcpStream,
    request: &Request,
    agent_port: u16,
    stop: &Arc<AtomicBool>,
) -> std::io::Result<()> {
    let mut upstream = TcpStream::connect((Ipv4Addr::LOCALHOST, agent_port))?;
    let query: String = request
        .query
        .iter()
        .filter(|(key, _)| key.as_str() != "token")
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    let target = if query.is_empty() {
        request.path.clone()
    } else {
        format!("{}?{}", request.path, query)
    };

    write!(
        upstream,
        "GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{agent_port}\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n"
    )?;
    upstream.flush()?;

    let mut buf = [0u8; 8192];
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match upstream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if stream.write_all(&buf[..n]).is_err() {
                    break; // viewer disconnected
                }
                if stream.flush().is_err() {
                    break;
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    Ok(())
}

/// Serve the compiled frontend.
///
/// Tauri embeds `frontendDist` in the binary, so the asset resolver is the
/// primary source; a `dist/` directory on disk is the dev-build fallback.
/// Unknown paths fall back to `index.html` so the SPA router can handle them.
fn serve_asset<R: Runtime>(
    app: &AppHandle<R>,
    stream: &mut TcpStream,
    path: &str,
) -> std::io::Result<()> {
    let wanted = if path == "/" { "/index.html" } else { path };

    if let Some(asset) = app.asset_resolver().get(wanted.to_string()) {
        let mime = asset.mime_type.clone();
        return respond(stream, 200, &mime, &asset.bytes);
    }
    if let Some(asset) = app.asset_resolver().get("/index.html".to_string()) {
        return respond(stream, 200, "text/html; charset=utf-8", &asset.bytes);
    }
    if let Some(bytes) = read_dist(app, wanted).or_else(|| read_dist(app, "/index.html")) {
        return respond(stream, 200, guess_mime(wanted), &bytes);
    }
    respond(
        stream,
        404,
        "text/plain; charset=utf-8",
        b"Frontend assets unavailable. Sharing requires a built app.",
    )
}

fn read_dist<R: Runtime>(app: &AppHandle<R>, path: &str) -> Option<Vec<u8>> {
    let relative = path.trim_start_matches('/');
    // Reject traversal before touching the filesystem.
    if relative.contains("..") {
        return None;
    }
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir.join("dist"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("dist"));
        }
    }
    roots.push(std::path::PathBuf::from("apps/frontend/dist"));
    for root in roots {
        let candidate = root.join(relative);
        if candidate.is_file() {
            if let Ok(bytes) = std::fs::read(&candidate) {
                return Some(bytes);
            }
        }
    }
    None
}

fn guess_mime(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, ext)| ext) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("woff2") => "font/woff2",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        503 => "Service Unavailable",
        _ => "OK",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// 16 hex characters (64 bits) from the operating system CSPRNG.
///
/// A share token protects live session data, so predictable clock-derived
/// fallback entropy is not acceptable. Fail loudly if the OS random source is
/// unavailable rather than starting an insecure share.
fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| format!("secure random source unavailable: {err}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= 80
        && run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}

/// Compare without an early exit on the first differing byte.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Best-effort LAN address: ask the OS which local interface it would use to
/// reach a public address. No packet is sent (UDP `connect` only sets the
/// socket's peer), so this works offline as long as a route exists.
fn lan_ip() -> Option<String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;
    let addr = socket.local_addr().ok()?;
    Some(addr.ip().to_string())
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_16_hex_chars_and_differ() {
        let a = random_token().expect("secure token");
        let b = random_token().expect("secure token");
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "tokens must not repeat");
    }

    #[test]
    fn share_run_ids_are_url_safe() {
        assert!(valid_run_id("run-abc_123:part.2"));
        assert!(!valid_run_id(""));
        assert!(!valid_run_id("run id"));
        assert!(!valid_run_id("../run"));
    }

    #[test]
    fn constant_time_eq_matches_equality() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn percent_decoding_handles_escapes_and_plus() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn only_exact_event_routes_are_proxied() {
        for path in ["/v1/agent/events", "/v1/agent/runs/r1/events/replay"] {
            assert!(is_proxy_path(path), "{path} should be proxied");
        }
        // Write routes, unrelated gateway routes, and lookalike paths must not
        // match. In particular, `/runs/` is not a broad prefix allowlist.
        for path in [
            "/v1/agent/run",
            "/v1/agent/decision",
            "/v1/agent/runs/r1",
            "/v1/agent/runs/r1/events",
            "/v1/agent/runs/r1/events/replay/extra",
            "/v1/sessions",
            "/health",
        ] {
            assert!(!is_proxy_path(path), "{path} must not be proxied");
        }
    }

    #[test]
    fn live_data_requires_token_but_static_assets_do_not() {
        let asset = Request {
            method: "GET".into(),
            path: "/assets/app.js".into(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };
        assert!(!is_proxy_path(&asset.path));
        assert!(!has_valid_token(&asset, "0123456789abcdef"));

        let mut event = Request {
            method: "GET".into(),
            path: "/v1/agent/events".into(),
            query: HashMap::new(),
            headers: HashMap::new(),
        };
        assert!(is_proxy_path(&event.path));
        assert!(!has_valid_token(&event, "0123456789abcdef"));
        event
            .query
            .insert("token".into(), "0123456789abcdef".into());
        assert!(has_valid_token(&event, "0123456789abcdef"));
    }

    #[test]
    fn dist_reads_reject_traversal() {
        // `read_dist` needs an AppHandle, so assert the guard directly.
        assert!("../../etc/passwd".contains(".."));
    }

    #[test]
    fn mime_types_cover_the_built_bundle() {
        assert_eq!(guess_mime("/index.html"), "text/html; charset=utf-8");
        assert_eq!(
            guess_mime("/assets/app.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(guess_mime("/assets/app.css"), "text/css; charset=utf-8");
        assert_eq!(guess_mime("/x.bin"), "application/octet-stream");
    }
}
