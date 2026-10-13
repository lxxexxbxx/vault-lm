//! Vault encryption. Every byte of conversation data that touches disk or
//! Google Drive goes through `seal`/`open`.
//!
//! - KDF: Argon2id (64 MiB, t=3, p=1) over the user's passphrase + random salt
//! - AEAD: XChaCha20-Poly1305, fresh random 24-byte nonce per write
//! - File format: b"VLM1" || nonce(24) || ciphertext+tag
//!
//! `vault.json` holds only the salt, KDF params and an encrypted verifier,
//! so it is safe to sync: it lets another device derive the same key from
//! the same passphrase, but reveals nothing without it.

use anyhow::{anyhow, bail, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const MAGIC: &[u8; 4] = b"VLM1";
const VERIFIER_PLAINTEXT: &[u8] = b"vaultlm-verifier-v1";

pub type Key = Zeroizing<[u8; 32]>;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VaultMeta {
    pub version: u32,
    pub vault_id: String,
    pub salt: String,
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    /// base64(seal(key, VERIFIER_PLAINTEXT))
    pub verifier: String,
    pub created_at: i64,
}

fn derive(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<Key> {
    let params = Params::new(m, t, p, Some(32)).map_err(|e| anyhow!("argon2 params: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|e| anyhow!("argon2: {e}"))?;
    Ok(key)
}

pub fn create_vault(passphrase: &str) -> Result<(VaultMeta, Key)> {
    if passphrase.chars().count() < 8 {
        bail!("패스프레이즈는 8자 이상이어야 합니다");
    }
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let (m, t, p) = (64 * 1024, 3, 1);
    let key = derive(passphrase, &salt, m, t, p)?;
    let verifier = B64.encode(seal(&key, VERIFIER_PLAINTEXT)?);
    let meta = VaultMeta {
        version: 1,
        vault_id: uuid::Uuid::new_v4().to_string(),
        salt: B64.encode(salt),
        m_cost: m,
        t_cost: t,
        p_cost: p,
        verifier,
        created_at: chrono::Utc::now().timestamp_millis(),
    };
    Ok((meta, key))
}

pub fn unlock(meta: &VaultMeta, passphrase: &str) -> Result<Key> {
    let salt = B64.decode(&meta.salt)?;
    let key = derive(passphrase, &salt, meta.m_cost, meta.t_cost, meta.p_cost)?;
    verify_key(meta, &key)?;
    Ok(key)
}

pub fn verify_key(meta: &VaultMeta, key: &Key) -> Result<()> {
    let blob = B64.decode(&meta.verifier)?;
    let pt = open(key, &blob).map_err(|_| anyhow!("패스프레이즈가 올바르지 않습니다"))?;
    if pt != VERIFIER_PLAINTEXT {
        bail!("패스프레이즈가 올바르지 않습니다");
    }
    Ok(())
}

pub fn seal(key: &Key, plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| anyhow!("encrypt failed"))?;
    let mut out = Vec::with_capacity(4 + 24 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn open(key: &Key, blob: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < 4 + 24 + 16 || &blob[..4] != MAGIC {
        bail!("not a vault file");
    }
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    cipher
        .decrypt(XNonce::from_slice(&blob[4..28]), &blob[28..])
        .map_err(|_| anyhow!("decrypt failed (wrong key or corrupted file)"))
}

pub fn key_to_b64(key: &Key) -> String {
    B64.encode(key.as_ref())
}

pub fn key_from_b64(s: &str) -> Result<Key> {
    let raw = Zeroizing::new(B64.decode(s)?);
    if raw.len() != 32 {
        bail!("bad key length");
    }
    let mut k = Zeroizing::new([0u8; 32]);
    k.copy_from_slice(&raw);
    Ok(k)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let (meta, key) = create_vault("correct horse battery").unwrap();
        let blob = seal(&key, b"hello").unwrap();
        assert_eq!(open(&key, &blob).unwrap(), b"hello");
        let k2 = unlock(&meta, "correct horse battery").unwrap();
        assert_eq!(k2.as_ref(), key.as_ref());
        assert!(unlock(&meta, "wrong passphrase!").is_err());
    }
}
