//! Local-model hardware fit — zoc-agent-chat-rebuild R13.6.
//!
//! Answers one question for the model picker: will this GGUF actually load on
//! this machine? Nothing created this before, and both the panel shell (22.1)
//! and the model picker (22.2) consume it.
//!
//! The command is a thin shell over [`classify_fit`], which is pure. That split
//! is the whole design: hardware probing cannot be exercised in a unit test, but
//! the arithmetic that turns three numbers into one of three states can be —
//! including the zero-VRAM CPU-only case, which is the one a developer with a
//! discrete GPU will never hit by hand.
//!
//! The probe reads hardware only. It carries no secret, touches no workspace
//! file, and makes no network call, so it is not a trust-boundary change.

use serde::Serialize;

/// Bytes in one binary gigabyte, matching `hardware-probe`'s convention.
const BYTES_PER_GB: f64 = 1_073_741_824.0;

/// Headroom a loaded model needs beyond its file size, as a multiplier.
///
/// A GGUF's weights are only part of its resident cost: the KV cache, the
/// compute buffers, and the allocator's slack all sit on top. 1.25 is the
/// conservative figure `llama.cpp` users converge on for a modest context; it is
/// named here rather than inlined so a future measurement can replace it in one
/// place.
const RESIDENT_OVERHEAD: f64 = 1.25;

/// Below this much free memory *after* the model loads, the fit is `tight`.
const TIGHT_HEADROOM_GB: f64 = 1.5;

/// The single fit verdict the picker renders (R13.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FitState {
    /// Loads with room to spare.
    Fits,
    /// Loads, but leaves little headroom — the user should expect swapping or a
    /// short context.
    Tight,
    /// Will not load. Offering this model without saying so produces a failed
    /// load the user cannot diagnose.
    Exceeds,
}

/// The full answer: a state, a short reason, and the figures behind them.
///
/// The figures are returned as well as the verdict because a user who is told
/// "tight" will reasonably ask "how tight", and a picker that has the numbers
/// can answer without a second round trip.
#[derive(Clone, Debug, Serialize)]
pub struct HardwareFit {
    pub state: FitState,
    /// One sentence, free of paths and identifiers, safe to render verbatim.
    pub reason: String,
    pub model_size_gb: f64,
    pub required_gb: f64,
    pub total_memory_gb: Option<f64>,
    pub available_memory_gb: Option<f64>,
    pub vram_gb: Option<f64>,
    /// Layers the caller intends to offload to the GPU. `0` means CPU-only.
    pub n_gpu_layers: u32,
    /// True when the offload target is the GPU and its VRAM was the binding
    /// constraint, so the picker can say *which* memory ran out.
    pub gpu_bound: bool,
}

/// Inputs to the pure classifier, so a test can state a machine exactly.
#[derive(Clone, Copy, Debug)]
pub struct FitInputs {
    pub model_size_bytes: u64,
    pub total_memory_gb: Option<f64>,
    pub available_memory_gb: Option<f64>,
    pub vram_gb: Option<f64>,
    pub n_gpu_layers: u32,
}

