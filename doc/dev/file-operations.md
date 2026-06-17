# Explorer file operations (Phase 2)

The Explorer can create, rename, delete, duplicate, move, and reveal files and
folders. Every mutating operation is scoped to the active workspace by the Rust
shell, open editor tabs stay in sync after rename/move/delete, and the tree
refreshes immediately.

## Tauri commands (`apps/desktop/src/fs_commands.rs`)

| Command | Behavior |
|---------|----------|
| `fs_stat(path)` | Metadata (`exists`, `is_dir`, `is_file`, `size`, `modified_ms`). |
| `fs_create_file(path)` | Create an empty file (errors if it exists); returns the path. |
| `fs_create_dir(path)` | `mkdir -p` a new directory; returns the path. |
| `fs_rename(from,to)` / `fs_move(from,to)` | Rename/move; `to` must not exist; returns the new path. |
| `fs_delete(path)` | Delete a file or directory (recursive); refuses the workspace root. |
| `fs_duplicate(path)` | Copy a file/dir to a non-colliding "… copy" sibling; returns the new path. |
| `fs_reveal(path)` | Open the OS file manager (`open -R` / `explorer /select` / `xdg-open` parent). |

Every command validates its path(s) through `ensure_within_workspace`, which
canonicalizes against the active root and **rejects anything outside it or that
traverses a symlink** — both source and destination are checked for move/rename.
Commands are registered in `apps/desktop/src/lib.rs`.

> Copy Path / Copy Relative Path are handled in the frontend via the clipboard
> API (no disk access needed), relative to the workspace root.

## Frontend

`apps/frontend/src/lib/paths.ts` — pure path helpers and the open-tab remapping
logic: `dirname`, `basename`, `joinPath`, `renamedPath`, `isWithin`, `remapPath`,
`remapOpenFiles`, `remapActive`, `openFilesAfterDelete`, `activeAfterDelete`.
Separator-aware (POSIX and Windows).

`apps/frontend/src/lib/tauri-bridge.ts` — typed wrappers (`fsStat`,
`fsCreateFile`, `fsCreateDir`, `fsRename`, `fsMove`, `fsDelete`, `fsDuplicate`,
`fsReveal`). Mutating wrappers throw the Rust error string so the store can
surface it as a toast.

`apps/frontend/src/lib/store.ts` — actions: `createFile`, `createFolder`,
`renameEntry`, `duplicateEntry`, `deleteEntry`, `moveEntry`, `revealEntry`.
Rename/move/delete update `openFiles` + `activeFile` via the `paths` helpers so
open tabs follow the file. A `fsRefreshNonce` counter is bumped after each op so
the tree re-fetches affected directories immediately (in addition to the fs
watcher). Outside the desktop runtime they no-op with a toast.

`apps/frontend/src/features/files/FileTree.tsx` — the Explorer UI:
- Toolbar: New File, New Folder, Refresh, Collapse Folders.
- Right-click context menu on files, folders, and the empty background, with
  Open, New File/Folder (dirs), Rename, Duplicate, Delete, Reveal, Copy Path,
  Copy Relative Path.
- Inline input for create and in-place rename (Enter = commit, Esc/blur = cancel).
- Delete confirmation dialog, with an extra warning when the target is an open
  file with unsaved changes.
- Drag-and-drop a file/folder onto a directory (or the root) to move it.
- Ignored folders (`.git`, `node_modules`, …) are excluded by the Rust lister.

## Tests

- Rust (`apps/desktop/src/fs_commands.rs` `#[cfg(test)]`): move within workspace,
  **reject move to a destination outside the workspace**, `unique_copy_path`
  collision avoidance, recursive directory copy.
- Frontend `lib/__tests__/paths.test.ts` — all path helpers + remap logic (POSIX
  and Windows separators).
- Frontend `__tests__/store.test.ts` — `renameEntry` updates open tabs + active
  file; `deleteEntry` closes affected tabs and moves the selection; ops no-op
  gracefully outside the desktop runtime.

## Not yet

Multi-select and "Compare Selected" / "Open to Side" are deferred to the editor
split-group work (Phase 9). "Open in Integrated Terminal" lands with the
terminal upgrade (Phase 8).
