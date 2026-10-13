mod config;
mod crypto;
mod gdrive;
mod llm;
mod server;
mod store;
mod workspace;

use config::AppConfig;
use crypto::Key;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use store::{Session, SessionMeta, Vault};
use tauri::ipc::Channel;
use tauri::{Manager, RunEvent, State};

const KEYRING_SERVICE: &str = "dev.bbb.vaultlm";

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

pub struct AppState {
    config_path: PathBuf,
    default_vault: PathBuf,
    cfg: Mutex<AppConfig>,
    key: Mutex<Option<Key>>,
    server: tokio::sync::Mutex<server::ServerManager>,
    server_logs: Arc<Mutex<std::collections::VecDeque<String>>>,
    drive: tokio::sync::Mutex<gdrive::DriveState>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    fn cfg(&self) -> AppConfig {
        self.cfg.lock().unwrap().clone()
    }
    fn vault(&self) -> Vault {
        Vault::new(config::resolve_vault_dir(&self.cfg(), &self.default_vault))
    }
    fn key(&self) -> CmdResult<Key> {
        self.key.lock().unwrap().clone().ok_or_else(|| "금고가 잠겨 있습니다".to_string())
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ------------------------------------------------------------ config

#[tauri::command]
fn get_config(s: State<AppState>) -> AppConfig {
    s.cfg()
}

#[tauri::command]
fn set_config(s: State<AppState>, cfg: AppConfig) -> CmdResult<()> {
    llm::check_local_url(&cfg.llm.base_url, cfg.allow_private_lan).map_err(err)?;
    config::save(&s.config_path, &cfg).map_err(err)?;
    *s.cfg.lock().unwrap() = cfg;
    Ok(())
}

// ------------------------------------------------------------ vault

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStatus {
    exists: bool,
    unlocked: bool,
    vault_dir: String,
    remembered: bool,
    drive_connected: bool,
}

fn remembered_entry(meta: &crypto::VaultMeta) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("vault-key-{}", meta.vault_id)).ok()
}

#[tauri::command]
fn vault_status(s: State<AppState>) -> VaultStatus {
    let v = s.vault();
    let meta = v.read_meta();
    let remembered = meta
        .as_ref()
        .and_then(remembered_entry)
        .map(|e| e.get_password().is_ok())
        .unwrap_or(false);
    VaultStatus {
        exists: meta.is_some(),
        unlocked: s.key.lock().unwrap().is_some(),
        vault_dir: v.dir.to_string_lossy().to_string(),
        remembered,
        drive_connected: gdrive::has_refresh_token(),
    }
}

fn remember(meta: &crypto::VaultMeta, key: &Key, yes: bool) {
    if let Some(e) = remembered_entry(meta) {
        if yes {
            let _ = e.set_password(&crypto::key_to_b64(key));
        } else {
            let _ = e.delete_credential();
        }
    }
}

#[tauri::command]
async fn vault_create(s: State<'_, AppState>, passphrase: String, remember_device: bool) -> CmdResult<()> {
    let v = s.vault();
    if v.read_meta().is_some() {
        return Err("이미 금고가 존재합니다".into());
    }
    let (meta, key) = tokio::task::spawn_blocking(move || crypto::create_vault(&passphrase))
        .await
        .map_err(err)?
        .map_err(err)?;
    v.write_meta(&meta).map_err(err)?;
    remember(&meta, &key, remember_device);
    *s.key.lock().unwrap() = Some(key);
    Ok(())
}

#[tauri::command]
async fn vault_unlock(s: State<'_, AppState>, passphrase: String, remember_device: bool) -> CmdResult<()> {
    let meta = s.vault().read_meta().ok_or("금고가 없습니다")?;
    let m2 = meta.clone();
    let key = tokio::task::spawn_blocking(move || crypto::unlock(&m2, &passphrase))
        .await
        .map_err(err)?
        .map_err(err)?;
    remember(&meta, &key, remember_device);
    *s.key.lock().unwrap() = Some(key);
    Ok(())
}

#[tauri::command]
fn vault_auto_unlock(s: State<AppState>) -> bool {
    let Some(meta) = s.vault().read_meta() else { return false };
    let Some(entry) = remembered_entry(&meta) else { return false };
    let Ok(b64) = entry.get_password() else { return false };
    let Ok(key) = crypto::key_from_b64(&b64) else { return false };
    if crypto::verify_key(&meta, &key).is_err() {
        return false;
    }
    *s.key.lock().unwrap() = Some(key);
    true
}

#[tauri::command]
fn vault_lock(s: State<AppState>, forget_device: bool) {
    if forget_device {
        if let Some(meta) = s.vault().read_meta() {
            if let Some(e) = remembered_entry(&meta) {
                let _ = e.delete_credential();
            }
        }
    }
    *s.key.lock().unwrap() = None;
}

