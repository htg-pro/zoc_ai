#!/bin/bash
set -e

echo "==> Installing pnpm dependencies..."
COREPACK_ENABLE_STRICT=0 pnpm install --no-frozen-lockfile

echo "==> Installing Python dependencies (uv)..."
uv sync --all-packages

echo "==> Post-merge setup complete."
