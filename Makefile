.PHONY: install dev build check lint typecheck fmt test schema scan-secrets clean clean-all doctor version sidecar release zip

install:
	pnpm install
	uv sync --all-packages
	cargo fetch

doctor:
	@echo "==> Zoc AI dev environment doctor"
	@echo ""
	@printf "node      : "; node --version 2>/dev/null || echo "MISSING (need >=20)"
	@printf "pnpm      : "; pnpm --version 2>/dev/null || echo "MISSING (need >=9)"
	@printf "python3   : "; python3 --version 2>/dev/null || echo "MISSING"
	@printf "uv        : "; uv --version 2>/dev/null || echo "MISSING (https://docs.astral.sh/uv)"
	@printf "rustc     : "; rustc --version 2>/dev/null || echo "MISSING (https://rustup.rs)"
	@printf "cargo     : "; cargo --version 2>/dev/null || echo "MISSING"
	@printf "tauri-cli : "; (cargo tauri --version 2>/dev/null || pnpm --filter @zoc-studio/desktop exec tauri --version 2>/dev/null) || echo "MISSING (pnpm --filter @zoc-studio/desktop add -D @tauri-apps/cli)"
	@printf "pyinstaller (release only): "; uv run python -c "import PyInstaller; print(PyInstaller.__version__)" 2>/dev/null || echo "MISSING (uv pip install pyinstaller — only needed for release)"
	@echo ""
	@echo "==> Linux runtime deps (Tauri webview):"
	@dpkg-query -W -f='  %p %v\n' libwebkit2gtk-4.1-0 libgtk-3-0 libssl3 libxdo3 2>/dev/null || echo "  (not on a dpkg system, skip)"

dev:
	uv run python3 scripts/stage_dev_binaries.py
	pnpm dev

build:
	pnpm -r build
	cargo build --release --workspace

lint:
	pnpm -r lint
	uv run ruff check .
	cargo clippy --workspace --all-targets -- -D warnings

typecheck:
	pnpm -r typecheck
	uv run mypy services/gateway/src packages/shared-types/python

fmt:
	pnpm -r format
	uv run ruff format .
	cargo fmt --all

test:
	pnpm -r test
	uv run pytest
	cargo test --workspace

schema:
	uv run python packages/shared-types/scripts/generate_ts.py

scan-secrets:
	python3 scripts/scan_secrets.py
	python3 scripts/scan_secrets.py --history

check: scan-secrets lint typecheck test

# --- release pipeline ----------------------------------------------------

version:
	python3 scripts/stamp_version.py

sidecar:
	uv run python3 scripts/bundle_sidecar.py

release: version
	bash scripts/release.sh

release-source-only: version
	bash scripts/release.sh --source-only

zip: release
	bash scripts/make_zip.sh
	python3 scripts/verify_zip.py zoc-studio-v$$(cat VERSION).zip

zip-source-only: release-source-only
	bash scripts/make_zip.sh --allow-empty-installers
	python3 scripts/verify_zip.py zoc-studio-v$$(cat VERSION).zip --source-only

clean:
	pnpm -r clean || true
	cargo clean
	rm -rf dist target

clean-all: clean
	rm -rf node_modules .venv
