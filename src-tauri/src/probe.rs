//! Surface liveness probe.
//!
//! The webview can't tell a dead port from a live one: an iframe pointed at a
//! closed port just shows the engine's own error page, and fetch() to another
//! origin is blocked by CORS. So the shell asks Rust instead. Rust opens a plain
//! TCP connection, sends one HTTP/1.0 GET, and reports a machine-readable reason.
//! The frontend (`src/probe.js`) turns that reason into "what failed, why, and
//! what to do next".
//!
//! Loopback only. The shell probes local dashboards, never the LAN or the
//! internet, so a URL whose host isn't 127.0.0.1 / localhost / [::1] is refused
//! before any socket is opened. That keeps the command from being usable as a
//! network scanner.

use serde::{Deserialize, Serialize};
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

/// Largest response we read. Headers plus a small health JSON fit easily.
const MAX_READ: usize = 64 * 1024;

/// What the frontend asks to be probed. Mirrors a surface entry in fleet.json.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeTarget {
    /// Fixed base URL, e.g. `http://127.0.0.1:8765`. Either this or `port_file`.
    pub url: Option<String>,
    /// File the service writes its bound port into, e.g. `~/.sovereign/dashboard.port`.
    pub port_file: Option<String>,
    /// Optional health path checked before the frame URL, e.g. `/api/health`.
    pub health_path: Option<String>,
    /// When true, the health response must be JSON with `"ok": true`.
    #[serde(default)]
    pub expect_ok_json: bool,
    /// Per-request timeout. Clamped to 100..=10_000 ms.
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeState {
    /// Answered and can be framed.
    Up,
    /// Nothing is listening (or the port file says nothing is running).
    Down,
    /// Something answered, but it isn't the service this surface expects.
    WrongService,
    /// The service answered but forbids being shown inside the shell.
    Blocked,
    /// The service answered with an error, or the probe itself failed.
    Error,
    /// The fleet.json entry itself is unusable.
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub state: ProbeState,
    /// Stable code the frontend maps to copy (e.g. `refused`, `http-426`).
    pub reason: String,
    /// Raw detail for the "what failed" line: OS error text, header value, etc.
    pub detail: String,
    /// The base URL that was probed (resolved from the port file when used).
    pub url: Option<String>,
    pub http_status: Option<u16>,
}

impl ProbeResult {
    fn new(state: ProbeState, reason: &str, detail: impl Into<String>, url: Option<&str>) -> Self {
        ProbeResult {
            state,
            reason: reason.to_string(),
            detail: detail.into(),
            url: url.map(str::to_string),
            http_status: None,
        }
    }
    fn with_status(mut self, status: u16) -> Self {
        self.http_status = Some(status);
        self
    }
}

/// A parsed `http://host:port/path` URL, loopback hosts only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackUrl {
    pub host: String,
    pub addr: SocketAddr,
    pub path: String,
}

