//! Google Drive sync over the hidden, per-app `appDataFolder`
//! (scope `drive.appdata`: the app cannot see any of your other files,
//! and these files don't show up in your Drive UI).
//!
//! Only already-encrypted blobs are uploaded. File names are random UUIDs,
//! so Google sees neither titles nor content — only sizes and timestamps.

use crate::crypto::{Key, VaultMeta};
use crate::store::{self, Session, Vault};
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SCOPE: &str = "https://www.googleapis.com/auth/drive.appdata";
const KEYRING_SERVICE: &str = "dev.bbb.vaultlm";
const KEYRING_REFRESH: &str = "gdrive-refresh-token";
const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";

#[derive(Default)]
pub struct DriveState {
    access_token: Option<String>,
    expires_at: i64,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub uploaded: usize,
    pub downloaded: usize,
    pub merged: usize,
    pub unchanged: usize,
    pub at: i64,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .expect("http client")
}

fn keyring_entry() -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(KEYRING_SERVICE, KEYRING_REFRESH)?)
}

pub fn has_refresh_token() -> bool {
    keyring_entry().and_then(|e| Ok(e.get_password()?)).is_ok()
}

pub fn forget_tokens(state: &mut DriveState) {
    if let Ok(e) = keyring_entry() {
        let _ = e.delete_credential();
    }
    *state = DriveState::default();
}

// ---------------------------------------------------------------- OAuth

/// Desktop OAuth with PKCE and a one-shot loopback listener on 127.0.0.1.
pub async fn connect(client_id: &str, client_secret: &str, state: &mut DriveState) -> Result<()> {
    if client_id.trim().is_empty() {
        bail!("설정에서 Google OAuth Client ID를 먼저 입력하세요");
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let redirect = format!("http://127.0.0.1:{port}");

    let mut raw = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut raw);
    let verifier = B64URL.encode(raw);
    let challenge = B64URL.encode(Sha256::digest(verifier.as_bytes()));
    let mut st = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut st);
    let csrf = B64URL.encode(st);

    let mut auth = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")?;
    auth.query_pairs_mut()
        .append_pair("client_id", client_id.trim())
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &csrf)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    open::that(auth.as_str()).context("브라우저를 열 수 없습니다")?;

    let code = tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            let (mut sock, _) = listener.accept().await?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await?;
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
            let u = url::Url::parse(&format!("http://127.0.0.1{path}"))?;
            let q: HashMap<_, _> = u.query_pairs().into_owned().collect();
            if q.get("code").is_none() && q.get("error").is_none() {
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                continue;
            }
            let ok = q.get("state") == Some(&csrf) && q.contains_key("code");
            let body = if ok {
                "<html><meta charset=utf-8><body style='font-family:sans-serif;padding:40px'><h2>VaultLM 연결 완료</h2><p>이 탭을 닫고 앱으로 돌아가세요.</p></body></html>"
            } else {
                "<html><meta charset=utf-8><body style='font-family:sans-serif;padding:40px'><h2>연결 실패</h2></body></html>"
            };
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            if !ok {
                bail!("OAuth 실패: {}", q.get("error").cloned().unwrap_or_else(|| "state mismatch".into()));
            }
            return Ok::<String, anyhow::Error>(q["code"].clone());
        }
    })
    .await
    .map_err(|_| anyhow!("5분 안에 로그인이 완료되지 않았습니다"))??;

    let v: Value = http()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
            ("client_id", client_id.trim()),
            ("client_secret", client_secret.trim()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await?
        .json()
        .await?;
    let refresh = v["refresh_token"]
        .as_str()
        .ok_or_else(|| anyhow!("refresh_token 없음: {v}"))?;
    keyring_entry()?.set_password(refresh)?;
    state.access_token = v["access_token"].as_str().map(String::from);
    state.expires_at = now() + v["expires_in"].as_i64().unwrap_or(3000) * 1000;
    Ok(())
}

