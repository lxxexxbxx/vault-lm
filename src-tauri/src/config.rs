//! Non-secret app settings (paths, model profiles, sampling params).
//! No conversation content and no tokens live here.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ModelProfile {
    pub id: String,
    pub name: String,
    /// Absolute path to a .gguf file
    pub model_path: String,
    pub port: u16,
    pub ctx_size: u32,
    /// Extra llama-server args, e.g. "-ngl 99 --n-cpu-moe 30 -fa on"
    pub extra_args: String,
}

impl Default for ModelProfile {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Qwen3.6-35B-A3B Q4_K_M".into(),
            model_path: String::new(),
            port: 8080,
            ctx_size: 32768,
            extra_args: "-ngl 99 --n-cpu-moe 30 -fa on --jinja".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct LlmSettings {
    /// OpenAI-compatible base URL. Must resolve to loopback (enforced).
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub top_p: f32,
    pub max_tokens: u32,
    /// Prompt budget used for history trimming (tokens, approximate)
    pub context_tokens: u32,
    pub system_prompt_chat: String,
    pub system_prompt_code: String,
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:8080/v1".into(),
            model: "local".into(),
            temperature: 0.7,
            top_p: 0.8,
            max_tokens: 4096,
            context_tokens: 26000,
            system_prompt_chat: "You are a helpful assistant running fully offline on the user's own machine. Answer in the user's language. Be direct and structured.".into(),
            system_prompt_code: "You are a coding agent working inside the user's local workspace. Use the provided tools to inspect files before changing them. Prefer edit_file for small changes. Explain what you changed briefly. Paths are relative to the workspace root.".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ServerSettings {
    /// Path to llama-server(.exe). Empty = expect it on PATH.
    pub llama_server_path: String,
    pub profiles: Vec<ModelProfile>,
    pub active_profile: Option<String>,
    pub auto_start: bool,
}

impl Default for ServerSettings {
    fn default() -> Self {
        let p = ModelProfile::default();
        Self {
            llama_server_path: String::new(),
            active_profile: Some(p.id.clone()),
            profiles: vec![p],
            auto_start: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct DriveSettings {
    pub enabled: bool,
    /// Your own Google Cloud OAuth "Desktop app" client.
    pub client_id: String,
    pub client_secret: String,
    pub auto_sync_secs: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AppConfig {
    /// Where encrypted session files live. Can be any folder (incl. a
    /// Google Drive for Desktop folder) — files are encrypted either way.
    pub vault_dir: String,
    pub llm: LlmSettings,
    pub server: ServerSettings,
    pub drive: DriveSettings,
    /// Allow RFC1918 / Tailscale (100.64/10) LLM endpoints in addition to loopback.
    pub allow_private_lan: bool,
    pub auto_approve_reads: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            vault_dir: String::new(),
            llm: LlmSettings::default(),
            server: ServerSettings::default(),
            drive: DriveSettings { auto_sync_secs: 120, ..Default::default() },
            allow_private_lan: false,
            auto_approve_reads: true,
        }
    }
}

pub fn load(path: &Path) -> AppConfig {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, cfg: &AppConfig) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::store::atomic_write(path, &serde_json::to_vec_pretty(cfg)?)
}

pub fn resolve_vault_dir(cfg: &AppConfig, default_dir: &Path) -> PathBuf {
    if cfg.vault_dir.trim().is_empty() {
        default_dir.to_path_buf()
    } else {
        PathBuf::from(cfg.vault_dir.trim())
    }
}
