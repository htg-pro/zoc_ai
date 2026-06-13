//! PTY execution with proper timeout and exit handling.
//!
//! Uses a separate reader thread to avoid blocking indefinitely when draining
//! output after the child process exits.

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::io::Read;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct PtySpec {
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PtyEvent {
    Started { pid: Option<u32> },
    Output { data: String },
    Exit { code: Option<i32> },
}

pub fn describe(spec: &PtySpec) -> Result<String> {
    Ok(format!("pty {} {:?}", spec.cmd, spec.args))
}

fn build_cmd(spec: &PtySpec) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&spec.cmd);
    cmd.args(&spec.args);
    if let Some(cwd) = &spec.cwd {
        cmd.cwd(cwd);
    }
    cmd
}

/// Execute a command in a PTY and capture all output.
///
/// Uses a separate reader thread to avoid blocking indefinitely when the child
/// exits but the master FD doesn't see EOF immediately.
pub fn run(spec: &PtySpec, timeout: Option<Duration>) -> Result<(String, Option<i32>)> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("openpty")?;

    let mut child = pair
        .slave
        .spawn_command(build_cmd(spec))
        .context("spawn")?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .context("clone_reader")?;

    // Spawn a reader thread to avoid blocking indefinitely
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, std::io::Error>>();
    let reader_thread = thread::spawn(move || {
        let mut tmp = [0u8; 4096];
        loop {
            match reader.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Ok(tmp[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e));
                    break;
                }
            }
        }
    });

    let start = Instant::now();
    let mut buf = Vec::with_capacity(4096);
    let mut exit_code: Option<i32> = None;
    let mut child_exited = false;
    let drain_deadline = Duration::from_secs(2);
    let mut drain_start: Option<Instant> = None;

    // Main loop: poll for exit and output
    loop {
        // Check overall timeout
        if let Some(t) = timeout {
            if start.elapsed() > t {
                let _ = child.kill();
                break;
            }
        }

        // Check for child exit
        if !child_exited {
            if let Ok(Some(status)) = child.try_wait() {
                exit_code = status.exit_code().try_into().ok();
                child_exited = true;
                drain_start = Some(Instant::now());
            }
        }

        // Try to receive output with a short timeout
        let recv_timeout = if child_exited {
            // After exit, use shorter timeout for draining
            Duration::from_millis(50)
        } else {
            Duration::from_millis(100)
        };

        match rx.recv_timeout(recv_timeout) {
            Ok(Ok(data)) => {
                buf.extend_from_slice(&data);
            }
            Ok(Err(_)) => {
                // Read error, stop
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // No output in timeout period
                if child_exited {
                    // Check if we've exceeded drain deadline
                    if let Some(ds) = drain_start {
                        if ds.elapsed() > drain_deadline {
                            break;
                        }
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Reader thread finished
                break;
            }
        }
    }

    // If we haven't gotten exit code yet, wait for it (with timeout)
    if exit_code.is_none() {
        let wait_timeout = Duration::from_secs(5);
        let wait_start = Instant::now();
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                exit_code = status.exit_code().try_into().ok();
                break;
            }
            if wait_start.elapsed() > wait_timeout {
                let _ = child.kill();
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    // Wait for reader thread to finish (with timeout)
    let join_timeout = Duration::from_secs(1);
    let join_start = Instant::now();
    loop {
        if reader_thread.is_finished() {
            let _ = reader_thread.join();
            break;
        }
        if join_start.elapsed() > join_timeout {
            // Abandon the reader thread - it will finish when the PTY closes
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    // Drop master to help with cleanup
    drop(pair.master);

    let text = String::from_utf8_lossy(&buf).to_string();
    Ok((text, exit_code))
}

/// Execute a command in a PTY and stream output as JSON-line events.
///
/// Uses a separate reader thread to avoid blocking indefinitely when the child
/// exits but the master FD doesn't see EOF immediately.
pub fn spawn_streaming(spec: &PtySpec) -> Result<Option<i32>> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("openpty")?;

    let mut child = pair
        .slave
        .spawn_command(build_cmd(spec))
        .context("spawn")?;
    drop(pair.slave);

    let pid = child.process_id();
    println!(
        "{}",
        serde_json::to_string(&PtyEvent::Started { pid })?
    );

    let mut reader = pair
        .master
        .try_clone_reader()
        .context("clone_reader")?;

    // Spawn a reader thread
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, std::io::Error>>();
    let reader_thread = thread::spawn(move || {
        let mut tmp = [0u8; 4096];
        loop {
            match reader.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Ok(tmp[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e));
                    break;
                }
            }
        }
    });

    let mut exit_code: Option<i32> = None;
    let mut child_exited = false;
    let drain_deadline = Duration::from_secs(2);
    let mut drain_start: Option<Instant> = None;

    // Main loop: poll for exit and output
    loop {
        // Check for child exit
        if !child_exited {
            if let Ok(Some(status)) = child.try_wait() {
                exit_code = status.exit_code().try_into().ok();
                child_exited = true;
                drain_start = Some(Instant::now());
            }
        }

        // Try to receive output with a short timeout
        let recv_timeout = if child_exited {
            Duration::from_millis(50)
        } else {
            Duration::from_millis(100)
        };

        match rx.recv_timeout(recv_timeout) {
            Ok(Ok(data)) => {
                let output = String::from_utf8_lossy(&data).to_string();
                if !output.is_empty() {
                    println!(
                        "{}",
                        serde_json::to_string(&PtyEvent::Output { data: output })?
                    );
                }
            }
            Ok(Err(_)) => {
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if child_exited {
                    if let Some(ds) = drain_start {
                        if ds.elapsed() > drain_deadline {
                            break;
                        }
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break;
            }
        }
    }

    // If we haven't gotten exit code yet, wait for it
    if exit_code.is_none() {
        if let Ok(status) = child.wait() {
            exit_code = status.exit_code().try_into().ok();
        }
    }

    // Emit exit event
    println!(
        "{}",
        serde_json::to_string(&PtyEvent::Exit { code: exit_code })?
    );

    // Wait for reader thread to finish (with timeout)
    let join_timeout = Duration::from_secs(1);
    let join_start = Instant::now();
    loop {
        if reader_thread.is_finished() {
            let _ = reader_thread.join();
            break;
        }
        if join_start.elapsed() > join_timeout {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    drop(pair.master);

    Ok(exit_code)
}
