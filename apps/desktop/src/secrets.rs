//! Secret_Vault — zoc-agent-chat-rebuild R14.1–R14.10. **Security-relevant.**
//!
//! Three tiers, tried in order, each one the answer to a way the tier above it
//! fails on a real machine:
//!
//! 1. **OS keychain** (`keyring::Entry`, service `ai.zoc.studio`) — with a
//!    durability probe, because on Linux a write can return `Ok` against a
//!    *session* keyring that is wiped on logout.
//! 2. **Encrypted app-local vault** (`~/.zoc-studio/secrets.vault`,
//!    XChaCha20-Poly1305 under an Argon2id-derived key) — for when tier 1 is
//!    present but not durable.
//! 3. **Degraded_Secret_Mode** — an in-process map, zeroised on drop, nothing on
//!    disk, for when there is no secret service at all.
//!
//! The problem being fixed: `apps/frontend/src/lib/secure-store.ts` mirrors every
//! secret into `localStorage` under `zoc-studio.secret.<key>` to work around
//! exactly the tier-1 durability hole above. That shadow is the right instinct
//! and the wrong place — it keeps a plaintext key in a store any renderer script
//! can read (R14.2, R14.3). This module keeps the durability guarantee and
//! removes the renderer from the picture.

use std::collections::HashMap;
use std::io::Write as _;
use std::sync::Arc;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use keyring::Entry;
use parking_lot::Mutex;
use serde::Serialize;
use zeroize::Zeroizing;

const SERVICE: &str = "ai.zoc.studio";
const MASTER_KEY_NAME: &str = "vault.master";
const MASTER_SECRET_BYTES: usize = 32;

// ── Vault file format (R14.6) ─────────────────────────────────────────────
//
//   offset  size  field
//        0     8  magic          "ZOCVAULT"
//        8     2  version        u16 = 1
//       10     2  kdf_id         u16 = 1  (Argon2id)
//       12     4  argon2_m_kib   u32
//       16     4  argon2_t       u32
//       20     4  argon2_p       u32
//       24    16  salt           random per vault
//       40    24  nonce          random per write
//       64     4  ct_len         u32
//       68  ct_len ciphertext    XChaCha20-Poly1305(json, aad = bytes[0..64])
//
// The whole 64-byte header is authenticated as AEAD associated data, so a
// downgrade attack cannot flip `version` or weaken the Argon2 parameters without
// the open failing.
const MAGIC: &[u8; 8] = b"ZOCVAULT";
const VAULT_VERSION: u16 = 1;
const KDF_ARGON2ID: u16 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 68;
const AAD_LEN: usize = 64;

/// OWASP's second recommended Argon2id configuration. Derivation stays under
/// ~50 ms on the reference machine so app start is not visibly delayed.
const ARGON2_M_KIB: u32 = 19_456;
const ARGON2_T: u32 = 2;
const ARGON2_P: u32 = 1;

// The parameters the *reader* accepts, which are deliberately separate
// constants from the ones the writer uses.
//
// Reading derives with the parameters recorded in the header rather than with
// the compile-time constants, so raising the write-time cost later does not turn
// every vault already on disk into an unopenable file — which would lose every
// key it holds. The floor is what stops that flexibility becoming a downgrade
// path, and it moves only with a format version bump and a migration.
const ARGON2_MIN_M_KIB: u32 = 19_456;
const ARGON2_MIN_T: u32 = 2;
/// Ceilings, because the header is untrusted input: a file dropped in the home
/// directory claiming `m = 4 GiB` or `t = 2^32-1` would otherwise make the reader
/// allocate it, or grind on it, before discovering the file does not
/// authenticate. Both leave room for a future cost increase.
const ARGON2_MAX_M_KIB: u32 = 262_144;
const ARGON2_MAX_T: u32 = 16;

/// Which tier is answering. Surfaced to the renderer as a label only — never
/// alongside a value (R14.2, R14.8).
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub enum SecretBackend {
    #[default]
    Keychain,
    Vault,
    Degraded,
}

#[derive(Serialize, Clone, Debug)]
pub struct SecretStatus {
    pub backend: SecretBackend,
    pub degraded: bool,
    /// Human-readable, path-free, and never containing a secret.
    pub reason: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SecretWriteResult {
    pub backend: SecretBackend,
    /// False only in Degraded_Secret_Mode: the value is held for this process
    /// and will not survive a restart, and the renderer says so.
    pub durable: bool,
}

/// How a status change reaches the renderer.
///
/// A callback rather than a `tauri::AppHandle` on the vault, for two reasons.
/// The vault is constructed and exercised in `cargo test` where there is no app
/// handle to hand it, and the emit is one line the shell owns — `lib.rs` decides
/// the event name, this module decides *when* there is something to say.
pub type StatusPublisher = Box<dyn Fn(&SecretStatus) + Send + Sync>;

/// The single event the renderer subscribes to for backend changes (R14.8).
pub const STATUS_EVENT: &str = "secrets://status";

/// The one thing an unauthenticated caller of `runtime_secret_get` learns.
const UNAUTHORIZED: &str = "unauthorized";

// ── Errors ────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("keychain handle unavailable")]
    Handle,
    #[error("keychain write failed")]
    Write,
    #[error("keychain read failed")]
    Read,
    /// The write returned `Ok` and an immediate read through a fresh handle
    /// found nothing. This is the Linux session-keyring case and the exact
    /// reason the probe exists rather than trusting the write's return value.
    #[error("keychain entry vanished immediately after a successful write")]
    Vanished,
    /// The write returned `Ok` and the read returned a different value.
    #[error("keychain read back a different value than was written")]
    Mismatch,
}

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault file is not readable")]
    Io,
    #[error("vault file is not a Zoc vault")]
    BadMagic,
    #[error("vault format version {0} is not supported")]
    BadVersion(u16),
    #[error("vault key-derivation id {0} is not supported")]
    BadKdf(u16),
    /// The header's Argon2 parameters are outside the range this build accepts.
    /// Refused before any derivation is attempted, so an attacker-chosen memory
    /// cost is never allocated.
    #[error("vault key-derivation parameters are outside the accepted range")]
    UnacceptableKdfParams,
    #[error("vault header is truncated")]
    Truncated,
    /// Deliberately opaque. A tampered vault must fail closed, and the error
    /// text is rendered to the user, so it carries no offsets, no lengths, and
    /// no fragment of plaintext (R14.6).
    #[error("vault could not be decrypted; it may have been modified")]
    Decrypt,
    #[error("vault contents are not valid JSON")]
    BadJson,
    #[error("no master secret is available")]
    NoMaster,
}

// ── Substitutable key store (R14.9, R22.4) ────────────────────────────────

/// The keychain operations the vault needs.
///
/// A trait purely so tests can substitute the backend: the `keyring` crate is
/// not injectable, and the behaviour that matters most — a session keyring that
/// accepts writes and then loses them — cannot be produced on demand against a
/// real secret service.
pub trait KeyStore: Send + Sync {
    fn set(&self, key: &str, value: &str) -> Result<(), KeychainError>;
    /// `Ok(None)` means "no such entry", which is distinct from an error.
    fn get(&self, key: &str) -> Result<Option<String>, KeychainError>;
    fn delete(&self, key: &str) -> Result<(), KeychainError>;
}

/// Production implementation over `keyring::Entry`.
pub struct SystemKeyStore;

impl KeyStore for SystemKeyStore {
    fn set(&self, key: &str, value: &str) -> Result<(), KeychainError> {
        Entry::new(SERVICE, key)
            .map_err(|_| KeychainError::Handle)?
            .set_password(value)
            .map_err(|_| KeychainError::Write)
    }

    fn get(&self, key: &str) -> Result<Option<String>, KeychainError> {
        // A *fresh* handle on every read. This is the crux of the durability
        // probe: a `keyring` handle can serve a read from its own in-process
        // state, so reading back through the writing handle proves nothing about
        // what the secret service actually persisted.
        let entry = Entry::new(SERVICE, key).map_err(|_| KeychainError::Handle)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(KeychainError::Read),
        }
    }

    fn delete(&self, key: &str) -> Result<(), KeychainError> {
        let entry = Entry::new(SERVICE, key).map_err(|_| KeychainError::Handle)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(KeychainError::Write),
        }
    }
}

