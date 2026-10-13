import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errMsg } from "../api";
import { useApp } from "../store";

function ago(t: number) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "방금";
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  return new Date(t).toLocaleDateString();
}

export function Sidebar() {
  const {
    mode,
    setMode,
    sessions,
    current,
    openSession,
    newSession,
    deleteSession,
    renameSession,
    togglePin,
    server,
    cfg,
    sync,
    syncAll,
    setSettingsOpen,
    streaming,
    showToast,
    pollServer,
  } = useApp();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const list = useMemo(
    () => sessions.filter((s) => s.mode === mode && (!q || s.title.toLowerCase().includes(q.toLowerCase()))),
    [sessions, mode, q],
  );

  const create = async () => {
    if (mode === "code") {
      const dir = await open({ directory: true, title: "워크스페이스 폴더 선택" });
      if (typeof dir !== "string") return;
      await newSession("code", dir);
    } else {
      await newSession("chat");
    }
  };

  const profile = cfg?.server.profiles.find((p) => p.id === (server?.profileId ?? cfg.server.active_profile));
  const dot = server?.ready ? "ok" : server?.running ? "warn" : "off";
  const label = server?.ready
    ? profile?.name ?? "로컬 서버 연결됨"
    : server?.running
      ? "모델 로딩 중…"
      : "서버 꺼짐";

  const toggleServer = async () => {
    try {
      if (server?.running) await api.serverStop();
      else await api.serverStart();
    } catch (e) {
      showToast(errMsg(e));
    }
    pollServer();
  };

  const syncLabel =
    sync.status === "off"
      ? "로컬 전용"
      : sync.status === "syncing"
        ? "동기화 중…"
        : sync.status === "error"
          ? "동기화 오류"
          : sync.lastAt
            ? `드라이브 동기화 ${ago(sync.lastAt)}`
            : "드라이브 연결됨";

  return (
    <aside className="sidebar">
      <div className="side-top">
        <div className="brand-row">
          <span className="logo sm" />
          <b>VaultLM</b>
        </div>
        <div className="seg full">
          <button className={mode === "chat" ? "on" : ""} onClick={() => setMode("chat")}>
            Chat
          </button>
          <button className={mode === "code" ? "on" : ""} onClick={() => setMode("code")}>
            Code
          </button>
        </div>
        <button className="new-btn" onClick={create} disabled={!!streaming}>
          + {mode === "code" ? "새 코드 작업" : "새 대화"}
        </button>
        <input className="search" placeholder="검색" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <nav className="session-list">
        {list.length === 0 && <div className="muted small pad">아직 {mode === "code" ? "작업" : "대화"}이 없습니다</div>}
        {list.map((s) => (
          <div
            key={s.id}
            className={`session ${current?.id === s.id ? "active" : ""}`}
            onClick={() => editing !== s.id && openSession(s.id)}
          >
            {editing === s.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => setEditing(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    renameSession(s.id, draft.trim() || s.title);
                    setEditing(null);
                  } else if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <>
                <div className="s-title">
                  {s.pinned && <span className="pin">●</span>}
                  {s.title || "(제목 없음)"}
                </div>
                <div className="s-sub">
                  {s.mode === "code" && s.workspace ? s.workspace.split(/[\\/]/).pop() + " · " : ""}
                  {ago(s.updated_at)}
                </div>
                <div className="s-actions" onClick={(e) => e.stopPropagation()}>
                  <button title="고정" onClick={() => togglePin(s.id)}>
                    {s.pinned ? "고정 해제" : "고정"}
                  </button>
                  <button
                    title="이름 변경"
                    onClick={() => {
                      setDraft(s.title);
                      setEditing(s.id);
                    }}
                  >
                    이름
                  </button>
                  <button
                    title="삭제"
                    className="danger"
                    onClick={() => {
                      if (confirm(`"${s.title}"을(를) 삭제할까요? 동기화된 다른 기기에서도 삭제됩니다.`)) deleteSession(s.id);
                    }}
                  >
                    삭제
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </nav>

      <div className="side-bottom">
        <button className="status-row" onClick={toggleServer} title={server?.running ? "서버 중지" : "서버 시작"}>
          <span className={`dot ${dot}`} />
          <span className="ellipsis">{label}</span>
          <span className="muted small">{server?.running ? "중지" : "시작"}</span>
        </button>
        <button
          className="status-row"
          onClick={() => (sync.status === "off" ? setSettingsOpen(true) : syncAll())}
          title={sync.error ?? "지금 동기화"}
        >
          <span className={`dot ${sync.status === "error" ? "err" : sync.status === "off" ? "off" : "ok"}`} />
          <span className="ellipsis">{syncLabel}</span>
        </button>
        <div className="row gap">
          <button className="ghost grow" onClick={() => setSettingsOpen(true)}>
            설정
          </button>
          <button
            className="ghost"
            onClick={async () => {
              await api.vaultLock(false);
              try {
                sessionStorage.setItem("vlm-locked", "1");
              } catch {
                /* ignore */
              }
              location.reload();
            }}
          >
            잠금
          </button>
        </div>
      </div>
    </aside>
  );
}
