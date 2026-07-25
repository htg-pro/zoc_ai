import { describe, expect, it } from "vitest";
import {
  CPU_ALERT_THRESHOLD,
  cpuAlertLabel,
  ramGauge,
  tokensPerSecondLabel,
  vramGauge,
  type HardwareSnapshot,
} from "../status-bar";

const snap = (over: Partial<HardwareSnapshot> = {}): HardwareSnapshot => ({
  cpu_percent: 12,
  ram_used_gb: 8,
  ram_total_gb: 32,
  gpu_vram_used_mb: 2048,
  gpu_vram_total_mb: 8192,
  llm_tokens_per_second: null,
  llm_inference_active: false,
  ...over,
});

describe("ramGauge", () => {
  it("computes the fill ratio and detail text", () => {
    const gauge = ramGauge(snap());
    expect(gauge).toEqual({ label: "RAM", ratio: 0.25, detail: "8.0 / 32.0 GB" });
  });

  it("returns null rather than a misleading empty bar", () => {
    expect(ramGauge(null)).toBeNull();
    expect(ramGauge(snap({ ram_total_gb: null }))).toBeNull();
    expect(ramGauge(snap({ ram_used_gb: null }))).toBeNull();
  });

  it("clamps an impossible reading into range", () => {
    expect(ramGauge(snap({ ram_used_gb: 99 }))?.ratio).toBe(1);
    expect(ramGauge(snap({ ram_used_gb: -5 }))?.ratio).toBe(0);
  });
});

describe("vramGauge", () => {
  it("reports VRAM in GB", () => {
    expect(vramGauge(snap())).toEqual({
      label: "VRAM",
      ratio: 0.25,
      detail: "2.0 / 8.0 GB",
    });
  });

  it("is hidden when there is no GPU", () => {
    expect(vramGauge(snap({ gpu_vram_total_mb: null }))).toBeNull();
    expect(vramGauge(null)).toBeNull();
  });

  it("treats unknown usage as zero against a known total", () => {
    expect(vramGauge(snap({ gpu_vram_used_mb: null }))?.ratio).toBe(0);
  });
});

describe("tokensPerSecondLabel", () => {
  it("shows a rounded rate only while inference is active", () => {
    expect(
      tokensPerSecondLabel(snap({ llm_inference_active: true, llm_tokens_per_second: 31.7 })),
    ).toBe("32 t/s");
    expect(
      tokensPerSecondLabel(snap({ llm_inference_active: false, llm_tokens_per_second: 31.7 })),
    ).toBeNull();
  });

  it("hides a missing or nonsensical rate", () => {
    expect(tokensPerSecondLabel(snap({ llm_inference_active: true }))).toBeNull();
    expect(
      tokensPerSecondLabel(snap({ llm_inference_active: true, llm_tokens_per_second: 0 })),
    ).toBeNull();
    expect(tokensPerSecondLabel(null)).toBeNull();
  });
});

describe("cpuAlertLabel", () => {
  it("stays quiet below the threshold", () => {
    expect(cpuAlertLabel(snap({ cpu_percent: 10 }))).toBeNull();
    expect(cpuAlertLabel(snap({ cpu_percent: CPU_ALERT_THRESHOLD }))).toBeNull();
  });

  it("shows the percentage above the threshold", () => {
    expect(cpuAlertLabel(snap({ cpu_percent: 91.4 }))).toBe("91%");
  });

  it("handles missing readings", () => {
    expect(cpuAlertLabel(snap({ cpu_percent: null }))).toBeNull();
    expect(cpuAlertLabel(null)).toBeNull();
  });

  it("uses the documented 80% threshold", () => {
    expect(CPU_ALERT_THRESHOLD).toBe(80);
  });
});