/// Write then confirm through a fresh handle before reporting success (R14.4).
pub fn keychain_set_verified(
    store: &dyn KeyStore,
    key: &str,
    value: &str,
) -> Result<(), KeychainError> {
    store.set(key, value)?;
    match store.get(key) {
        Ok(Some(read_back)) if read_back == value => Ok(()),
        Ok(Some(_)) => Err(KeychainError::Mismatch),
        Ok(None) => Err(KeychainError::Vanished),
        Err(err) => Err(err),
    }
}

// ── Vault file ────────────────────────────────────────────────────────────

fn zoc_dir() -> std::path::PathBuf {
    // Resolution only — nothing is created here. `vault_path()` is called during
    // construction, including on the path into Degraded_Secret_Mode, and tier 3
    // is specified to touch the filesystem not at all (R14.7).
    //
    // `dirs::home_dir()` respects `$HOME` on Unix, which is what lets the tests
    // run against a temp HOME and never touch a developer's real keychain.
    dirs::home_dir()
        .map(|home| home.join(".zoc-studio"))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn vault_path() -> std::path::PathBuf {
    zoc_dir().join("secrets.vault")
}

/// Create `dir` if it is missing, owner-only from the moment it exists.
///
/// The mode is applied by the creating call rather than by a following
/// `set_permissions`, because the two-step version leaves a window in which the
/// directory is group- and world-readable under a permissive umask. 0700 does
/// not carry the vault's confidentiality — the file is encrypted — but a
/// readable directory still discloses which providers a user has configured.
fn ensure_dir_owner_only(dir: &std::path::Path) -> Result<(), VaultError> {
    if dir.as_os_str().is_empty() {
        return Ok(());
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir).map_err(|_| VaultError::Io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // A directory that already existed keeps whatever mode it was created
        // with, so it is tightened here too.
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn random_bytes(len: usize) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    let mut buffer = Zeroizing::new(vec![0u8; len]);
    getrandom::getrandom(&mut buffer).map_err(|_| VaultError::Io)?;
    Ok(buffer)
}

fn derive_file_key(
    master: &[u8],
    salt: &[u8],
    m_kib: u32,
    t: u32,
    p: u32,
) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let params =
        Params::new(m_kib, t, p, Some(32)).map_err(|_| VaultError::UnacceptableKdfParams)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(master, salt, out.as_mut())
        .map_err(|_| VaultError::Decrypt)?;
    Ok(out)
}

struct VaultHeader {
    m_kib: u32,
    t: u32,
    p: u32,
    salt: [u8; SALT_LEN],
    nonce: [u8; NONCE_LEN],
    aad: [u8; AAD_LEN],
    ct_len: usize,
}

fn parse_header(bytes: &[u8]) -> Result<VaultHeader, VaultError> {
    if bytes.len() < HEADER_LEN {
        return Err(VaultError::Truncated);
    }
    if &bytes[0..8] != MAGIC {
        return Err(VaultError::BadMagic);
    }
    let version = u16::from_le_bytes([bytes[8], bytes[9]]);
    if version != VAULT_VERSION {
        return Err(VaultError::BadVersion(version));
    }
    let kdf = u16::from_le_bytes([bytes[10], bytes[11]]);
    if kdf != KDF_ARGON2ID {
        return Err(VaultError::BadKdf(kdf));
    }

    let m_kib = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]);
    let t = u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let p = u32::from_le_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    // Checked before the salt is even read, so no derivation is attempted at a
    // memory or time cost this file chose.
    if m_kib < ARGON2_MIN_M_KIB
        || m_kib > ARGON2_MAX_M_KIB
        || t < ARGON2_MIN_T
        || t > ARGON2_MAX_T
        || p != ARGON2_P
    {
        return Err(VaultError::UnacceptableKdfParams);
    }

    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&bytes[24..24 + SALT_LEN]);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&bytes[40..40 + NONCE_LEN]);
    let mut aad = [0u8; AAD_LEN];
    aad.copy_from_slice(&bytes[0..AAD_LEN]);
    let ct_len = u32::from_le_bytes([bytes[64], bytes[65], bytes[66], bytes[67]]) as usize;

    if bytes.len() < HEADER_LEN + ct_len {
        return Err(VaultError::Truncated);
    }
    Ok(VaultHeader {
        m_kib,
        t,
        p,
        salt,
        nonce,
        aad,
        ct_len,
    })
}

fn read_vault(
    path: &std::path::Path,
    master: &[u8],
) -> Result<HashMap<String, Zeroizing<String>>, VaultError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => return Err(VaultError::Io),
    };
    let header = parse_header(&bytes)?;
    let ciphertext = &bytes[HEADER_LEN..HEADER_LEN + header.ct_len];

    // Derived with the header's own parameters, which the header's presence in
    // the AAD makes as trustworthy as the ciphertext itself: a modified
    // parameter simply fails to authenticate.
    let file_key = derive_file_key(master, &header.salt, header.m_kib, header.t, header.p)?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(file_key.as_ref()).map_err(|_| VaultError::Decrypt)?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&header.nonce),
                Payload {
                    msg: ciphertext,
                    aad: &header.aad,
                },
            )
            .map_err(|_| VaultError::Decrypt)?,
    );

    let raw: HashMap<String, String> =
        serde_json::from_slice(&plaintext).map_err(|_| VaultError::BadJson)?;
    Ok(raw
        .into_iter()
        .map(|(k, v)| (k, Zeroizing::new(v)))
        .collect())
}