async fn token(cid: &str, secret: &str, state: &mut DriveState) -> Result<String> {
    if let Some(t) = &state.access_token {
        if state.expires_at > now() + 60_000 {
            return Ok(t.clone());
        }
    }
    let refresh = keyring_entry()?
        .get_password()
        .map_err(|_| anyhow!("구글 드라이브가 연결되어 있지 않습니다"))?;
    let v: Value = http()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("refresh_token", refresh.as_str()),
            ("client_id", cid.trim()),
            ("client_secret", secret.trim()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?
        .json()
        .await?;
    let t = v["access_token"]
        .as_str()
        .ok_or_else(|| anyhow!("토큰 갱신 실패: {}", v["error_description"].as_str().unwrap_or("unknown")))?
        .to_string();
    state.access_token = Some(t.clone());
    state.expires_at = now() + v["expires_in"].as_i64().unwrap_or(3000) * 1000;
    Ok(t)
}

// ---------------------------------------------------------------- Drive API

pub struct Drive {
    tok: String,
}

#[derive(Clone, Debug)]
struct RemoteFile {
    id: String,
    updated_at: i64,
}

impl Drive {
    pub async fn new(cid: &str, secret: &str, state: &mut DriveState) -> Result<Self> {
        Ok(Self { tok: token(cid, secret, state).await? })
    }

    async fn list(&self, name_filter: Option<&str>) -> Result<HashMap<String, RemoteFile>> {
        let mut out = HashMap::new();
        let mut page: Option<String> = None;
        loop {
            let mut req = http()
                .get(format!("{API}/files"))
                .bearer_auth(&self.tok)
                .query(&[
                    ("spaces", "appDataFolder"),
                    ("fields", "nextPageToken,files(id,name,appProperties)"),
                    ("pageSize", "1000"),
                ]);
            if let Some(n) = name_filter {
                req = req.query(&[("q", format!("name = '{}' and trashed = false", n.replace('\'', "")))]);
            } else {
                req = req.query(&[("q", "trashed = false")]);
            }
            if let Some(p) = &page {
                req = req.query(&[("pageToken", p)]);
            }
            let resp = req.send().await?;
            if !resp.status().is_success() {
                bail!("Drive list 실패 {}: {}", resp.status(), resp.text().await.unwrap_or_default());
            }
            let v: Value = resp.json().await?;
            for f in v["files"].as_array().into_iter().flatten() {
                let name = f["name"].as_str().unwrap_or_default().to_string();
                let updated_at = f["appProperties"]["updatedAt"]
                    .as_str()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                out.insert(name, RemoteFile { id: f["id"].as_str().unwrap_or_default().into(), updated_at });
            }
            match v["nextPageToken"].as_str() {
                Some(p) => page = Some(p.into()),
                None => break,
            }
        }
        Ok(out)
    }

    async fn download(&self, id: &str) -> Result<Vec<u8>> {
        let resp = http()
            .get(format!("{API}/files/{id}"))
            .bearer_auth(&self.tok)
            .query(&[("alt", "media")])
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!("Drive download 실패 {}", resp.status());
        }
        Ok(resp.bytes().await?.to_vec())
    }

    async fn upload(&self, name: &str, bytes: Vec<u8>, existing: Option<&str>, updated_at: i64) -> Result<()> {
        let boundary = format!("vlm{}", uuid::Uuid::new_v4().simple());
        let mut meta = json!({
            "name": name,
            "appProperties": { "updatedAt": updated_at.to_string() }
        });
        if existing.is_none() {
            meta["parents"] = json!(["appDataFolder"]);
        }
        let mut body = Vec::with_capacity(bytes.len() + 512);
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(&bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let req = match existing {
            Some(id) => http().patch(format!("{UPLOAD}/files/{id}")),
            None => http().post(format!("{UPLOAD}/files")),
        };
        let resp = req
            .bearer_auth(&self.tok)
            .query(&[("uploadType", "multipart")])
            .header("Content-Type", format!("multipart/related; boundary={boundary}"))
            .body(body)
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!("Drive upload 실패 {}: {}", resp.status(), resp.text().await.unwrap_or_default());
        }
        Ok(())
    }

    pub async fn fetch_meta(&self) -> Result<Option<VaultMeta>> {
        let files = self.list(Some("vault.json")).await?;
        match files.get("vault.json") {
            Some(f) => Ok(Some(serde_json::from_slice(&self.download(&f.id).await?)?)),
            None => Ok(None),
        }
    }

    async fn ensure_meta(&self, vault: &Vault, remote: &HashMap<String, RemoteFile>) -> Result<()> {
        let local = vault.read_meta().ok_or_else(|| anyhow!("로컬 금고가 없습니다"))?;
        match remote.get("vault.json") {
            None => self.upload("vault.json", serde_json::to_vec(&local)?, None, local.created_at).await,
            Some(f) => {
                let rm: VaultMeta = serde_json::from_slice(&self.download(&f.id).await?)?;
                if rm.vault_id != local.vault_id {
                    bail!("드라이브에 다른 금고가 있습니다. 새 기기라면 '드라이브에서 가져오기'로 시작하세요.");
                }
                Ok(())
            }
        }
    }

    async fn sync_one(
        &self,
        vault: &Vault,
        key: &Key,
        id: &str,
        local: Option<Session>,
        remote: Option<&RemoteFile>,
        rep: &mut SyncReport,
    ) -> Result<()> {
        let name = format!("{id}.vlm");
        match (local, remote) {
            (Some(l), None) => {
                self.upload(&name, store::encode_session(key, &l)?, None, l.updated_at).await?;
                rep.uploaded += 1;
            }
            (None, Some(r)) => {
                let s = store::decode_session(key, &self.download(&r.id).await?)?;
                vault.save_session(key, &s)?;
                rep.downloaded += 1;
            }
            (Some(l), Some(r)) => {
                if l.updated_at == r.updated_at {
                    rep.unchanged += 1;
                    return Ok(());
                }
                let rs = store::decode_session(key, &self.download(&r.id).await?)?;
                let merged = store::merge(&l, &rs);
                if merged != l {
                    vault.save_session(key, &merged)?;
                    rep.downloaded += 1;
                }
                if merged != rs {
                    self.upload(&name, store::encode_session(key, &merged)?, Some(&r.id), merged.updated_at)
                        .await?;
                    rep.uploaded += 1;
                }
                rep.merged += 1;
            }
            (None, None) => {}
        }
        Ok(())
    }

    pub async fn sync_all(&self, vault: &Vault, key: &Key) -> Result<SyncReport> {
        let remote = self.list(None).await?;
        self.ensure_meta(vault, &remote).await?;
        let mut rep = SyncReport::default();
        let local: HashMap<String, Session> = vault.list_all(key).into_iter().map(|s| (s.id.clone(), s)).collect();
        let mut ids: HashSet<String> = local.keys().cloned().collect();
        for name in remote.keys() {
            if let Some(id) = name.strip_suffix(".vlm") {
                ids.insert(id.to_string());
            }
        }
        for id in ids {
            let r = remote.get(&format!("{id}.vlm"));
            if let Err(e) = self.sync_one(vault, key, &id, local.get(&id).cloned(), r, &mut rep).await {
                eprintln!("sync {id}: {e:#}");
            }
        }
        rep.at = now();
        Ok(rep)
    }

    pub async fn sync_session(&self, vault: &Vault, key: &Key, id: &str) -> Result<SyncReport> {
        let remote = self.list(Some(&format!("{id}.vlm"))).await?;
        let mut rep = SyncReport::default();
        let local = vault.load_session(key, id).ok();
        self.sync_one(vault, key, id, local, remote.get(&format!("{id}.vlm")), &mut rep).await?;
        rep.at = now();
        Ok(rep)
    }
}