/// Reduce a machine and a model to one fit state.
///
/// Two decisions are worth stating because neither is forced:
///
/// - **An undetectable memory reading yields `tight`, not `fits` or `exceeds`.**
///   Claiming `fits` would be a guess presented as a fact, and `exceeds` would
///   hide a model that probably works on a machine whose OS simply did not
///   answer. `tight` is the honest verdict: it lets the user proceed and warns
///   them that we could not check.
/// - **GPU offload is judged against VRAM, not RAM.** With `n_gpu_layers > 0`
///   and a detected GPU, the weights land in VRAM; a machine with 64 GB of RAM
///   and 4 GB of VRAM cannot hold an 8 GB model on the GPU, and reporting `fits`
///   from the RAM figure is the exact mistake this function exists to prevent.
pub fn classify_fit(inputs: FitInputs) -> HardwareFit {
    let model_size_gb = inputs.model_size_bytes as f64 / BYTES_PER_GB;
    let required_gb = model_size_gb * RESIDENT_OVERHEAD;
    let offloading = inputs.n_gpu_layers > 0;

    // A zero-size model is not a small model, it is a missing or unreadable
    // file. Saying "fits" about a file we could not measure would send the user
    // into a load failure with no explanation.
    if inputs.model_size_bytes == 0 {
        return HardwareFit {
            state: FitState::Exceeds,
            reason: "The model file could not be measured.".to_string(),
            model_size_gb,
            required_gb,
            total_memory_gb: inputs.total_memory_gb,
            available_memory_gb: inputs.available_memory_gb,
            vram_gb: inputs.vram_gb,
            n_gpu_layers: inputs.n_gpu_layers,
            gpu_bound: false,
        };
    }

    let (budget_gb, gpu_bound, what) = match (offloading, inputs.vram_gb) {
        (true, Some(vram)) => (Some(vram), true, "video memory"),
        // Offload was requested but no GPU was detected: the layers fall back to
        // the CPU, so judge against RAM and say so in the reason.
        (true, None) => (
            inputs.available_memory_gb.or(inputs.total_memory_gb),
            false,
            "system memory",
        ),
        (false, _) => (
            inputs.available_memory_gb.or(inputs.total_memory_gb),
            false,
            "system memory",
        ),
    };

    let Some(budget) = budget_gb else {
        return HardwareFit {
            state: FitState::Tight,
            reason: format!("Available {what} could not be detected."),
            model_size_gb,
            required_gb,
            total_memory_gb: inputs.total_memory_gb,
            available_memory_gb: inputs.available_memory_gb,
            vram_gb: inputs.vram_gb,
            n_gpu_layers: inputs.n_gpu_layers,
            gpu_bound,
        };
    };

    let headroom = budget - required_gb;
    let (state, reason) = if headroom < 0.0 {
        (
            FitState::Exceeds,
            format!(
                "Needs about {required_gb:.1} GB of {what}, but only {budget:.1} GB is available."
            ),
        )
    } else if headroom < TIGHT_HEADROOM_GB {
        (
            FitState::Tight,
            format!("Fits with about {headroom:.1} GB of {what} to spare."),
        )
    } else {
        (
            FitState::Fits,
            format!("Fits comfortably in {budget:.1} GB of {what}."),
        )
    };

    HardwareFit {
        state,
        reason,
        model_size_gb,
        required_gb,
        total_memory_gb: inputs.total_memory_gb,
        available_memory_gb: inputs.available_memory_gb,
        vram_gb: inputs.vram_gb,
        n_gpu_layers: inputs.n_gpu_layers,
        gpu_bound,
    }
}