fn write_vault(
    path: &std::path::Path,
    master: &[u8],
    entries: &HashMap<String, Zeroizing<String>>,
) -> Result<(), VaultError> {
    let plain: HashMap<&str, &str> = entries
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let plaintext = Zeroizing::new(serde_json::to_vec(&plain).map_err(|_| VaultError::BadJson)?);

    // A fresh salt on every write, not just on vault creation. It costs one
    // Argon2 derivation per save and removes the question of whether an
    // attacker who saw an earlier vault gains anything from a later one.
    let salt = random_bytes(SALT_LEN)?;
    let nonce = random_bytes(NONCE_LEN)?;

    let mut header = [0u8; AAD_LEN];
    header[0..8].copy_from_slice(MAGIC);
    header[8..10].copy_from_slice(&VAULT_VERSION.to_le_bytes());
    header[10..12].copy_from_slice(&KDF_ARGON2ID.to_le_bytes());
    header[12..16].copy_from_slice(&ARGON2_M_KIB.to_le_bytes());
    header[16..20].copy_from_slice(&ARGON2_T.to_le_bytes());
    header[20..24].copy_from_slice(&ARGON2_P.to_le_bytes());
    header[24..24 + SALT_LEN].copy_from_slice(&salt);
    header[40..40 + NONCE_LEN].copy_from_slice(&nonce);

    // Writing always uses this build's parameters, never a value read back from
    // a file, so the cost of a vault on disk only ever goes up.
    let file_key = derive_file_key(master, &salt, ARGON2_M_KIB, ARGON2_T, ARGON2_P)?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(file_key.as_ref()).map_err(|_| VaultError::Decrypt)?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &header,
            },
        )
        .map_err(|_| VaultError::Decrypt)?;

    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&(ciphertext.len() as u32).to_le_bytes());
    out.extend_from_slice(&ciphertext);

    if let Some(parent) = path.parent() {
        ensure_dir_owner_only(parent)?;
    }

    // Temp → fsync → rename. A crash mid-write leaves the previous vault
    // intact; writing in place would leave a half-encrypted file that fails to
    // open, which loses every key rather than the one being saved.
    let tmp = path.with_extension("vault.tmp");
    {
        // A stale temp file from an interrupted write would otherwise be reused
        // along with whatever mode it was created under, so it goes first and
        // the mode is set by the create rather than after it.
        let _ = std::fs::remove_file(&tmp);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp).map_err(|_| VaultError::Io)?;
        file.write_all(&out).map_err(|_| VaultError::Io)?;
        file.sync_all().map_err(|_| VaultError::Io)?;
    }
    std::fs::rename(&tmp, path).map_err(|_| VaultError::Io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    // Sync the directory as well, so the rename itself is durable and not just
    // the bytes it points at. Best-effort: not every platform permits it.
    if let Some(parent) = path.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

// ── The vault ─────────────────────────────────────────────────────────────

pub struct SecretVault {
    store: Box<dyn KeyStore>,
    backend: Mutex<SecretBackend>,
    reason: Mutex<Option<String>>,
    /// Tier 2's file key material, resolved once at boot.
    master: Mutex<Option<Zeroizing<Vec<u8>>>>,
    /// Tier 3. Zeroised on drop; nothing here reaches disk (R14.7).
    degraded: Mutex<HashMap<String, Zeroizing<String>>>,
    path: std::path::PathBuf,
    /// Installed by the shell once there is a window to emit to.
    publisher: Mutex<Option<StatusPublisher>>,
    /// The last status handed to the publisher, so a tier that has not moved
    /// does not re-announce itself on every save. The renderer renders a
    /// persistent strip off this event; a repeat is a re-render for nothing.
    published: Mutex<Option<(SecretBackend, Option<String>)>>,
}

impl SecretVault {
    /// Construct and run the boot-time probe.
    ///
    /// The probe runs at construction rather than on first save, so the degraded
    /// state is known *before* the user types a key. Discovering it on first
    /// save means the user has already committed a secret to a backend the app
    /// then has to admit it cannot keep.
    pub fn new(store: Box<dyn KeyStore>) -> Self {
        let vault = Self {
            store,
            backend: Mutex::new(SecretBackend::Keychain),
            reason: Mutex::new(None),
            master: Mutex::new(None),
            degraded: Mutex::new(HashMap::new()),
            path: vault_path(),
            publisher: Mutex::new(None),
            published: Mutex::new(None),
        };
        vault.probe_backend();
        vault
    }

    pub fn system() -> Self {
        Self::new(Box::new(SystemKeyStore))
    }

    fn probe_backend(&self) {
        // Tier 1 is proven by probing a disposable canary rather than a real
        // key: probing with a real key would mean writing a secret to a backend
        // we have not yet established is durable.
        let canary = "vault.probe";
        let canary_value = "zoc-durability-probe";
        let failure = match keychain_set_verified(self.store.as_ref(), canary, canary_value) {
            Ok(()) => {
                let _ = self.store.delete(canary);
                self.note_backend(SecretBackend::Keychain, None);
                return;
            }
            Err(err) => {
                // A failed probe can still have left the canary behind — a
                // `Mismatch` means something was stored — so it is cleaned up on
                // this path too rather than only on success.
                let _ = self.store.delete(canary);
                err
            }
        };

        // Tier 2 needs a master secret the keychain *does* hold across launches.
        // On the observed Linux failure mode a real keyring keeps one entry
        // while the session ring loses the rest, which is exactly why the master
        // secret is worth trying after the canary failed.
        match self.resolve_master() {
            Ok(master) => {
                *self.master.lock() = Some(master);
                self.note_backend(
                    SecretBackend::Vault,
                    Some(describe_keychain_failure(&failure, SecretBackend::Vault)),
                );
            }
            Err(_) => self.note_backend(
                SecretBackend::Degraded,
                Some(describe_keychain_failure(&failure, SecretBackend::Degraded)),
            ),
        }
    }

    fn resolve_master(&self) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        if let Ok(Some(existing)) = self.store.get(MASTER_KEY_NAME) {
            if let Some(bytes) = decode_master(&existing) {
                return Ok(bytes);
            }
        }
        let fresh = random_bytes(MASTER_SECRET_BYTES)?;
        let encoded = encode_master(&fresh);
        // The master secret is itself subject to the durability probe: a master
        // that vanishes makes tier 2 unopenable on the next launch, which is
        // worse than never having used it.
        keychain_set_verified(self.store.as_ref(), MASTER_KEY_NAME, &encoded)
            .map_err(|_| VaultError::NoMaster)?;
        Ok(fresh)
    }

    pub fn backend(&self) -> SecretBackend {
        *self.backend.lock()
    }

    pub fn degraded_reason(&self) -> Option<String> {
        self.reason.lock().clone()
    }

    pub fn status(&self) -> SecretStatus {
        let backend = self.backend();
        SecretStatus {
            backend,
            degraded: backend == SecretBackend::Degraded,
            reason: self.degraded_reason(),
        }
    }

    /// Install the `secrets://status` publisher and announce the probed state
    /// once (R14.8).
    ///
    /// The initial announcement is unconditional rather than change-gated: the
    /// boot probe already ran inside `new()`, before the shell had anywhere to
    /// emit to, so without one forced publish here a machine that booted
    /// straight into Degraded_Secret_Mode would never emit at all — its status
    /// never *changes*, and "nothing changed" and "nothing to report" would be
    /// indistinguishable to a subscriber.
    pub fn set_status_publisher(&self, publisher: StatusPublisher) {
        *self.publisher.lock() = Some(publisher);
        self.publish_status(true);
    }

    /// Emit the current status, skipping a repeat of what was last emitted
    /// unless `force`.
    fn publish_status(&self, force: bool) {
        let status = self.status();
        {
            let fingerprint = (status.backend, status.reason.clone());
            let mut last = self.published.lock();
            if !force && last.as_ref() == Some(&fingerprint) {
                return;
            }
            *last = Some(fingerprint);
        }
        // The `published` guard is released before the callback runs. The
        // callback is the shell's Tauri emit today, and holding a vault lock
        // across a call into someone else's code is how a non-reentrant mutex
        // deadlocks the next time that code grows a status query.
        if let Some(publisher) = self.publisher.lock().as_ref() {
            publisher(&status);
        }
    }

    /// Record which tier is answering now, and emit if that is news.
    fn note_backend(&self, backend: SecretBackend, reason: Option<String>) {
        {
            let mut current = self.backend.lock();
            let mut current_reason = self.reason.lock();
            if *current == backend && *current_reason == reason {
                return;
            }
            *current = backend;
            *current_reason = reason;
        }
        self.publish_status(false);
    }

    /// Store `key`, escalating down the tiers until one reports durable success.
    ///
    /// Every escalation is also a status change, and each one publishes
    /// `secrets://status` (R14.8). The boot probe is not the only way a machine
    /// arrives in a lower tier — a keychain can go away mid-session, and a user
    /// whose keys stopped being durable at 11am should not have to restart the
    /// app to be told.
    pub fn set(&self, key: &str, value: &str) -> Result<SecretWriteResult, String> {
        let failure = match keychain_set_verified(self.store.as_ref(), key, value) {
            Ok(()) => {
                // Tier 1 demonstrably works for this write, so a stale lower-tier
                // label and its notice are withdrawn. A notice that outlives the
                // condition it describes is the same defect as a missing one: it
                // tells the user their keys are not durable when they are.
                self.note_backend(SecretBackend::Keychain, None);
                return Ok(SecretWriteResult {
                    backend: SecretBackend::Keychain,
                    durable: true,
                });
            }
            Err(err) => err,
        };

        // Hoisted out of the `if let` so the guard is released here rather than
        // at the end of the branch: the branch now publishes a status event, and
        // running a subscriber's callback while holding a vault lock is a
        // deadlock waiting for a subscriber that asks the vault a question.
        let master = self.master.lock().clone();
        if let Some(master) = master {
            // A vault that exists but will not open is not written over. Merging
            // into an empty map instead — which is what a `unwrap_or_default()`
            // here would do — replaces every other stored key with the one being
            // saved and destroys the evidence of whatever modified the file. A
            // tampered vault fails closed on the write path too (R14.6).
            //
            // A *missing* file is not that case: `read_vault` reports it as an
            // empty vault, so the first save still works.
            let mut entries = match read_vault(&self.path, &master) {
                Ok(entries) => entries,
                Err(err) => return Err(err.to_string()),
            };
            entries.insert(key.to_string(), Zeroizing::new(value.to_string()));
            match write_vault(&self.path, &master, &entries) {
                Ok(()) => {
                    self.note_backend(
                        SecretBackend::Vault,
                        Some(describe_keychain_failure(&failure, SecretBackend::Vault)),
                    );
                    return Ok(SecretWriteResult {
                        backend: SecretBackend::Vault,
                        durable: true,
                    });
                }
                Err(err) => return Err(err.to_string()),
            }
        }

        self.degraded
            .lock()
            .insert(key.to_string(), Zeroizing::new(value.to_string()));
        self.note_backend(
            SecretBackend::Degraded,
            Some(describe_keychain_failure(&failure, SecretBackend::Degraded)),
        );
        Ok(SecretWriteResult {
            backend: SecretBackend::Degraded,
            durable: false,
        })
    }

    /// Read `key` from whichever tier holds it.
    ///
    /// Every tier is consulted regardless of the current `backend` label,
    /// because the label describes where writes go *now* and a key may have been
    /// written before a backend change. Trusting the label here is how a user
    /// loses a key that is sitting on disk.
    pub fn get(&self, key: &str) -> Option<Zeroizing<String>> {
        if let Ok(Some(value)) = self.store.get(key) {
            if !value.is_empty() {
                return Some(Zeroizing::new(value));
            }
        }
        if let Some(master) = self.master.lock().clone() {
            if let Ok(entries) = read_vault(&self.path, &master) {
                if let Some(value) = entries.get(key) {
                    return Some(value.clone());
                }
            }
        }
        self.degraded.lock().get(key).cloned()
    }

    pub fn has(&self, key: &str) -> bool {
        self.get(key).map(|v| !v.is_empty()).unwrap_or(false)
    }

    /// Clear from **all three tiers** (R14.1).
    ///
    /// Clearing only the active tier is the bug this signature exists to
    /// prevent: a key cleared from the keychain while a copy sits in the vault
    /// reappears the moment the keychain misses, and a user who cleared a
    /// credential is entitled to have it stay cleared.
    pub fn clear(&self, key: &str) -> Result<(), String> {
        let mut first_error: Option<String> = None;

        if let Err(err) = self.store.delete(key) {
            first_error = Some(err.to_string());
        }

        if let Some(master) = self.master.lock().clone() {
            match read_vault(&self.path, &master) {
                Ok(mut entries) => {
                    if entries.remove(key).is_some() {
                        if let Err(err) = write_vault(&self.path, &master, &entries) {
                            first_error = first_error.or(Some(err.to_string()));
                        }
                    }
                }
                // Recorded rather than swallowed, and the file is left alone for
                // the same reason `set` leaves it alone. A key inside a vault
                // that will not open cannot resurface, which is why the closing
                // match can still report success.
                Err(err) => first_error = first_error.or(Some(err.to_string())),
            }
        }

        self.degraded.lock().remove(key);

        match first_error {
            // A keychain that has no entry to delete is not a failure to clear.
            Some(_) if !self.has(key) => Ok(()),
            Some(err) => Err(err),
            None => Ok(()),
        }
    }
}