/// New device: pull vault.json (salt + verifier only) from Drive so the
/// same passphrase unlocks the same vault here.
#[tauri::command]
async fn vault_import_from_drive(s: State<'_, AppState>) -> CmdResult<()> {
    let v = s.vault();
    if v.read_meta().is_some() {
        return Err("이 기기에 이미 금고가 있습니다".into());
    }
    let cfg = s.cfg();
    let mut ds = s.drive.lock().await;
    let d = gdrive::Drive::new(&cfg.drive.client_id, &cfg.drive.client_secret, &mut ds).await.map_err(err)?;
    let meta = d.fetch_meta().await.map_err(err)?.ok_or("드라이브에 금고가 없습니다")?;
    v.write_meta(&meta).map_err(err)?;
    Ok(())
}

// ------------------------------------------------------------ sessions

#[tauri::command]
async fn sessions_list(s: State<'_, AppState>) -> CmdResult<Vec<SessionMeta>> {
    let key = s.key()?;
    let v = s.vault();
    let mut list: Vec<SessionMeta> = tokio::task::spawn_blocking(move || {
        v.list_all(&key).iter().filter(|x| !x.deleted).map(SessionMeta::from).collect()
    })
    .await
    .map_err(err)?;
    list.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.updated_at.cmp(&a.updated_at)));
    Ok(list)
}

#[tauri::command]
fn session_get(s: State<AppState>, id: String) -> CmdResult<Session> {
    s.vault().load_session(&s.key()?, &id).map_err(err)
}

#[tauri::command]
fn session_save(s: State<AppState>, session: Session) -> CmdResult<()> {
    s.vault().save_session(&s.key()?, &session).map_err(err)
}

#[tauri::command]
fn session_delete(s: State<AppState>, id: String) -> CmdResult<()> {
    let key = s.key()?;
    let v = s.vault();
    let mut sess = v.load_session(&key, &id).map_err(err)?;
    sess.deleted = true;
    sess.messages.clear();
    sess.summary = None;
    sess.title = String::new();
    sess.updated_at = now();
    v.save_session(&key, &sess).map_err(err)
}

// ------------------------------------------------------------ LLM

#[tauri::command]
async fn llm_chat(
    s: State<'_, AppState>,
    request_id: String,
    body: Value,
    on_event: Channel<llm::StreamEvent>,
) -> CmdResult<llm::ChatResult> {
    let cfg = s.cfg();
    let flag = Arc::new(AtomicBool::new(false));
    s.cancels.lock().unwrap().insert(request_id.clone(), flag.clone());
    let r = llm::stream_chat(
        llm::ChatParams { base_url: cfg.llm.base_url.clone(), allow_lan: cfg.allow_private_lan, body },
        on_event,
        flag,
    )
    .await;
    s.cancels.lock().unwrap().remove(&request_id);
    r.map_err(err)
}

