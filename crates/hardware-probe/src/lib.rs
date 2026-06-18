//! `hardware-probe` — deterministic, low-latency hardware introspection for the
//! Zoc AI `Model_Allocator`.
//!
//! The allocator must pick a Model_Tier within a hard 500 ms budget (R1.2) using,
//! among other signals, a hardware profile of available GPU memory and system
//! memory expressed in gigabytes. This crate produces that [`HardwareProfile`]
//! synchronously and cheaply:
//!
//! * **System memory** is read via the portable [`sysinfo`] crate (memory feature
//!   only), which works across Linux, macOS, and Windows.
//! * **GPU memory** is a best-effort, dependency-free probe. On Linux it reads the
//!   kernel's DRM sysfs `mem_info_vram_total` files; on other platforms (or when no
//!   GPU is discoverable) it reports `None`.
//!
//! ## Missing-detection convention
//!
//! A `None` value means "could not be detected". Downstream allocator logic (and the
//! Python fallback wired up in a later task) maps a missing reading to the Local SLM
//! fallback path (R1.6). GPU memory is therefore `None` rather than `0.0` when no GPU
//! is found, so "no GPU" and "an undetectable GPU" are not conflated with a real 0 GB
//! reading.
//!
//! The crate is intentionally free of PyO3 bindings; [`probe`] is a plain synchronous
//! function so a binding can wrap it cleanly in a later task.

use serde::{Deserialize, Serialize};
use sysinfo::System;

/// Number of bytes in one gigabyte (binary, 1024^3). Memory and VRAM totals are
/// reported by the OS in bytes, so we convert with the binary gigabyte used
/// throughout the allocator's tier thresholds.
const BYTES_PER_GB: f64 = 1_073_741_824.0;

/// A snapshot of detected hardware resources.
///
/// `None` values represent an undetectable resource, which downstream allocator
/// logic treats as a signal to fall back to the Local SLM tier (R1.6).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HardwareProfile {
    /// Detected GPU memory in gigabytes, if a GPU is present and probeable.
    pub gpu_memory_gb: Option<f64>,
    /// Detected system memory in gigabytes, if probeable.
    pub system_memory_gb: Option<f64>,
}

impl HardwareProfile {
    /// Construct an empty profile (nothing detected). Useful as an explicit
    /// "undetectable hardware" signal for the allocator's fallback path.
    pub fn empty() -> Self {
        Self::default()
    }
}

/// Probe the local machine for GPU and system memory.
///
/// This is synchronous and fast by design: it performs a single memory refresh
/// plus a small, bounded directory scan, completing well within the allocator's
/// 500 ms tier-selection budget (R1.2). Any resource that cannot be determined is
/// reported as `None`.
pub fn probe() -> HardwareProfile {
    HardwareProfile {
        gpu_memory_gb: probe_gpu_memory_gb(),
        system_memory_gb: probe_system_memory_gb(),
    }
}

/// Convert a raw byte count to gigabytes.
fn bytes_to_gb(bytes: u64) -> f64 {
    bytes as f64 / BYTES_PER_GB
}

/// Read total physical system memory in gigabytes via `sysinfo`.
///
/// Returns `None` if the platform reports zero total memory (treated as an
/// undetectable reading rather than a real 0 GB machine).
fn probe_system_memory_gb() -> Option<f64> {
    // `new()` allocates no per-subsystem state; we explicitly refresh only memory
    // to keep the probe cheap and deterministic.
    let mut system = System::new();
    system.refresh_memory();
    let total_bytes = system.total_memory();
    if total_bytes == 0 {
        None
    } else {
        Some(bytes_to_gb(total_bytes))
    }
}

/// Best-effort GPU memory probe.
///
/// On Linux this reads the DRM sysfs VRAM totals; on every other platform it
/// reports `None` so the allocator deterministically takes the Local SLM fallback.
fn probe_gpu_memory_gb() -> Option<f64> {
    #[cfg(target_os = "linux")]
    {
        gpu_memory_gb_from_drm_sysfs()
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Scan `/sys/class/drm/card*/device/mem_info_vram_total` for the largest reported
/// VRAM total and return it in gigabytes.
///
/// The `mem_info_vram_total` node is exposed by the amdgpu and other DRM drivers
/// and contains the total VRAM in bytes. Connector sub-nodes (e.g. `card0-DP-1`)
/// are skipped. Returns `None` when no readable VRAM total is found, which covers
/// machines with no discrete GPU or drivers that do not expose the node.
#[cfg(target_os = "linux")]
fn gpu_memory_gb_from_drm_sysfs() -> Option<f64> {
    use std::fs;

    let entries = fs::read_dir("/sys/class/drm").ok()?;
    let mut max_bytes: u64 = 0;

    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        // Match GPU device nodes like `card0`, but skip connector sub-nodes such
        // as `card0-DP-1` or non-card entries like `renderD128`.
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let vram_path = entry.path().join("device/mem_info_vram_total");
        if let Ok(contents) = fs::read_to_string(&vram_path) {
            if let Ok(bytes) = contents.trim().parse::<u64>() {
                if bytes > max_bytes {
                    max_bytes = bytes;
                }
            }
        }
    }

    if max_bytes == 0 {
        None
    } else {
        Some(bytes_to_gb(max_bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn empty_profile_has_no_readings() {
        let profile = HardwareProfile::empty();
        assert_eq!(profile.gpu_memory_gb, None);
        assert_eq!(profile.system_memory_gb, None);
    }

    #[test]
    fn bytes_to_gb_converts_using_binary_gigabyte() {
        assert_eq!(bytes_to_gb(0), 0.0);
        assert_eq!(bytes_to_gb(1_073_741_824), 1.0);
        assert_eq!(bytes_to_gb(8 * 1_073_741_824), 8.0);
    }

    #[test]
    fn probe_detects_positive_system_memory() {
        // Any real machine running this test has detectable, positive RAM.
        let profile = probe();
        let system_gb = profile
            .system_memory_gb
            .expect("system memory should be detectable on the test host");
        assert!(
            system_gb.is_finite() && system_gb > 0.0,
            "system memory should be a positive finite GB value, got {system_gb}"
        );
    }

    #[test]
    fn gpu_reading_is_none_or_positive() {
        // GPU detection is best-effort: either absent (None) or a positive, finite GB.
        let profile = probe();
        if let Some(gpu_gb) = profile.gpu_memory_gb {
            assert!(
                gpu_gb.is_finite() && gpu_gb > 0.0,
                "a detected GPU should report positive finite GB, got {gpu_gb}"
            );
        }
    }

    #[test]
    fn probe_completes_within_allocator_budget() {
        // R1.2: probing must fit comfortably inside the 500 ms tier-selection budget.
        let start = Instant::now();
        let _ = probe();
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_millis() < 500,
            "probe took {} ms, exceeding the 500 ms allocator budget",
            elapsed.as_millis()
        );
    }
}