/// The user-facing explanation for a keychain failure.
///
/// Path-free and secret-free, because this string is what the renderer's notice
/// renders (R14.8): it names no file, no key, and no value, and it is built from
/// fixed sentences rather than from anything an OS error carried.
///
/// Two clauses — what the OS did, and what Zoc AI did about it — and the second
/// depends on which tier actually took over. A degraded machine told "using its
/// own encrypted store instead" would be told the opposite of the truth, and the
/// notice R14.8 asks for is exactly the one that has to say keys do not survive
/// exit.
fn describe_keychain_failure(err: &KeychainError, fallback: SecretBackend) -> String {
    let cause = match err {
        KeychainError::Vanished => "The system keychain accepted the key but did not keep it",
        KeychainError::Mismatch => {
            "The system keychain returned a different value than was written"
        }
        KeychainError::Handle | KeychainError::Write | KeychainError::Read => {
            "The system keychain is unavailable"
        }
    };
    let consequence = match fallback {
        // `Keychain` cannot reach here in practice — there is no failure to
        // describe when tier 1 worked — and it shares the vault wording rather
        // than getting an `unreachable!()`, because a panic inside a status
        // string is a worse outcome than a slightly generic sentence.
        SecretBackend::Keychain | SecretBackend::Vault => {
            "so Zoc AI is using its own encrypted store instead."
        }
        SecretBackend::Degraded => {
            "and Zoc AI has no durable place to keep keys, so saved keys are cleared when \
             the app exits."
        }
    };
    format!("{cause}, {consequence}")
}

/// Master secret ↔ keychain string. Hex, because a keychain entry is a string
/// and hex round-trips through every platform backend without encoding surprises.
///
/// The encoding is a `Zeroizing<String>` written into one exactly-sized buffer:
/// the obvious `map(|b| format!(…)).collect()` leaves one two-nibble `String`
/// per byte of the master secret behind for the allocator to hand out again.
fn encode_master(bytes: &[u8]) -> Zeroizing<String> {
    use std::fmt::Write as _;
    let mut out = Zeroizing::new(String::with_capacity(bytes.len() * 2));
    for byte in bytes {
        let _ = write!(&mut *out, "{byte:02x}");
    }
    out
}

fn decode_master(text: &str) -> Option<Zeroizing<Vec<u8>>> {
    if text.len() != MASTER_SECRET_BYTES * 2 {
        return None;
    }
    let mut out = Zeroizing::new(Vec::with_capacity(MASTER_SECRET_BYTES));
    let chars: Vec<char> = text.chars().collect();
    for pair in chars.chunks(2) {
        let hex: String = pair.iter().collect();
        out.push(u8::from_str_radix(&hex, 16).ok()?);
    }
    Some(out)
}

// ── Commands ──────────────────────────────────────────────────────────────

/// **Retained until task 26.2 only.**
///
/// The Legacy_Panel's `ModelPicker.tsx` reads through `secureStore.get` for its
/// key badge. Removing this command — or revoking its capability — before the
/// panel is deleted makes the legacy cloud-provider gate report "no key" for
/// every provider on every mid-cutover build. R14.2 is conventional until the
/// allowlist edit lands with the deletion, and structural after it.
#[tauri::command]
pub fn secret_get(
    key: String,
    state: tauri::State<'_, Arc<SecretVault>>,
) -> Result<Option<String>, String> {
    Ok(state.get(&key).map(|v| v.to_string()))
}

#[tauri::command]
pub fn secret_set(
    key: String,
    value: String,
    state: tauri::State<'_, Arc<SecretVault>>,
) -> Result<SecretWriteResult, String> {
    state.set(&key, &value)
}

#[tauri::command]
pub fn secret_clear(key: String, state: tauri::State<'_, Arc<SecretVault>>) -> Result<(), String> {
    state.clear(&key)
}

/// What replaces `secret_get` for the renderer (R14.2).
#[tauri::command]
pub fn secret_has(key: String, state: tauri::State<'_, Arc<SecretVault>>) -> bool {
    state.has(&key)
}

/// The query half of the R14.8 signal. The push half is `secrets://status`,
/// published by `set_status_publisher`'s callback whenever the answer to this
/// question changes — the renderer needs both, because a subscriber that mounts
/// after boot has missed the first announcement and a poller alone would only
/// notice a mid-session change on its next poll.
#[tauri::command]
pub fn secret_backend_status(state: tauri::State<'_, Arc<SecretVault>>) -> SecretStatus {
    state.status()
}

/// Key resolution for the Agent_Runtime only (R14.10).
///
/// Two independent things keep the renderer out. The capability set omits it, so
/// the IPC layer refuses the invoke before this function is entered — that is the
/// structural half, asserted by `tests/capability_allowlist.rs`. And the
/// per-launch bearer token is compared in constant time, which is the half that
/// still holds if the capability is ever edited by mistake.
///
/// The Agent_Runtime is a separate OS process and reaches Desktop_Core over the
/// loopback bridge in `runtime_bridge.rs`, not over Tauri IPC, so nothing
/// legitimate loses anything by the capability omission.
#[tauri::command]
pub fn runtime_secret_get(
    key: String,
    token: String,
    vault: tauri::State<'_, Arc<SecretVault>>,
    runtime: tauri::State<'_, Arc<crate::sidecar::AgentRuntimeSupervisor>>,
) -> Result<Option<String>, String> {
    runtime_secret_lookup(vault.inner(), runtime.inner(), &key, &token)
}