#[tauri::command]
fn llm_cancel(s: State<AppState>, request_id: String) {
    if let Some(f) = s.cancels.lock().unwrap().get(&request_id) {
        f.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
async fn llm_complete(s: State<'_, AppState>, body: Value) -> CmdResult<String> {
    let cfg = s.cfg();
    llm::complete(&cfg.llm.base_url, cfg.allow_private_lan, body).await.map_err(err)
}

#[tauri::command]
async fn llm_models(s: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let cfg = s.cfg();
    llm::list_models(&cfg.llm.base_url, cfg.allow_private_lan).await.map_err(err)
}

// ------------------------------------------------------------ llama-server

#[tauri::command]
async fn server_start(s: State<'_, AppState>, profile_id: Option<String>) -> CmdResult<server::ServerStatus> {
    let mut cfg = s.cfg();
    let pid = profile_id.or(cfg.server.active_profile.clone()).ok_or("프로필을 선택하세요")?;
    let p = cfg.server.profiles.iter().find(|p| p.id == pid).cloned().ok_or("프로필을 찾을 수 없습니다")?;
    let mut sm = s.server.lock().await;
    sm.start(&cfg.server.llama_server_path, &p).await.map_err(err)?;
    // keep the client pointed at the server we just launched
    cfg.server.active_profile = Some(p.id.clone());
    cfg.llm.base_url = format!("http://127.0.0.1:{}/v1", p.port);
    let _ = config::save(&s.config_path, &cfg);
    *s.cfg.lock().unwrap() = cfg;
    Ok(sm.status())
}

#[tauri::command]
async fn server_stop(s: State<'_, AppState>) -> CmdResult<()> {
    s.server.lock().await.stop().await;
    Ok(())
}

#[tauri::command]
async fn server_status(s: State<'_, AppState>) -> CmdResult<server::ServerStatus> {
    let mut st = s.server.lock().await.status();
    let cfg = s.cfg();
    st.ready = llm::list_models(&cfg.llm.base_url, cfg.allow_private_lan).await.is_ok();
    Ok(st)
}

#[tauri::command]
fn server_logs(s: State<AppState>) -> Vec<String> {
    s.server_logs.lock().unwrap().iter().cloned().collect()
}

// ------------------------------------------------------------ workspace

#[tauri::command]
fn ws_tree(root: String, sub: Option<String>, depth: Option<usize>) -> CmdResult<Vec<workspace::Entry>> {
    workspace::list_tree(&root, sub.as_deref().unwrap_or(""), depth.unwrap_or(4), 3000).map_err(err)
}

#[tauri::command]
fn ws_read(root: String, path: String, start: Option<usize>, end: Option<usize>) -> CmdResult<String> {
    workspace::read_file(&root, &path, start, end).map_err(err)
}

#[tauri::command]
fn ws_write(root: String, path: String, content: String) -> CmdResult<String> {
    workspace::write_file(&root, &path, &content).map_err(err)
}

#[tauri::command]
fn ws_edit(root: String, path: String, old_string: String, new_string: String) -> CmdResult<String> {
    workspace::edit_file(&root, &path, &old_string, &new_string).map_err(err)
}

#[tauri::command]
async fn ws_search(root: String, pattern: String, sub: Option<String>) -> CmdResult<String> {
    tokio::task::spawn_blocking(move || workspace::search(&root, &pattern, sub.as_deref().unwrap_or(""), 200))
        .await
        .map_err(err)?
        .map_err(err)
}

#[tauri::command]
async fn ws_run(root: String, command: String, timeout_secs: Option<u64>) -> CmdResult<String> {
    workspace::run_command(&root, &command, timeout_secs.unwrap_or(120)).await.map_err(err)
}

// ------------------------------------------------------------ Google Drive

#[tauri::command]
async fn drive_connect(s: State<'_, AppState>) -> CmdResult<()> {
    let cfg = s.cfg();
    let mut ds = s.drive.lock().await;
    gdrive::connect(&cfg.drive.client_id, &cfg.drive.client_secret, &mut ds).await.map_err(err)
}

#[tauri::command]
async fn drive_disconnect(s: State<'_, AppState>) -> CmdResult<()> {
    gdrive::forget_tokens(&mut *s.drive.lock().await);
    Ok(())
}

#[tauri::command]
async fn drive_sync_all(s: State<'_, AppState>) -> CmdResult<gdrive::SyncReport> {
    let key = s.key()?;
    let cfg = s.cfg();
    let mut ds = s.drive.lock().await; // also serialises concurrent syncs
    let d = gdrive::Drive::new(&cfg.drive.client_id, &cfg.drive.client_secret, &mut ds).await.map_err(err)?;
    d.sync_all(&s.vault(), &key).await.map_err(err)
}

#[tauri::command]
async fn drive_sync_session(s: State<'_, AppState>, id: String) -> CmdResult<gdrive::SyncReport> {
    let key = s.key()?;
    let cfg = s.cfg();
    let mut ds = s.drive.lock().await;
    let d = gdrive::Drive::new(&cfg.drive.client_id, &cfg.drive.client_secret, &mut ds).await.map_err(err)?;
    d.sync_session(&s.vault(), &key, &id).await.map_err(err)
}

// ------------------------------------------------------------ app

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let config_path = config_dir.join("config.json");
            let cfg = config::load(&config_path);
            let sm = server::ServerManager::default();
            let logs = sm.logs.clone();
            let auto = cfg.server.auto_start;
            app.manage(AppState {
                config_path,
                default_vault: data_dir.join("vault"),
                cfg: Mutex::new(cfg),
                key: Mutex::new(None),
                server: tokio::sync::Mutex::new(sm),
                server_logs: logs,
                drive: tokio::sync::Mutex::new(Default::default()),
                cancels: Mutex::new(HashMap::new()),
            });
            if auto {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let s = handle.state::<AppState>();
                    let _ = server_start(s, None).await;
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            vault_status,
            vault_create,
            vault_unlock,
            vault_auto_unlock,
            vault_lock,
            vault_import_from_drive,
            sessions_list,
            session_get,
            session_save,
            session_delete,
            llm_chat,
            llm_cancel,
            llm_complete,
            llm_models,
            server_start,
            server_stop,
            server_status,
            server_logs,
            ws_tree,
            ws_read,
            ws_write,
            ws_edit,
            ws_search,
            ws_run,
            drive_connect,
            drive_disconnect,
            drive_sync_all,
            drive_sync_session,
        ])
        .build(tauri::generate_context!())
        .expect("error while building VaultLM");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let s = handle.state::<AppState>();
            if let Ok(mut sm) = s.server.try_lock() {
                sm.kill_blocking();
            }
            *s.key.lock().unwrap() = None;
        }
    });
}