/// Parse a loopback http URL. Returns the failure reason code on error.
pub fn parse_loopback_url(url: &str) -> Result<LoopbackUrl, (&'static str, String)> {
    let rest = url.strip_prefix("http://").ok_or((
        "bad-url",
        format!("only http:// loopback URLs are probed, got {url:?}"),
    ))?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.contains('@') {
        return Err((
            "bad-url",
            format!("credentials in URL are not allowed: {url:?}"),
        ));
    }
    let (host, port_str) = if let Some(v6) = authority.strip_prefix('[') {
        let end = v6
            .find(']')
            .ok_or(("bad-url", format!("unterminated IPv6 host in {url:?}")))?;
        let host = &v6[..end];
        let after = &v6[end + 1..];
        (host, after.strip_prefix(':'))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    let ip: IpAddr = match host.to_ascii_lowercase().as_str() {
        "localhost" | "127.0.0.1" => IpAddr::V4(Ipv4Addr::LOCALHOST),
        "::1" => IpAddr::V6(Ipv6Addr::LOCALHOST),
        other => {
            return Err((
                "not-loopback",
                format!("host {other:?} is not loopback; the shell only probes this machine"),
            ))
        }
    };
    let port: u16 = match port_str {
        None => 80,
        Some(p) => match p.parse::<u16>() {
            Ok(n) if n > 0 => n,
            _ => return Err(("bad-url", format!("invalid port {p:?} in {url:?}"))),
        },
    };
    Ok(LoopbackUrl {
        host: authority.to_string(),
        addr: SocketAddr::new(ip, port),
        path: if path.is_empty() {
            "/".into()
        } else {
            path.to_string()
        },
    })
}

/// Expand a leading `~/` to the user's home directory.
pub fn expand_home(path: &str, home: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(rest) = path.strip_prefix("~/") {
        let home =
            home.ok_or_else(|| "no home directory (HOME / USERPROFILE unset)".to_string())?;
        Ok(home.join(rest))
    } else {
        Ok(PathBuf::from(path))
    }
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Read a port file. Err is a ready-made `Down`/`Invalid` result.
pub fn read_port_file(path: &str, home: Option<PathBuf>) -> Result<u16, ProbeResult> {
    let full = expand_home(path, home)
        .map_err(|e| ProbeResult::new(ProbeState::Invalid, "port-file-path", e, None))?;
    let shown = full.display().to_string();
    let text = std::fs::read_to_string(&full).map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            ProbeResult::new(ProbeState::Down, "port-file-missing", shown.clone(), None)
        } else {
            ProbeResult::new(
                ProbeState::Error,
                "port-file-unreadable",
                format!("{shown}: {e}"),
                None,
            )
        }
    })?;
    match text.trim().parse::<u16>() {
        Ok(p) if p > 0 => Ok(p),
        _ => Err(ProbeResult::new(
            ProbeState::Error,
            "port-file-invalid",
            format!("{shown} contains {:?}, expected a port number", text.trim()),
            None,
        )),
    }
}

/// One raw HTTP response: status code, lower-cased headers, body bytes.
#[derive(Debug)]
struct RawResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl RawResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Send one GET and read the reply. Err is a ready-made result.
fn http_get(
    target: &LoopbackUrl,
    base: &str,
    timeout: Duration,
) -> Result<RawResponse, ProbeResult> {
    let mut stream = TcpStream::connect_timeout(&target.addr, timeout).map_err(|e| {
        let reason = match e.kind() {
            ErrorKind::ConnectionRefused => "refused",
            ErrorKind::TimedOut | ErrorKind::WouldBlock => "timeout",
            _ => "connect-failed",
        };
        let state = if reason == "connect-failed" {
            ProbeState::Error
        } else {
            ProbeState::Down
        };
        ProbeResult::new(state, reason, format!("{}: {e}", target.addr), Some(base))
    })?;
    let io_err = |e: std::io::Error| {
        ProbeResult::new(
            ProbeState::Error,
            "io-error",
            format!("{}: {e}", target.addr),
            Some(base),
        )
    };
    stream.set_read_timeout(Some(timeout)).map_err(io_err)?;
    stream.set_write_timeout(Some(timeout)).map_err(io_err)?;
    let req = format!(
        "GET {} HTTP/1.0\r\nHost: {}\r\nUser-Agent: BlackLabel-fleet-shell\r\nAccept: */*\r\nConnection: close\r\n\r\n",
        target.path, target.host
    );
    stream.write_all(req.as_bytes()).map_err(io_err)?;

    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() >= MAX_READ {
                    break;
                }
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                if buf.is_empty() {
                    return Err(ProbeResult::new(
                        ProbeState::WrongService,
                        "no-response",
                        format!(
                            "{} accepted the connection but sent nothing within {} ms",
                            target.addr,
                            timeout.as_millis()
                        ),
                        Some(base),
                    ));
                }
                break;
            }
            Err(e) if e.kind() == ErrorKind::ConnectionReset && !buf.is_empty() => break,
            Err(e) => return Err(io_err(e)),
        }
    }
    parse_response(&buf).ok_or_else(|| {
        let head: String = String::from_utf8_lossy(&buf[..buf.len().min(60)]).into();
        ProbeResult::new(
            ProbeState::WrongService,
            "not-http",
            format!("{} answered with non-HTTP data: {head:?}", target.addr),
            Some(base),
        )
    })
}