/// The body of `runtime_secret_get`, lifted out of the command so the
/// authorization decision is testable without a Tauri `State`.
fn runtime_secret_lookup(
    vault: &SecretVault,
    runtime: &crate::sidecar::AgentRuntimeSupervisor,
    key: &str,
    token: &str,
) -> Result<Option<String>, String> {
    // Refused before the vault is touched, so a wrong token cannot even produce
    // a timing signal about whether the key exists.
    if !runtime.token_matches(token) {
        // No detail about why, and no echo of the key name: a caller that guessed
        // wrong learns only that it was wrong.
        return Err(UNAUTHORIZED.to_string());
    }
    Ok(vault.get(key).map(|v| v.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Models the observed broken-Linux secret service: a write returns `Ok`
    /// and an immediate read through a fresh handle finds nothing.
    ///
    /// The earlier draft of this fake stored session writes and answered reads
    /// from them, which made tier 1's probe *pass* — and that is not the failure
    /// R14.9 is about. A backend that answers reads correctly and only loses
    /// data at logout is undetectable by any probe; what the probe can and does
    /// catch is the ring that never really took the write, which is the case
    /// that actually occurs. `persist_keys` names the entries a real keyring
    /// alongside the session ring *does* keep — in practice the master secret —
    /// which is what makes tier 2 reachable at all.
    struct SessionKeyStore {
        persistent: Arc<Mutex<HashMap<String, String>>>,
        persist_keys: Vec<String>,
        /// Writes that were accepted and then lost, recorded so a test can
        /// assert the fake was actually exercised.
        vanished: Mutex<Vec<String>>,
    }

    impl SessionKeyStore {
        fn new(persistent: Arc<Mutex<HashMap<String, String>>>, persist: &[&str]) -> Self {
            Self {
                persistent,
                persist_keys: persist.iter().map(|s| s.to_string()).collect(),
                vanished: Mutex::new(Vec::new()),
            }
        }

        fn is_persistent(&self, key: &str) -> bool {
            self.persist_keys.iter().any(|k| k == key)
        }
    }

    impl KeyStore for SessionKeyStore {
        fn set(&self, key: &str, value: &str) -> Result<(), KeychainError> {
            if self.is_persistent(key) {
                self.persistent.lock().insert(key.into(), value.into());
            } else {
                // Accepted, and lost. No error — that is the whole problem.
                self.vanished.lock().push(key.into());
            }
            Ok(())
        }

        fn get(&self, key: &str) -> Result<Option<String>, KeychainError> {
            Ok(self.persistent.lock().get(key).cloned())
        }

        fn delete(&self, key: &str) -> Result<(), KeychainError> {
            self.persistent.lock().remove(key);
            Ok(())
        }
    }

    /// No secret service at all.
    struct FailingKeyStore;

    impl KeyStore for FailingKeyStore {
        fn set(&self, _: &str, _: &str) -> Result<(), KeychainError> {
            Err(KeychainError::Write)
        }
        fn get(&self, _: &str) -> Result<Option<String>, KeychainError> {
            Err(KeychainError::Read)
        }
        fn delete(&self, _: &str) -> Result<(), KeychainError> {
            Err(KeychainError::Write)
        }
    }

    /// Returns `Ok` from `set` and `NoEntry` from `get` — the vanishing write.
    struct WriteOnlyKeyStore;

    impl KeyStore for WriteOnlyKeyStore {
        fn set(&self, _: &str, _: &str) -> Result<(), KeychainError> {
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Option<String>, KeychainError> {
            Ok(None)
        }
        fn delete(&self, _: &str) -> Result<(), KeychainError> {
            Ok(())
        }
    }

    /// An in-memory store that behaves like a healthy keychain.
    struct GoodKeyStore {
        entries: Arc<Mutex<HashMap<String, String>>>,
    }

    /// A keychain that can be broken and healed *while the app is running*.
    ///
    /// Healthy it behaves like a working secret service; broken it accepts a
    /// write and loses it — the vanishing write again, but arriving after boot.
    /// That is the case the boot probe cannot catch and the `secrets://status`
    /// event exists for: a user whose keychain went away at 11am should not have
    /// to restart the app to be told their keys stopped being durable.
    struct FlakyKeyStore {
        entries: Arc<Mutex<HashMap<String, String>>>,
        healthy: Arc<Mutex<bool>>,
    }

    impl KeyStore for FlakyKeyStore {
        fn set(&self, key: &str, value: &str) -> Result<(), KeychainError> {
            if *self.healthy.lock() {
                self.entries.lock().insert(key.into(), value.into());
            }
            // Broken: accepted, and lost. No error — that is the whole problem.
            Ok(())
        }
        fn get(&self, key: &str) -> Result<Option<String>, KeychainError> {
            Ok(self.entries.lock().get(key).cloned())
        }
        fn delete(&self, key: &str) -> Result<(), KeychainError> {
            self.entries.lock().remove(key);
            Ok(())
        }
    }

    impl KeyStore for GoodKeyStore {
        fn set(&self, key: &str, value: &str) -> Result<(), KeychainError> {
            self.entries.lock().insert(key.into(), value.into());
            Ok(())
        }
        fn get(&self, key: &str) -> Result<Option<String>, KeychainError> {
            Ok(self.entries.lock().get(key).cloned())
        }
        fn delete(&self, key: &str) -> Result<(), KeychainError> {
            self.entries.lock().remove(key);
            Ok(())
        }
    }

    /// Run `body` with `HOME` pointed at a fresh temp dir.
    ///
    /// Serialised behind a mutex because `set_var` is process-global: two tests
    /// mutating `HOME` concurrently would each see the other's vault.
    fn with_temp_home<T>(body: impl FnOnce(&std::path::Path) -> T) -> T {
        static HOME_LOCK: Mutex<()> = Mutex::new(());
        let _guard = HOME_LOCK.lock();
        let dir = tempfile::tempdir().expect("temp home");
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", dir.path());
        let result = body(dir.path());
        match previous {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        result
    }

    #[test]
    fn session_keyring_cleared_between_launches_still_returns_keys() {
        // R14.9
        with_temp_home(|home| {
            let persistent = Arc::new(Mutex::new(HashMap::new()));

            // Two independent `SecretVault` constructions over the same temp
            // HOME and the same persistent ring model two app launches with a
            // session-keyring wipe in between: nothing carries over in memory,
            // and only the master secret carries over in the keyring.
            let first = SecretVault::new(Box::new(SessionKeyStore::new(
                persistent.clone(),
                &[MASTER_KEY_NAME],
            )));
            assert_eq!(
                first.backend(),
                SecretBackend::Vault,
                "a vanishing session ring must drop the vault to tier 2, not tier 1"
            );
            first
                .set("provider.openai", "sk-openai-value")
                .expect("set");
            first
                .set("provider.anthropic", "sk-anthropic-value")
                .expect("set");
            drop(first);

            let relaunched = SecretVault::new(Box::new(SessionKeyStore::new(
                persistent.clone(),
                &[MASTER_KEY_NAME],
            )));
            assert_eq!(
                relaunched.get("provider.openai").map(|v| v.to_string()),
                Some("sk-openai-value".to_string()),
                "a key must survive a cleared session keyring"
            );
            assert_eq!(
                relaunched.get("provider.anthropic").map(|v| v.to_string()),
                Some("sk-anthropic-value".to_string())
            );
            assert!(
                home.join(".zoc-studio").join("secrets.vault").exists(),
                "tier 2 must have written the encrypted vault"
            );
        });
    }

    #[test]
    fn no_secret_service_enters_degraded_mode() {
        // R14.7
        with_temp_home(|home| {
            let vault = SecretVault::new(Box::new(FailingKeyStore));
            assert_eq!(vault.backend(), SecretBackend::Degraded);

            let result = vault.set("provider.groq", "gsk-value").expect("set");
            assert_eq!(result.backend, SecretBackend::Degraded);
            assert!(!result.durable, "degraded mode must not claim durability");
            assert_eq!(
                vault.get("provider.groq").map(|v| v.to_string()),
                Some("gsk-value".to_string()),
                "degraded mode must still round-trip within the process"
            );

            // Nothing on disk means nothing at all, not just no vault file: the
            // app directory itself is only created when tier 2 has something to
            // write into it.
            assert!(
                !home.join(".zoc-studio").exists(),
                "degraded mode must write nothing to disk"
            );
            let status = vault.status();
            assert!(status.degraded);
            let reason = status.reason.expect("a degraded reason");
            assert!(!reason.contains('/'), "reason leaked a path: {reason}");
            assert!(!reason.contains("gsk-value"));
            // R14.8: the notice has to state the consequence, and the string the
            // renderer shows is this one.
            assert!(
                reason.contains("cleared when the app exits"),
                "a degraded reason must say keys do not survive exit: {reason}"
            );
        });
    }

    #[test]
    fn write_that_vanishes_fails_the_probe() {
        // R14.4
        with_temp_home(|_| {
            let err = keychain_set_verified(&WriteOnlyKeyStore, "provider.xai", "xai-value")
                .expect_err("a vanishing write must not report success");
            assert!(matches!(err, KeychainError::Vanished));

            // And the vault must fall through rather than reporting success on
            // tier 1: with no master secret obtainable either, that is tier 3.
            let vault = SecretVault::new(Box::new(WriteOnlyKeyStore));
            assert_ne!(vault.backend(), SecretBackend::Keychain);
            let result = vault.set("provider.xai", "xai-value").expect("set");
            assert_ne!(result.backend, SecretBackend::Keychain);
        });
    }

    #[test]
    fn tampered_vault_fails_closed() {
        // R14.6
        with_temp_home(|home| {
            let persistent = Arc::new(Mutex::new(HashMap::new()));
            let vault = SecretVault::new(Box::new(SessionKeyStore::new(
                persistent.clone(),
                &[MASTER_KEY_NAME],
            )));
            vault
                .set("provider.google", "goog-secret-value")
                .expect("set");

            let path = home.join(".zoc-studio").join("secrets.vault");
            let mut bytes = std::fs::read(&path).expect("vault written");
            assert!(bytes.len() > HEADER_LEN);
            // Flip one ciphertext byte.
            let last = bytes.len() - 1;
            bytes[last] ^= 0x01;
            std::fs::write(&path, &bytes).expect("tamper");

            let master = decode_master(
                persistent
                    .lock()
                    .get(MASTER_KEY_NAME)
                    .expect("master persisted"),
            )
            .expect("decode master");
            let err = read_vault(&path, &master).expect_err("a tampered vault must fail closed");
            let message = err.to_string();
            assert!(
                !message.contains("goog-secret-value"),
                "error leaked key material: {message}"
            );
            assert!(
                !message.contains(".zoc-studio"),
                "error leaked a path: {message}"
            );
        });
    }

    #[test]
    fn a_healthy_keychain_stays_on_tier_one_and_writes_no_file() {
        with_temp_home(|home| {
            let vault = SecretVault::new(Box::new(GoodKeyStore {
                entries: Arc::new(Mutex::new(HashMap::new())),
            }));
            assert_eq!(vault.backend(), SecretBackend::Keychain);
            let result = vault.set("provider.openai", "sk-v").expect("set");
            assert_eq!(result.backend, SecretBackend::Keychain);
            assert!(result.durable);
            assert!(!home.join(".zoc-studio").join("secrets.vault").exists());
        });
    }

    #[test]
    fn clear_removes_a_key_from_every_tier() {
        // R14.1. The bug this pins is specific: a key cleared from the keychain
        // while a copy sits in the vault reappears the moment the keychain
        // misses, because `get` deliberately consults every tier regardless of
        // which one is currently active. So the key is planted in all three and
        // all three are inspected afterwards — asserting only `get() == None`
        // would pass against a `clear` that emptied one tier and got lucky about
        // the read order.
        with_temp_home(|home| {
            let persistent = Arc::new(Mutex::new(HashMap::new()));
            let vault = SecretVault::new(Box::new(SessionKeyStore::new(
                persistent.clone(),
                &[MASTER_KEY_NAME],
            )));
            assert_eq!(vault.backend(), SecretBackend::Vault);

            // Tier 2: a real entry in the encrypted file.
            vault.set("provider.openai", "sk-vault").expect("set");
            let vault_file = home.join(".zoc-studio").join("secrets.vault");
            assert!(vault_file.exists(), "tier 2 must have written the vault");

            // Tier 1: planted straight into the ring the fake serves reads from,
            // which is the state a machine reaches when the keychain held the key
            // for a while and then stopped taking writes.
            persistent
                .lock()
                .insert("provider.openai".into(), "sk-keychain".into());

            // Tier 3: what a mid-session backend change leaves in memory.
            vault.degraded.lock().insert(
                "provider.openai".into(),
                Zeroizing::new("sk-degraded".into()),
            );

            vault.clear("provider.openai").expect("clear");

            assert!(!vault.has("provider.openai"));
            assert!(
                vault.get("provider.openai").is_none(),
                "a cleared key resurfaced from a lower tier"
            );
            assert!(
                persistent.lock().get("provider.openai").is_none(),
                "tier 1 still holds the cleared key"
            );
            let master =
                decode_master(persistent.lock().get(MASTER_KEY_NAME).expect("master")).unwrap();
            assert!(
                !read_vault(&vault_file, &master)
                    .expect("vault still opens")
                    .contains_key("provider.openai"),
                "tier 2 still holds the cleared key"
            );
            assert!(
                vault.degraded.lock().get("provider.openai").is_none(),
                "tier 3 still holds the cleared key"
            );
        });
    }

    #[test]
    fn a_tier_change_publishes_the_status_event() {
        // R14.8: the query answers a subscriber that asks; the event answers the
        // subscriber that already asked and needs to know the answer changed.
        with_temp_home(|_| {
            let entries = Arc::new(Mutex::new(HashMap::new()));
            let healthy = Arc::new(Mutex::new(true));
            let vault = SecretVault::new(Box::new(FlakyKeyStore {
                entries: entries.clone(),
                healthy: healthy.clone(),
            }));

            let seen: Arc<Mutex<Vec<SecretStatus>>> = Arc::new(Mutex::new(Vec::new()));
            {
                let seen = seen.clone();
                vault.set_status_publisher(Box::new(move |status| {
                    seen.lock().push(status.clone());
                }));
            }

            // Installing publishes the probed backend once. Without that forced
            // first emit a machine that booted straight into a lower tier would
            // never emit at all — its status never changes.
            assert_eq!(seen.lock().len(), 1, "install must announce once");
            assert_eq!(seen.lock()[0].backend, SecretBackend::Keychain);
            assert!(!seen.lock()[0].degraded);
            assert!(seen.lock()[0].reason.is_none());

            // A save on the tier already announced is not news.
            vault.set("provider.openai", "sk-1").expect("set");
            assert_eq!(
                seen.lock().len(),
                1,
                "an unchanged tier must not re-announce on every save"
            );

            // The keychain stops keeping writes mid-session.
            *healthy.lock() = false;
            let escalated = vault.set("provider.anthropic", "sk-2").expect("set");
            assert_eq!(escalated.backend, SecretBackend::Degraded);
            assert!(
                !escalated.durable,
                "degraded mode must not claim durability"
            );
            assert_eq!(seen.lock().len(), 2, "the escalation must be announced");
            let degraded = seen.lock()[1].clone();
            assert!(degraded.degraded);
            let reason = degraded.reason.expect("a degraded reason");
            assert!(
                reason.contains("cleared when the app exits"),
                "R14.8's notice needs the exit consequence: {reason}"
            );

            // And recovery is announced too, so a notice cannot outlive the
            // condition it describes.
            *healthy.lock() = true;
            vault.set("provider.groq", "gsk-1").expect("set");
            assert_eq!(seen.lock().len(), 3);
            assert_eq!(seen.lock()[2].backend, SecretBackend::Keychain);
            assert!(!seen.lock()[2].degraded);
            assert!(seen.lock()[2].reason.is_none());

            // Nothing published ever carries a value or a path.
            for status in seen.lock().iter() {
                let json = serde_json::to_string(status).expect("status serialises");
                assert!(!json.contains('/'), "status leaked a path: {json}");
                assert!(!json.contains("sk-"), "status leaked a value: {json}");
                assert!(!json.contains("gsk-1"), "status leaked a value: {json}");
            }
        });
    }

    #[test]
    fn the_runtime_secret_path_refuses_anything_but_the_launch_token() {
        // R14.10. The capability omission in `capabilities/default.json` is what
        // keeps the renderer out structurally — `tests/capability_allowlist.rs`
        // asserts that — and this is the half that still holds if the capability
        // is ever edited by mistake.
        with_temp_home(|_| {
            let vault = SecretVault::new(Box::new(GoodKeyStore {
                entries: Arc::new(Mutex::new(HashMap::new())),
            }));
            vault.set("provider.openai", "sk-real").expect("set");
            let runtime = crate::sidecar::AgentRuntimeSupervisor::default();

            // Before the handshake there is no held token, so an empty
            // credential must be a refusal rather than a vacuous match.
            assert_eq!(
                runtime_secret_lookup(&vault, &runtime, "provider.openai", "")
                    .expect_err("an absent held token must refuse"),
                UNAUTHORIZED
            );

            runtime.install_token_for_test("launch-token");
            for wrong in [
                "",
                "launch-toke",
                "launch-tokenn",
                "launch-token ",
                "LAUNCH-TOKEN",
            ] {
                let err = runtime_secret_lookup(&vault, &runtime, "provider.openai", wrong)
                    .expect_err("a wrong token must be refused");
                assert_eq!(err, UNAUTHORIZED, "the refusal says only that it was one");
                assert!(!err.contains("sk-real"));
                assert!(!err.contains("provider.openai"));
            }

            assert_eq!(
                runtime_secret_lookup(&vault, &runtime, "provider.openai", "launch-token")
                    .expect("the launch token is admitted"),
                Some("sk-real".to_string())
            );
            // An unconfigured key is `None`, not an error: "no key" and "not
            // allowed" are different facts and the runtime maps them differently.
            assert_eq!(
                runtime_secret_lookup(&vault, &runtime, "provider.nope", "launch-token")
                    .expect("authorised"),
                None
            );
        });
    }

    #[test]
    fn has_never_returns_true_for_an_empty_value() {
        with_temp_home(|_| {
            let vault = SecretVault::new(Box::new(GoodKeyStore {
                entries: Arc::new(Mutex::new(HashMap::new())),
            }));
            vault.set("provider.openai", "").expect("set");
            assert!(!vault.has("provider.openai"), "an empty key is not a key");
        });
    }

    #[test]
    fn the_header_is_authenticated_so_a_version_flip_fails() {
        with_temp_home(|home| {
            let persistent = Arc::new(Mutex::new(HashMap::new()));
            let vault = SecretVault::new(Box::new(SessionKeyStore::new(
                persistent.clone(),
                &[MASTER_KEY_NAME],
            )));
            vault.set("k", "v").expect("set");

            let path = home.join(".zoc-studio").join("secrets.vault");
            let mut bytes = std::fs::read(&path).expect("vault");
            // Flip the Argon2 memory parameter, which lives inside the AAD.
            bytes[12] ^= 0xff;
            std::fs::write(&path, &bytes).expect("tamper");

            let master =
                decode_master(persistent.lock().get(MASTER_KEY_NAME).expect("master")).unwrap();
            assert!(read_vault(&path, &master).is_err());
        });
    }

    #[test]
    fn master_secret_round_trips_through_hex() {
        let bytes = vec![0u8, 1, 15, 16, 127, 128, 254, 255];
        let encoded = encode_master(&bytes);
        assert_eq!(encoded.as_str(), "00010f107f80feff");
        // Length-checked: the decoder only accepts a full 32-byte secret.
        assert!(decode_master(&encoded).is_none());
        let full = vec![7u8; MASTER_SECRET_BYTES];
        assert_eq!(decode_master(&encode_master(&full)).unwrap().to_vec(), full);
    }

    #[test]
    fn a_missing_vault_reads_as_empty_rather_than_erroring() {
        with_temp_home(|home| {
            let master = vec![3u8; MASTER_SECRET_BYTES];
            let entries = read_vault(&home.join("nope.vault"), &master).expect("empty");
            assert!(entries.is_empty());
        });
    }

    #[test]
    fn a_truncated_vault_is_rejected() {
        with_temp_home(|home| {
            let path = home.join("short.vault");
            std::fs::write(&path, b"ZOCVAULT").expect("write");
            let master = vec![3u8; MASTER_SECRET_BYTES];
            assert!(matches!(
                read_vault(&path, &master),
                Err(VaultError::Truncated)
            ));
        });
    }

    #[test]
    fn a_foreign_file_is_rejected_by_magic() {
        with_temp_home(|home| {
            let path = home.join("foreign.vault");
            std::fs::write(&path, vec![0u8; 512]).expect("write");
            let master = vec![3u8; MASTER_SECRET_BYTES];
            assert!(matches!(
                read_vault(&path, &master),
                Err(VaultError::BadMagic)
            ));
        });
    }

    #[test]
    fn a_save_does_not_overwrite_a_vault_it_cannot_open() {
        // R14.6: failing closed applies to the write path too. Rewriting a vault
        // that will not decrypt would replace every key it holds with the one
        // being saved, and erase the evidence of whatever changed the file.
        with_temp_home(|home| {
            let persistent = Arc::new(Mutex::new(HashMap::new()));
            let vault = SecretVault::new(Box::new(SessionKeyStore::new(
                persistent.clone(),
                &[MASTER_KEY_NAME],
            )));
            vault.set("provider.openai", "sk-first").expect("set");

            let path = home.join(".zoc-studio").join("secrets.vault");
            let mut bytes = std::fs::read(&path).expect("vault written");
            let last = bytes.len() - 1;
            bytes[last] ^= 0x01;
            std::fs::write(&path, &bytes).expect("tamper");

            let err = vault
                .set("provider.anthropic", "sk-second")
                .expect_err("a save over an unopenable vault must not report success");
            assert!(!err.contains("sk-second"), "error leaked a value: {err}");
            assert!(!err.contains(".zoc-studio"), "error leaked a path: {err}");
            assert_eq!(
                std::fs::read(&path).expect("vault still there"),
                bytes,
                "the vault was rewritten instead of being left alone"
            );
        });
    }

    #[test]
    fn a_header_claiming_unacceptable_argon2_parameters_is_refused() {
        // Refused at the header, before any derivation: a file an attacker can
        // drop in the home directory must not get to choose how much memory the
        // reader allocates.
        with_temp_home(|home| {
            let persistent = Arc::new(Mutex::new(HashMap::new()));
            let vault = SecretVault::new(Box::new(SessionKeyStore::new(
                persistent.clone(),
                &[MASTER_KEY_NAME],
            )));
            vault.set("k", "v").expect("set");
            let path = home.join(".zoc-studio").join("secrets.vault");
            let original = std::fs::read(&path).expect("vault");
            let master =
                decode_master(persistent.lock().get(MASTER_KEY_NAME).expect("master")).unwrap();

            for m_kib in [8u32, 19_455, 4_000_000] {
                let mut bytes = original.clone();
                bytes[12..16].copy_from_slice(&m_kib.to_le_bytes());
                std::fs::write(&path, &bytes).expect("rewrite header");
                assert!(
                    matches!(
                        read_vault(&path, &master),
                        Err(VaultError::UnacceptableKdfParams)
                    ),
                    "m={m_kib} KiB was not refused at the header"
                );
            }
            // Time cost is bounded in both directions for the same reason.
            for t in [0u32, 1, u32::MAX] {
                let mut bytes = original.clone();
                bytes[16..20].copy_from_slice(&t.to_le_bytes());
                std::fs::write(&path, &bytes).expect("rewrite header");
                assert!(
                    matches!(
                        read_vault(&path, &master),
                        Err(VaultError::UnacceptableKdfParams)
                    ),
                    "t={t} was not refused at the header"
                );
            }

            // And the parameters this build writes are the ones the design
            // specifies, so the accepted case is the specified case.
            std::fs::write(&path, &original).expect("restore");
            let header = parse_header(&original).expect("header parses");
            assert_eq!((header.m_kib, header.t, header.p), (19_456, 2, 1));
        });
    }

    #[cfg(unix)]
    #[test]
    fn the_vault_and_its_directory_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        with_temp_home(|home| {
            let persistent = Arc::new(Mutex::new(HashMap::new()));
            let vault = SecretVault::new(Box::new(SessionKeyStore::new(
                persistent.clone(),
                &[MASTER_KEY_NAME],
            )));
            vault.set("provider.openai", "sk-v").expect("set");

            let dir = home.join(".zoc-studio");
            let mode = std::fs::metadata(&dir).expect("dir").permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "vault directory mode {:o}", mode);
            let file_mode = std::fs::metadata(dir.join("secrets.vault"))
                .expect("vault")
                .permissions()
                .mode();
            assert_eq!(file_mode & 0o777, 0o600, "vault file mode {:o}", file_mode);
            assert!(
                !dir.join("secrets.vault.tmp").exists(),
                "the temp file must not survive the write"
            );
        });
    }

    #[test]
    fn every_backend_label_serialises_snake_case() {
        assert_eq!(
            serde_json::to_string(&SecretBackend::Keychain).unwrap(),
            "\"keychain\""
        );
        assert_eq!(
            serde_json::to_string(&SecretBackend::Vault).unwrap(),
            "\"vault\""
        );
        assert_eq!(
            serde_json::to_string(&SecretBackend::Degraded).unwrap(),
            "\"degraded\""
        );
    }

    #[test]
    fn no_failure_description_carries_a_path_or_a_secret() {
        // Every reason the renderer can be handed, across both tiers that can
        // take over — the string is rendered to the user (R14.8), so it names no
        // file and no credential.
        for err in [
            KeychainError::Handle,
            KeychainError::Write,
            KeychainError::Read,
            KeychainError::Vanished,
            KeychainError::Mismatch,
        ] {
            for fallback in [SecretBackend::Vault, SecretBackend::Degraded] {
                let described = describe_keychain_failure(&err, fallback);
                assert!(!described.contains('/'), "{described}");
                assert!(!described.contains("sk-"), "{described}");
                assert!(!described.contains(".zoc-studio"), "{described}");
                assert!(
                    described.ends_with('.'),
                    "reasons are sentences: {described}"
                );
                if fallback == SecretBackend::Degraded {
                    assert!(
                        described.contains("cleared when the app exits"),
                        "the degraded reason must carry R14.8's consequence: {described}"
                    );
                } else {
                    assert!(
                        described.contains("encrypted store"),
                        "the tier-2 reason must say where keys went instead: {described}"
                    );
                }
            }
        }
    }

    // ── Properties 33 and 34 (tasks 4.5, 4.6) ─────────────────────────────
    //
    // Both quantify over the same two axes the four unit tests above pin to one
    // point each: the backend's behaviour, and the keys written to it. What the
    // generators add is the *combination* — a key value that round-trips through
    // Argon2id, XChaCha20-Poly1305, and `serde_json` on one machine and through a
    // keychain entry on another, with no case hand-picked to be easy.

    /// Every backing store the vault can find itself on, and the shared state a
    /// relaunch inherits from the launch before it.
    ///
    /// `store()` mints a *fresh* handle over that shared state on every call,
    /// which is what makes "an immediate read through a fresh handle" (R14.4) and
    /// "constructing a fresh Secret_Vault" (R14.9) the same operation here: a
    /// second `SecretVault::new` over the same `persistent` map is a relaunch.
    struct Fixture {
        behaviour: Backend,
        persistent: Arc<Mutex<HashMap<String, String>>>,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Backend {
        /// A durable OS secret service: tier 1.
        Healthy,
        /// A session keyring that keeps one real entry and loses the rest, which
        /// is the observed Linux failure mode: tier 2.
        SessionRing,
        /// Every write accepted and every read empty, master secret included, so
        /// there is nothing durable to encrypt a vault with: tier 3.
        Vanishing,
        /// No secret service at all: tier 3.
        Absent,
    }

    impl Fixture {
        fn new(behaviour: Backend) -> Self {
            Self {
                behaviour,
                persistent: Arc::new(Mutex::new(HashMap::new())),
            }
        }

        fn store(&self) -> Box<dyn KeyStore> {
            match self.behaviour {
                Backend::Healthy => Box::new(GoodKeyStore {
                    entries: self.persistent.clone(),
                }),
                Backend::SessionRing => Box::new(SessionKeyStore::new(
                    self.persistent.clone(),
                    &[MASTER_KEY_NAME],
                )),
                Backend::Vanishing => Box::new(WriteOnlyKeyStore),
                Backend::Absent => Box::new(FailingKeyStore),
            }
        }
    }

    fn backend() -> impl Strategy<Value = Backend> {
        prop_oneof![
            Just(Backend::Healthy),
            Just(Backend::SessionRing),
            Just(Backend::Vanishing),
            Just(Backend::Absent),
        ]
    }

    /// Provider-shaped names, kept clear of `vault.master` and `vault.probe`:
    /// generating either would have the property assert against the vault's own
    /// bookkeeping rather than against a user's key.
    const KEY_NAME: &str = r"provider\.[a-z]{1,8}";

    /// Any non-empty value, `.` over the whole scalar range rather than an
    /// API-key alphabet, because the value crosses a JSON encoder and an AEAD and
    /// the interesting inputs are the ones no realistic key would contain.
    ///
    /// Empty is excluded deliberately and is not a gap: `get` reports an empty
    /// tier-1 entry as absent so that `has` is false for it (R14.2), which makes
    /// saving an empty value a clear rather than a save.
    const KEY_VALUE: &str = r".{1,64}";

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(16))]

        /// **Property 33: reported success implies readable persistence** (R14.4).
        ///
        /// Two claims, because `set` reports two different things. Any `Ok` means
        /// the value reads back immediately, on every tier. `durable: true` means
        /// more than that — it survives the process — so the relaunched vault has
        /// to produce it, and that is the half a probe-less `keychain_set_verified`
        /// would fail: tier 1 would report success on `Vanishing`, and the fresh
        /// handle would find nothing.
        #[test]
        fn reported_success_implies_readable_persistence(
            behaviour in backend(),
            written in proptest::collection::hash_map(KEY_NAME, KEY_VALUE, 1..=3),
        ) {
            with_temp_home(|_| {
                let fixture = Fixture::new(behaviour);
                let vault = SecretVault::new(fixture.store());
                let mut durable: Vec<(&String, &String)> = Vec::new();

                for (key, value) in &written {
                    // None of the four fakes has a write path that errors, so a
                    // failure here is the vault refusing a save rather than the
                    // property finding nothing to assert.
                    let result = vault.set(key, value)
                        .map_err(|err| TestCaseError::fail(format!("set refused: {err}")))?;

                    prop_assert_eq!(
                        vault.get(key).map(|held| held.to_string()),
                        Some(value.clone()),
                        "a save that reported success must read back exactly"
                    );
                    prop_assert_eq!(
                        result.durable,
                        result.backend != SecretBackend::Degraded,
                        "only tier 3 may report a save as non-durable"
                    );
                    if result.durable {
                        durable.push((key, value));
                    }
                }

                prop_assert_eq!(
                    durable.is_empty(),
                    matches!(behaviour, Backend::Vanishing | Backend::Absent),
                    "exactly the two masterless backends may report nothing durable"
                );

                let relaunched = SecretVault::new(fixture.store());
                for (key, value) in durable {
                    prop_assert_eq!(
                        relaunched.get(key).map(|held| held.to_string()),
                        Some(value.clone()),
                        "a durable report must survive the process it was made in"
                    );
                }
                Ok(())
            })?;
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(12))]

        /// **Property 34: keys survive a cleared session keyring** (R14.9).
        ///
        /// The generated form of `session_keyring_cleared_between_launches_still_returns_keys`:
        /// a whole map of keys rather than two, and values byte-compared rather
        /// than read for shape. The second `SecretVault::new` over the same
        /// persistent ring *is* the cleared session — nothing carries over in
        /// memory, and the only entry the ring kept is the master secret.
        #[test]
        fn keys_survive_a_cleared_session_keyring(
            written in proptest::collection::hash_map(KEY_NAME, KEY_VALUE, 1..=3),
        ) {
            with_temp_home(|home| {
                let fixture = Fixture::new(Backend::SessionRing);
                let first = SecretVault::new(fixture.store());
                prop_assert_eq!(
                    first.backend(),
                    SecretBackend::Vault,
                    "a vanishing session ring must drop the vault to tier 2, not tier 1"
                );

                for (key, value) in &written {
                    let result = first.set(key, value)
                        .map_err(|err| TestCaseError::fail(format!("set refused: {err}")))?;
                    prop_assert!(result.durable, "tier 2 is durable");
                }
                drop(first);

                prop_assert!(
                    home.join(".zoc-studio").join("secrets.vault").exists(),
                    "tier 2 must have written the encrypted vault"
                );

                let relaunched = SecretVault::new(fixture.store());
                for (key, value) in &written {
                    prop_assert_eq!(
                        relaunched.get(key).map(|held| held.to_string()),
                        Some(value.clone()),
                        "every key must come back byte-identical"
                    );
                }
                Ok(())
            })?;
        }
    }
}
