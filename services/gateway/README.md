# `zocai-gateway`

FastAPI streaming gateway sidecar — Layer 2 of the Zoc AI Ecosystem.

This is a scaffolding skeleton (task 1.1). It currently exposes a single
`/health` endpoint via `zocai_gateway.app:app`. The Mode_Router, Orchestrator,
9-stage FSM, Model_Allocator, and the `v1/agent/*` SSE + control endpoints are
implemented in later tasks.

Replaces the legacy `services/agent` sidecar once the build-gated migration
(Requirement 13) completes.

## Security

### Loopback binding and the no-auth constraint (known, intentional)

By default the Gateway binds its control and telemetry endpoints to the
**loopback interface** (`127.0.0.1`). The following endpoints:

- `POST /v1/agent/run` — start an agent run (control)
- `POST /v1/agent/decision` — submit an approval/budget decision (control)
- `GET  /v1/agent/events` — ordered SSE event stream (telemetry)
- `GET  /v1/agent/diary` — diary recovery stream (telemetry)

**accept requests WITHOUT any authentication when bound to loopback.** This is a
**known and intentional security constraint**, not an oversight. On the default
loopback bind the surface is reachable only from processes on the same host
(e.g. the Tauri desktop shell that launches the Gateway as a sidecar), so no
credential is required and requests are accepted whether or not one is presented.

### Binding to a non-loopback interface requires a credential

If the Gateway is configured to bind to a **non-loopback** interface (any host
other than `127.0.0.1`, `::1`, or `localhost`), an authentication credential
**must** be supplied via the `ZOC_STUDIO_GATEWAY_TOKEN` environment variable:

- At startup, `enforce_bind_policy()` checks the configured host. If a
  non-loopback host is configured **without** `ZOC_STUDIO_GATEWAY_TOKEN`, the
  Gateway **refuses to start** and emits a configuration error identifying the
  missing credential. It will not silently expose an unauthenticated surface
  beyond localhost.
- Once bound to a non-loopback interface, requests to the control and telemetry
  endpoints that lack a valid credential are rejected with `401 Unauthorized`
  before the handler runs; the requested operation does not execute.

In short: the unauthenticated posture is confined to the loopback interface by
design, and exposing the Gateway any wider is gated on an explicit credential
(`ZOC_STUDIO_GATEWAY_TOKEN`) or the process refuses to start.
