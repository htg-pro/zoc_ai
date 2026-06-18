# `zoc-studio-hotpath`

Rust crate exposing the latency-sensitive primitives the FastAPI agent calls
into: PTY, filesystem watcher, and code indexer. Distributed as a thin CLI
(`zoc-studio-hotpath`) that emits JSON on stdout — FastAPI shells out and
parses.

We chose a CLI over PyO3 to keep the Python sidecar build (and PyInstaller in
Phase 5) free of Rust toolchain coupling.

Phase 1 ships stubs only. Real work lands in Phase 2/4.
