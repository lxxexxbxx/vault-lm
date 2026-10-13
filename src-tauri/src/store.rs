//! Encrypted session store.
//!
//! Layout of the vault directory:
//!   vault.json            KDF salt + verifier (safe to sync, no content)
//!   sessions/<uuid>.vlm   one encrypted Session per file
//!
//! One file per session keeps Drive sync granular (only changed sessions
//! are transferred) and makes merges trivial (messages are append-mostly
//! and carry stable ids).

use crate::crypto::{self, Key, VaultMeta};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Message {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub content: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Set when a message was edited/regenerated; newer edit wins on merge.
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Session {
    pub id: String,
    pub title: String,
    /// "chat" | "code"
    pub mode: String,
    #[serde(default)]
    pub workspace: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub pinned: bool,
    /// Rolling summary of older turns (context compression)
    #[serde(default)]
    pub summary: Option<String>,
    /// Messages up to and including this id are covered by `summary`
    #[serde(default)]
    pub summary_until: Option<String>,
    #[serde(default)]
    pub messages: Vec<Message>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub mode: String,
    pub workspace: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub pinned: bool,
    pub message_count: usize,
}

impl From<&Session> for SessionMeta {
    fn from(s: &Session) -> Self {
        Self {
            id: s.id.clone(),
            title: s.title.clone(),
            mode: s.mode.clone(),
            workspace: s.workspace.clone(),
            created_at: s.created_at,
            updated_at: s.updated_at,
            pinned: s.pinned,
            message_count: s.messages.iter().filter(|m| !m.deleted).count(),
        }
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).or_else(|_| {
        // Windows: rename over existing file can fail if locked; fall back.
        std::fs::write(path, bytes).map(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    })?;
    Ok(())
}

pub struct Vault {
    pub dir: PathBuf,
}

impl Vault {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }
    fn meta_path(&self) -> PathBuf {
        self.dir.join("vault.json")
    }
    fn sessions_dir(&self) -> PathBuf {
        self.dir.join("sessions")
    }
    pub fn session_path(&self, id: &str) -> PathBuf {
        self.sessions_dir().join(format!("{id}.vlm"))
    }

    pub fn read_meta(&self) -> Option<VaultMeta> {
        std::fs::read(self.meta_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
    }

    pub fn write_meta(&self, meta: &VaultMeta) -> Result<()> {
        std::fs::create_dir_all(self.sessions_dir())?;
        atomic_write(&self.meta_path(), &serde_json::to_vec_pretty(meta)?)
    }

    pub fn load_session(&self, key: &Key, id: &str) -> Result<Session> {
        let blob = std::fs::read(self.session_path(id)).context("session not found")?;
        decode_session(key, &blob)
    }

    pub fn save_session(&self, key: &Key, s: &Session) -> Result<()> {
        std::fs::create_dir_all(self.sessions_dir())?;
        atomic_write(&self.session_path(&s.id), &encode_session(key, s)?)
    }

    pub fn list_ids(&self) -> Vec<String> {
        let Ok(rd) = std::fs::read_dir(self.sessions_dir()) else { return vec![] };
        rd.filter_map(|e| e.ok())
            .filter_map(|e| {
                let p = e.path();
                if p.extension()? != "vlm" {
                    return None;
                }
                Some(p.file_stem()?.to_string_lossy().to_string())
            })
            .collect()
    }

    /// Decrypts every session; returns metas for non-deleted ones.
    pub fn list_all(&self, key: &Key) -> Vec<Session> {
        self.list_ids()
            .into_iter()
            .filter_map(|id| self.load_session(key, &id).ok())
            .collect()
    }
}

pub fn encode_session(key: &Key, s: &Session) -> Result<Vec<u8>> {
    crypto::seal(key, &serde_json::to_vec(s)?)
}

pub fn decode_session(key: &Key, blob: &[u8]) -> Result<Session> {
    let pt = crypto::open(key, blob)?;
    Ok(serde_json::from_slice(&pt)?)
}

/// Deterministic, commutative-enough merge of two replicas of one session.
/// - messages: union by id; for duplicates the higher `updated_at` wins
/// - session fields: replica with higher `updated_at` wins
/// - tombstones: a deleted session stays deleted if the deletion is newest
pub fn merge(a: &Session, b: &Session) -> Session {
    let (newer, older) = if a.updated_at >= b.updated_at { (a, b) } else { (b, a) };
    let mut map: BTreeMap<String, Message> = BTreeMap::new();
    for m in older.messages.iter().chain(newer.messages.iter()) {
        match map.get(&m.id) {
            Some(existing) if existing.updated_at > m.updated_at => {}
            _ => {
                map.insert(m.id.clone(), m.clone());
            }
        }
    }
    let mut messages: Vec<Message> = map.into_values().collect();
    messages.sort_by(|x, y| x.created_at.cmp(&y.created_at).then_with(|| x.id.cmp(&y.id)));
    let mut out = newer.clone();
    // A newest-wins tombstone must not be resurrected by the other replica.
    out.messages = if newer.deleted { vec![] } else { messages };
    out.created_at = a.created_at.min(b.created_at);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, t: i64) -> Message {
        Message {
            id: id.into(),
            role: "user".into(),
            content: id.into(),
            created_at: t,
            reasoning: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            model: None,
            updated_at: t,
            deleted: false,
        }
    }

    #[test]
    fn merge_unions_messages() {
        let base = Session {
            id: "s".into(),
            title: "t".into(),
            mode: "chat".into(),
            workspace: None,
            created_at: 1,
            updated_at: 10,
            deleted: false,
            pinned: false,
            summary: None,
            summary_until: None,
            messages: vec![msg("a", 1)],
        };
        let mut x = base.clone();
        x.messages.push(msg("b", 2));
        x.updated_at = 20;
        let mut y = base.clone();
        y.messages.push(msg("c", 3));
        y.updated_at = 30;
        let m1 = merge(&x, &y);
        let m2 = merge(&y, &x);
        assert_eq!(m1, m2);
        assert_eq!(m1.messages.len(), 3);
    }
}