fn parse_response(buf: &[u8]) -> Option<RawResponse> {
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n");
    let (head, body) = match split {
        Some(i) => (&buf[..i], buf[i + 4..].to_vec()),
        None => (buf, Vec::new()),
    };
    let head = std::str::from_utf8(head).ok()?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next()?;
    let mut parts = status_line.splitn(3, ' ');
    let proto = parts.next()?;
    if !proto.starts_with("HTTP/") {
        return None;
    }
    let status = parts.next()?.parse::<u16>().ok()?;
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Some(RawResponse {
        status,
        headers,
        body,
    })
}

/// Would this response refuse to render inside the shell's iframe?
/// Returns the reason code and the header that says so.
fn frame_refusal(resp: &RawResponse) -> Option<(&'static str, String)> {
    if let Some(xfo) = resp.header("x-frame-options") {
        let v = xfo.to_ascii_lowercase();
        if v.contains("deny") || v.contains("sameorigin") {
            return Some(("frame-denied", format!("X-Frame-Options: {xfo}")));
        }
    }
    if let Some(csp) = resp.header("content-security-policy") {
        for directive in csp.split(';') {
            let d = directive.trim();
            if let Some(sources) = d.strip_prefix("frame-ancestors") {
                if !sources.split_whitespace().any(|s| s == "*") {
                    return Some(("frame-ancestors", format!("Content-Security-Policy: {d}")));
                }
            }
        }
    }
    None
}

fn classify_status(status: u16, base: &str, what: &str) -> Option<ProbeResult> {
    match status {
        200..=399 => None,
        426 => Some(
            ProbeResult::new(
                ProbeState::WrongService,
                "http-426",
                format!(
                    "{what} answered 426 Upgrade Required (a WebSocket server, not a dashboard)"
                ),
                Some(base),
            )
            .with_status(status),
        ),
        500..=599 => Some(
            ProbeResult::new(
                ProbeState::Error,
                "http-5xx",
                format!("{what} answered HTTP {status}"),
                Some(base),
            )
            .with_status(status),
        ),
        _ => Some(
            ProbeResult::new(
                ProbeState::Error,
                "http-status",
                format!("{what} answered HTTP {status}"),
                Some(base),
            )
            .with_status(status),
        ),
    }
}

/// Probe a target synchronously. Never panics; every failure is a result.
pub fn probe_blocking(target: &ProbeTarget, home: Option<PathBuf>) -> ProbeResult {
    let timeout = Duration::from_millis(target.timeout_ms.unwrap_or(1500).clamp(100, 10_000));

    let base: String = match (&target.url, &target.port_file) {
        (Some(u), None) => u.trim_end_matches('/').to_string(),
        (None, Some(pf)) => match read_port_file(pf, home) {
            Ok(port) => format!("http://127.0.0.1:{port}"),
            Err(r) => return r,
        },
        (Some(_), Some(_)) => {
            return ProbeResult::new(
                ProbeState::Invalid,
                "bad-target",
                "set url or portFile, not both",
                None,
            )
        }
        (None, None) => {
            return ProbeResult::new(
                ProbeState::Invalid,
                "bad-target",
                "surface has neither url nor portFile",
                None,
            )
        }
    };

    let frame_url = match parse_loopback_url(&base) {
        Ok(u) => u,
        Err((reason, detail)) => {
            return ProbeResult::new(ProbeState::Invalid, reason, detail, Some(&base))
        }
    };

    if let Some(hp) = &target.health_path {
        let mut health = frame_url.clone();
        health.path = if hp.starts_with('/') {
            hp.clone()
        } else {
            format!("/{hp}")
        };
        let resp = match http_get(&health, &base, timeout) {
            Ok(r) => r,
            Err(r) => return r,
        };
        let what = format!("{} {}", base, health.path);
        if let Some(r) = classify_status(resp.status, &base, &what) {
            return r;
        }
        if target.expect_ok_json {
            let ok = serde_json::from_slice::<serde_json::Value>(&resp.body)
                .ok()
                .and_then(|v| v.get("ok").and_then(|o| o.as_bool()))
                == Some(true);
            if !ok {
                let snippet: String =
                    String::from_utf8_lossy(&resp.body[..resp.body.len().min(80)]).into();
                return ProbeResult::new(
                    ProbeState::WrongService,
                    "health-not-ok",
                    format!("{what} did not return {{\"ok\": true}}; got {snippet:?}"),
                    Some(&base),
                )
                .with_status(resp.status);
            }
        }
    }

    let resp = match http_get(&frame_url, &base, timeout) {
        Ok(r) => r,
        Err(r) => return r,
    };
    if let Some(r) = classify_status(resp.status, &base, &format!("{}{}", base, frame_url.path)) {
        return r;
    }
    if let Some((reason, detail)) = frame_refusal(&resp) {
        return ProbeResult::new(ProbeState::Blocked, reason, detail, Some(&base))
            .with_status(resp.status);
    }
    ProbeResult::new(
        ProbeState::Up,
        "ok",
        format!("HTTP {}", resp.status),
        Some(&base),
    )
    .with_status(resp.status)
}

