"""HTTP/WebSocket route modules for the gateway (Layer 2).

Route logic that is substantial enough to test in isolation lives here as
transport-agnostic helpers; :func:`zocai_gateway.app.create_app` wires the thin
FastAPI endpoints on top of them.
"""
