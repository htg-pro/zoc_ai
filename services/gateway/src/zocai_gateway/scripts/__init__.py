"""Executable entrypoints for the Zoc AI Gateway sidecar.

Currently exposes :mod:`zocai_gateway.scripts.launch`, the PyInstaller bundle
entrypoint that performs the Tauri ``ZOC_STUDIO_AGENT_PORT=`` readiness
handshake before handing off to uvicorn (R10.2/R10.3).
"""