/// Tauri command. Runs the blocking probe off the async runtime's workers.
#[tauri::command]
pub async fn probe_surface(target: ProbeTarget) -> ProbeResult {
    let home = home_dir();
    tauri::async_runtime::spawn_blocking(move || probe_blocking(&target, home))
        .await
        .unwrap_or_else(|e| {
            ProbeResult::new(ProbeState::Error, "probe-crashed", e.to_string(), None)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    /// Serve one canned response per accepted connection, `n` times.
    fn serve(responses: Vec<&'static str>) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            for resp in responses {
                let (mut s, _) = l.accept().unwrap();
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                let _ = s.write_all(resp.as_bytes());
            }
        });
        port
    }

    /// A port that was open a moment ago and is now closed.
    fn closed_port() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    }

    /// A closed port is refused at once on Linux/macOS. Windows retries the SYN
    /// for about 2 s first, so a short timeout can report `timeout` instead.
    fn is_closed_port_reason(reason: &str) -> bool {
        reason == "refused" || (cfg!(windows) && reason == "timeout")
    }

    fn target(url: &str) -> ProbeTarget {
        ProbeTarget {
            url: Some(url.into()),
            port_file: None,
            health_path: None,
            expect_ok_json: false,
            timeout_ms: Some(500),
        }
    }

    #[test]
    fn parses_loopback_urls() {
        let u = parse_loopback_url("http://127.0.0.1:8765").unwrap();
        assert_eq!(u.addr, "127.0.0.1:8765".parse().unwrap());
        assert_eq!(u.path, "/");
        let u = parse_loopback_url("http://localhost:8791/deck?x=1").unwrap();
        assert_eq!(u.addr.port(), 8791);
        assert_eq!(u.path, "/deck?x=1");
        let u = parse_loopback_url("http://[::1]:8766/").unwrap();
        assert!(u.addr.is_ipv6());
        assert_eq!(
            parse_loopback_url("http://127.0.0.1/").unwrap().addr.port(),
            80
        );
    }

    #[test]
    fn refuses_non_loopback_and_bad_urls() {
        assert_eq!(
            parse_loopback_url("http://192.168.1.10:8765")
                .unwrap_err()
                .0,
            "not-loopback"
        );
        assert_eq!(
            parse_loopback_url("http://example.com").unwrap_err().0,
            "not-loopback"
        );
        assert_eq!(
            parse_loopback_url("http://127.0.0.1.evil.com:80")
                .unwrap_err()
                .0,
            "not-loopback"
        );
        assert_eq!(
            parse_loopback_url("https://127.0.0.1:8765").unwrap_err().0,
            "bad-url"
        );
        assert_eq!(
            parse_loopback_url("http://user@127.0.0.1:1").unwrap_err().0,
            "bad-url"
        );
        assert_eq!(
            parse_loopback_url("http://127.0.0.1:0").unwrap_err().0,
            "bad-url"
        );
        assert_eq!(
            parse_loopback_url("http://127.0.0.1:99999").unwrap_err().0,
            "bad-url"
        );
        assert_eq!(
            parse_loopback_url("http://[::1:80").unwrap_err().0,
            "bad-url"
        );
    }

    #[test]
    fn non_loopback_target_never_opens_a_socket() {
        let r = probe_blocking(&target("http://10.0.0.1:8765"), None);
        assert_eq!(r.state, ProbeState::Invalid);
        assert_eq!(r.reason, "not-loopback");
    }

    #[test]
    fn closed_port_is_down_refused() {
        let r = probe_blocking(
            &target(&format!("http://127.0.0.1:{}", closed_port())),
            None,
        );
        assert_eq!(r.state, ProbeState::Down, "{r:?}");
        assert!(is_closed_port_reason(&r.reason), "{r:?}");
        assert!(
            r.detail.contains("127.0.0.1"),
            "detail names the address: {}",
            r.detail
        );
    }

    #[test]
    fn live_dashboard_is_up() {
        let port = serve(vec![
            "HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\n<html></html>",
        ]);
        let r = probe_blocking(&target(&format!("http://127.0.0.1:{port}/")), None);
        assert_eq!(r.state, ProbeState::Up, "{r:?}");
        assert_eq!(r.http_status, Some(200));
        assert_eq!(
            r.url.as_deref(),
            Some(format!("http://127.0.0.1:{port}").as_str())
        );
    }

    #[test]
    fn redirect_counts_as_up() {
        let port = serve(vec!["HTTP/1.1 302 Found\r\nLocation: /dash\r\n\r\n"]);
        assert_eq!(
            probe_blocking(&target(&format!("http://127.0.0.1:{port}")), None).state,
            ProbeState::Up
        );
    }

    #[test]
    fn websocket_server_is_wrong_service() {
        let port = serve(vec![
            "HTTP/1.1 426 Upgrade Required\r\nUpgrade: websocket\r\n\r\n",
        ]);
        let r = probe_blocking(&target(&format!("http://127.0.0.1:{port}")), None);
        assert_eq!(r.state, ProbeState::WrongService);
        assert_eq!(r.reason, "http-426");
    }

    #[test]
    fn server_errors_are_reported_with_status() {
        let port = serve(vec!["HTTP/1.0 503 Service Unavailable\r\n\r\n"]);
        let r = probe_blocking(&target(&format!("http://127.0.0.1:{port}")), None);
        assert_eq!(
            (r.state, r.reason.as_str(), r.http_status),
            (ProbeState::Error, "http-5xx", Some(503))
        );
        let port = serve(vec!["HTTP/1.0 404 Not Found\r\n\r\n"]);
        let r = probe_blocking(&target(&format!("http://127.0.0.1:{port}")), None);
        assert_eq!(
            (r.state, r.reason.as_str()),
            (ProbeState::Error, "http-status")
        );
    }

    #[test]
    fn frame_denial_is_blocked() {
        let port = serve(vec!["HTTP/1.0 200 OK\r\nX-Frame-Options: DENY\r\n\r\n"]);
        let r = probe_blocking(&target(&format!("http://127.0.0.1:{port}")), None);
        assert_eq!(
            (r.state, r.reason.as_str()),
            (ProbeState::Blocked, "frame-denied")
        );
        let port = serve(vec!["HTTP/1.0 200 OK\r\nContent-Security-Policy: default-src 'self'; frame-ancestors 'self'\r\n\r\n"]);
        let r = probe_blocking(&target(&format!("http://127.0.0.1:{port}")), None);
        assert_eq!(
            (r.state, r.reason.as_str()),
            (ProbeState::Blocked, "frame-ancestors")
        );
        let port = serve(vec![
            "HTTP/1.0 200 OK\r\nContent-Security-Policy: frame-ancestors *\r\n\r\n",
        ]);
        assert_eq!(
            probe_blocking(&target(&format!("http://127.0.0.1:{port}")), None).state,
            ProbeState::Up
        );
    }

    #[test]
    fn silent_listener_is_no_response() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            thread::sleep(Duration::from_millis(800));
            drop(s);
        });
        let mut t = target(&format!("http://127.0.0.1:{port}"));
        t.timeout_ms = Some(200);
        let r = probe_blocking(&t, None);
        assert_eq!(
            (r.state, r.reason.as_str()),
            (ProbeState::WrongService, "no-response")
        );
        h.join().unwrap();
    }

    #[test]
    fn non_http_reply_is_wrong_service() {
        let port = serve(vec!["SSH-2.0-OpenSSH_9.6\r\n"]);
        let r = probe_blocking(&target(&format!("http://127.0.0.1:{port}")), None);
        assert_eq!(
            (r.state, r.reason.as_str()),
            (ProbeState::WrongService, "not-http")
        );
    }

    #[test]
    fn health_check_requires_ok_true() {
        let port = serve(vec![
            "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\": true}",
            "HTTP/1.0 200 OK\r\n\r\n<html>dash</html>",
        ]);
        let mut t = target(&format!("http://127.0.0.1:{port}"));
        t.health_path = Some("/api/health".into());
        t.expect_ok_json = true;
        assert_eq!(probe_blocking(&t, None).state, ProbeState::Up);

        let port = serve(vec!["HTTP/1.0 200 OK\r\n\r\n{\"status\": \"fine\"}"]);
        t.url = Some(format!("http://127.0.0.1:{port}"));
        let r = probe_blocking(&t, None);
        assert_eq!(
            (r.state, r.reason.as_str()),
            (ProbeState::WrongService, "health-not-ok")
        );
    }

    #[test]
    fn port_file_resolution() {
        let dir = std::env::temp_dir().join(format!("fleet-probe-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".sovereign")).unwrap();
        let home = Some(dir.clone());

        let r = read_port_file("~/.sovereign/dashboard.port", home.clone()).unwrap_err();
        assert_eq!(
            (r.state, r.reason.as_str()),
            (ProbeState::Down, "port-file-missing")
        );
        assert!(r.detail.ends_with("dashboard.port"), "{}", r.detail);

        std::fs::write(dir.join(".sovereign/dashboard.port"), "not a port\n").unwrap();
        let r = read_port_file("~/.sovereign/dashboard.port", home.clone()).unwrap_err();
        assert_eq!(r.reason, "port-file-invalid");

        std::fs::write(dir.join(".sovereign/dashboard.port"), "8771\n").unwrap();
        assert_eq!(
            read_port_file("~/.sovereign/dashboard.port", home.clone()),
            Ok(8771)
        );

        let r = read_port_file("~/x", None).unwrap_err();
        assert_eq!(
            (r.state, r.reason.as_str()),
            (ProbeState::Invalid, "port-file-path")
        );

        // End to end: the port file points at a closed port.
        let closed = closed_port();
        std::fs::write(dir.join(".sovereign/dashboard.port"), closed.to_string()).unwrap();
        let t = ProbeTarget {
            url: None,
            port_file: Some("~/.sovereign/dashboard.port".into()),
            health_path: Some("api/health".into()),
            expect_ok_json: true,
            timeout_ms: Some(300),
        };
        let r = probe_blocking(&t, home);
        assert_eq!(r.state, ProbeState::Down, "{r:?}");
        assert!(is_closed_port_reason(&r.reason), "{r:?}");
        assert_eq!(r.url, Some(format!("http://127.0.0.1:{closed}")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn target_needs_exactly_one_source() {
        let mut t = target("http://127.0.0.1:1");
        t.port_file = Some("~/p".into());
        assert_eq!(probe_blocking(&t, None).reason, "bad-target");
        t.url = None;
        t.port_file = None;
        assert_eq!(probe_blocking(&t, None).state, ProbeState::Invalid);
    }

    #[test]
    fn result_serializes_camel_case_for_the_frontend() {
        let r = ProbeResult::new(
            ProbeState::WrongService,
            "http-426",
            "d",
            Some("http://127.0.0.1:8766"),
        )
        .with_status(426);
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["state"], "wrongService");
        assert_eq!(v["httpStatus"], 426);
        let t: ProbeTarget =
            serde_json::from_str(r#"{"portFile":"~/a","healthPath":"/h","expectOkJson":true}"#)
                .unwrap();
        assert_eq!(t.port_file.as_deref(), Some("~/a"));
        assert!(t.expect_ok_json);
    }
}
