import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  AppConfig,
  ChatResult,
  FileEntry,
  ServerStatus,
  Session,
  SessionMeta,
  StreamEvent,
  SyncReport,
  VaultStatus,
} from "./types";

export const api = {
  getConfig: () => invoke<AppConfig>("get_config"),
  setConfig: (cfg: AppConfig) => invoke<void>("set_config", { cfg }),

  vaultStatus: () => invoke<VaultStatus>("vault_status"),
  vaultCreate: (passphrase: string, rememberDevice: boolean) =>
    invoke<void>("vault_create", { passphrase, rememberDevice }),
  vaultUnlock: (passphrase: string, rememberDevice: boolean) =>
    invoke<void>("vault_unlock", { passphrase, rememberDevice }),
  vaultAutoUnlock: () => invoke<boolean>("vault_auto_unlock"),
  vaultLock: (forgetDevice = false) => invoke<void>("vault_lock", { forgetDevice }),
  vaultImportFromDrive: () => invoke<void>("vault_import_from_drive"),

  sessionsList: () => invoke<SessionMeta[]>("sessions_list"),
  sessionGet: (id: string) => invoke<Session>("session_get", { id }),
  sessionSave: (session: Session) => invoke<void>("session_save", { session }),
  sessionDelete: (id: string) => invoke<void>("session_delete", { id }),

  llmChat: (requestId: string, body: unknown, onEvent: (e: StreamEvent) => void) => {
    const ch = new Channel<StreamEvent>();
    ch.onmessage = onEvent;
    return invoke<ChatResult>("llm_chat", { requestId, body, onEvent: ch });
  },
  llmCancel: (requestId: string) => invoke<void>("llm_cancel", { requestId }),
  llmComplete: (body: unknown) => invoke<string>("llm_complete", { body }),
  llmModels: () => invoke<string[]>("llm_models"),

  serverStart: (profileId?: string) => invoke<ServerStatus>("server_start", { profileId }),
  serverStop: () => invoke<void>("server_stop"),
  serverStatus: () => invoke<ServerStatus>("server_status"),
  serverLogs: () => invoke<string[]>("server_logs"),

  wsTree: (root: string, sub?: string, depth?: number) => invoke<FileEntry[]>("ws_tree", { root, sub, depth }),
  wsRead: (root: string, path: string, start?: number, end?: number) =>
    invoke<string>("ws_read", { root, path, start, end }),
  wsWrite: (root: string, path: string, content: string) => invoke<string>("ws_write", { root, path, content }),
  wsEdit: (root: string, path: string, oldString: string, newString: string) =>
    invoke<string>("ws_edit", { root, path, oldString, newString }),
  wsSearch: (root: string, pattern: string, sub?: string) => invoke<string>("ws_search", { root, pattern, sub }),
  wsRun: (root: string, command: string, timeoutSecs?: number) =>
    invoke<string>("ws_run", { root, command, timeoutSecs }),

  driveConnect: () => invoke<void>("drive_connect"),
  driveDisconnect: () => invoke<void>("drive_disconnect"),
  driveSyncAll: () => invoke<SyncReport>("drive_sync_all"),
  driveSyncSession: (id: string) => invoke<SyncReport>("drive_sync_session", { id }),
};

export const uid = () => crypto.randomUUID();
export const now = () => Date.now();
export const errMsg = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