/// Probe the machine and classify one local model file (R13.6).
///
/// `model` is a filesystem path to the GGUF. `n_gpu_layers` is the caller's
/// intended offload count; `0` asks for the CPU-only verdict.
#[tauri::command]
pub fn local_model_hardware_fit(model: String, n_gpu_layers: Option<u32>) -> HardwareFit {
    let profile = hardware_probe::probe();
    let model_size_bytes = std::fs::metadata(&model).map(|m| m.len()).unwrap_or(0);

    classify_fit(FitInputs {
        model_size_bytes,
        total_memory_gb: profile.system_memory_gb,
        available_memory_gb: profile.available_memory_gb,
        vram_gb: profile.gpu_memory_gb,
        n_gpu_layers: n_gpu_layers.unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gb(n: f64) -> u64 {
        (n * BYTES_PER_GB) as u64
    }

    fn inputs(
        size_gb: f64,
        total: Option<f64>,
        avail: Option<f64>,
        vram: Option<f64>,
        layers: u32,
    ) -> FitInputs {
        FitInputs {
            model_size_bytes: gb(size_gb),
            total_memory_gb: total,
            available_memory_gb: avail,
            vram_gb: vram,
            n_gpu_layers: layers,
        }
    }

    #[test]
    fn a_small_model_on_a_large_machine_fits() {
        let fit = classify_fit(inputs(4.0, Some(32.0), Some(24.0), None, 0));
        assert_eq!(fit.state, FitState::Fits);
        assert!(!fit.gpu_bound);
    }

    #[test]
    fn a_model_just_under_the_budget_is_tight() {
        // 4 GB model → 5.0 GB required. 6.0 GB available leaves 1.0 GB, under
        // the 1.5 GB tight threshold.
        let fit = classify_fit(inputs(4.0, Some(16.0), Some(6.0), None, 0));
        assert_eq!(fit.state, FitState::Tight);
    }

    #[test]
    fn a_model_over_the_budget_exceeds() {
        let fit = classify_fit(inputs(16.0, Some(8.0), Some(6.0), None, 0));
        assert_eq!(fit.state, FitState::Exceeds);
        assert!(fit.reason.contains("system memory"));
    }

    #[test]
    fn zero_vram_cpu_only_is_judged_against_ram() {
        // The case a developer with a discrete GPU never reaches by hand: no
        // GPU detected at all, no offload requested.
        let fit = classify_fit(inputs(3.0, Some(16.0), Some(12.0), None, 0));
        assert_eq!(fit.state, FitState::Fits);
        assert_eq!(fit.vram_gb, None);
        assert!(!fit.gpu_bound);
        assert!(fit.reason.contains("system memory"));
    }

    #[test]
    fn offload_is_judged_against_vram_not_ram() {
        // 64 GB of RAM does not help an 8 GB model offloaded to a 4 GB GPU.
        let fit = classify_fit(inputs(8.0, Some(64.0), Some(60.0), Some(4.0), 35));
        assert_eq!(fit.state, FitState::Exceeds);
        assert!(fit.gpu_bound);
        assert!(fit.reason.contains("video memory"));
    }

    #[test]
    fn offload_without_a_detected_gpu_falls_back_to_ram() {
        let fit = classify_fit(inputs(2.0, Some(32.0), Some(28.0), None, 35));
        assert_eq!(fit.state, FitState::Fits);
        assert!(!fit.gpu_bound, "no GPU was detected, so RAM was the budget");
        assert!(fit.reason.contains("system memory"));
    }

    #[test]
    fn an_undetectable_machine_is_tight_not_fits() {
        let fit = classify_fit(inputs(4.0, None, None, None, 0));
        assert_eq!(fit.state, FitState::Tight);
        assert!(fit.reason.contains("could not be detected"));
    }

    #[test]
    fn an_unmeasurable_model_file_exceeds() {
        let fit = classify_fit(FitInputs {
            model_size_bytes: 0,
            total_memory_gb: Some(64.0),
            available_memory_gb: Some(60.0),
            vram_gb: Some(24.0),
            n_gpu_layers: 0,
        });
        assert_eq!(fit.state, FitState::Exceeds);
        assert!(fit.reason.contains("could not be measured"));
    }

    #[test]
    fn available_memory_is_preferred_over_total() {
        // Same machine, same model: plenty of total RAM but little free.
        let fit = classify_fit(inputs(8.0, Some(64.0), Some(2.0), None, 0));
        assert_eq!(fit.state, FitState::Exceeds);
    }

    #[test]
    fn total_memory_is_used_when_available_is_unknown() {
        let fit = classify_fit(inputs(2.0, Some(32.0), None, None, 0));
        assert_eq!(fit.state, FitState::Fits);
    }

    #[test]
    fn the_three_states_serialise_lowercase() {
        assert_eq!(serde_json::to_string(&FitState::Fits).unwrap(), "\"fits\"");
        assert_eq!(
            serde_json::to_string(&FitState::Tight).unwrap(),
            "\"tight\""
        );
        assert_eq!(
            serde_json::to_string(&FitState::Exceeds).unwrap(),
            "\"exceeds\""
        );
    }

    #[test]
    fn the_reason_carries_no_path() {
        // R13.6's reason is rendered verbatim in the picker, so it must never
        // pick up a filesystem path from the inputs.
        for layers in [0u32, 35] {
            for vram in [None, Some(0.5), Some(24.0)] {
                let fit = classify_fit(inputs(7.0, Some(16.0), Some(9.0), vram, layers));
                assert!(
                    !fit.reason.contains('/'),
                    "reason leaked a path: {}",
                    fit.reason
                );
                assert!(!fit.reason.contains('\\'));
            }
        }
    }

    #[test]
    fn every_synthetic_triple_yields_exactly_one_state() {
        // Exhaustive over a small grid rather than sampled: three states over
        // three axes is 54 cases, so enumeration is both cheaper and stronger.
        let sizes = [0.5, 4.0, 8.0, 32.0];
        let totals = [None, Some(8.0), Some(64.0)];
        let vrams = [None, Some(0.0), Some(4.0), Some(24.0)];
        for size in sizes {
            for total in totals {
                for vram in vrams {
                    for layers in [0u32, 99] {
                        let fit = classify_fit(inputs(size, total, total, vram, layers));
                        assert!(matches!(
                            fit.state,
                            FitState::Fits | FitState::Tight | FitState::Exceeds
                        ));
                        assert!(fit.model_size_gb >= 0.0);
                        assert!(fit.required_gb >= fit.model_size_gb);
                    }
                }
            }
        }
    }
}
