# Editor file save + secure-store fallback

This guide covers two closely-related fixes that make the IDE feel like a real
editor and unblock cloud provider usage:

1. **Editor file save** — `Cmd/Ctrl-S` now writes the active buffer to disk.
2. **Secure-store localStorage shadow** — saved API keys are now read back
   consistently, so the agent panel connects and the model picker stops showing
   "NO KEY".

---

## 1. Editor file save

### Symptom

The editor tracked a `dirty` flag (the amber dot on a tab) but there was no way
to actually persist edits. Nothing cleared `dirty`, there was no `Cmd-S`
binding, and no store action wrote the buffer back to disk.

### Flow

```
Cmd/Ctrl-S ─► useGlobalShortcuts (lib/key-bindings.ts)
            ─► store.saveActiveFile()
            ─► store.saveFile(path)
                 ├─ not dirty            → no-op, returns true
                 ├─ browser preview      → clears dirty, returns true
                 └─ desktop (Tauri)      → fsWriteText(path, content)
                                            ├─ ok   → clears dirty + success toast
                                            └─ fail → error toast, keeps dirty
```

### Where the pieces live

| Piece | Location |
|-------|----------|
| `saveFile(path)` / `saveActiveFile()` actions | `apps/frontend/src/lib/store.ts` (next to `updateFile`) |
| `Cmd/Ctrl-S` binding | `apps/frontend/src/lib/key-bindings.ts` |
| Disk write wrapper | `fsWriteText` in `apps/frontend/src/lib/tauri-bridge.ts` → Rust `fs_write_text` |
| Dirty indicator (amber dot) | `apps/frontend/src/features/editor/EditorTabs.tsx` |

### Notes

- Paths in `openFiles` are absolute (they come from `fs_list_dir`), so
  `fsWriteText` is called with the path verbatim.
- In the browser preview there is no disk; `saveFile` just clears `dirty` so the
  UI reflects a saved state. Tests run in this mode.
- Saving a clean buffer is a no-op that still reports success, so callers don't
  need to check dirtiness first.

---

## 2. Secure-store localStorage shadow

### Symptom

On Linux desktops the OS keychain (libsecret / secret service) is frequently
unavailable. The previous `secureStore` was **asymmetric**:

- `set` fell back to `localStorage` when the keychain write threw, **but**
- `get` called `secret_get`, which returns `Ok(None)` (no error) on a miss, so
  it returned `null` and **never consulted the localStorage shadow**.

The result: a Groq key saved in Settings was written to `localStorage`, but
every reader (`resolveProviderCreds`, `ModelPicker`, Settings re-open) read
`null`. The agent panel couldn't connect, the model picker showed "NO KEY", and
the key appeared lost across restarts.

### Fix

`apps/frontend/src/lib/secure-store.ts` now uses a **durable, symmetric** shadow:

- `get` — try the keychain; on a miss (`null`/empty) **or** a throw, fall back
  to `shadowGet` (localStorage). In the browser it reads the shadow directly.
- `set` — **always** write the localStorage shadow first (durable backup), then
  best-effort write the keychain. The shadow is *not* cleared on keychain
  success, so a key survives even when the keychain is a non-persistent Linux
  session keyring that gets wiped on logout/restart.
- `clear` — clear the keychain (best effort) **and** always clear the shadow.
- `subscribeSecrets(cb)` — writers (`set`/`clear`) notify subscribers so UI
  surfaces can refresh immediately. Secrets aren't otherwise a reactive store.

The Tauri-vs-browser branch is gated on `isTauri()` (from `tauri-bridge`) rather
than probing `import("@tauri-apps/api/core")`, which is both faster and
unambiguous. Shadow keys are namespaced under `zoc-studio.secret.<key>`.

### Why the picker showed "NO KEY" while Settings said "configured"

API keys live in `secureStore`, which is **not** a reactive store. The model
picker only re-read keys when its `cloudProviders` snapshot changed — so saving
a key in Settings (which doesn't necessarily change that snapshot) left the
picker's "key set / NO KEY" map stale. The picker now re-reads on three
triggers: the provider list changes, `subscribeSecrets` fires (a key was
saved/cleared anywhere), or the dropdown is opened.

### Why this unblocks everything downstream

All key readers go through `secureStore.get`:

| Reader | Purpose |
|--------|---------|
| `resolveProviderCreds` (`store.ts`) | merges the API key into the agent run / inline-edit payload so the backend routes to the right cloud endpoint |
| `ModelPicker` (`features/agent/`) | shows the per-provider "key set / NO KEY" badge |
| `Providers` settings section | pre-fills the key field on re-open |

Once `get` consults the shadow, the saved key flows to all three.

---

## Tests

- `apps/frontend/src/lib/__tests__/secure-store.test.ts` — round-trip / overwrite
  / clear / key-isolation symmetry + `subscribeSecrets` notification (stubs a
  full Map-backed `localStorage` because the jsdom shim only implements
  get/setItem).
- `apps/frontend/src/__tests__/store.test.ts` — `saveFile`/`saveActiveFile`
  clear the dirty flag, no-op on clean buffers, and return `false` with no file
  open.

## Seeing the fix in the desktop app

These are frontend changes bundled into the Tauri binary at build time
(`frontendDist: ../frontend/dist`). A previously-built binary will NOT contain
them — rebuild so the fresh Vite bundle is packaged:

```bash
pnpm --filter @zoc-studio/desktop build   # runs tauri:prepare → vite build → dist
# or, full release:  make release
```

`scripts/prepare_tauri_build.sh` (Tauri's `beforeBuildCommand`) rebuilds the
frontend, hotpath crate, and sidecar on every build, so a plain `tauri build`
always ships current code. During development, `pnpm dev` / `tauri dev` serves
the frontend live with HMR.
