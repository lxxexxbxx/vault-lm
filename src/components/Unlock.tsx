import { useState } from "react";
import { api, errMsg } from "../api";
import { useApp } from "../store";

export function Unlock() {
  const { vault, cfg, saveConfig, afterUnlock, refreshVault } = useApp();
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"create" | "import">("create");
  const [cid, setCid] = useState(cfg?.drive.client_id ?? "");
  const [secret, setSecret] = useState(cfg?.drive.client_secret ?? "");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const unlock = () =>
    run(async () => {
      await api.vaultUnlock(pass, remember);
      setPass("");
      await afterUnlock();
    });

  const createVault = () =>
    run(async () => {
      if (pass !== pass2) throw new Error("패스프레이즈가 일치하지 않습니다");
      await api.vaultCreate(pass, remember);
      setPass("");
      setPass2("");
      await afterUnlock();
    });

  const importDrive = () =>
    run(async () => {
      if (!cfg) return;
      const next = { ...cfg, drive: { ...cfg.drive, enabled: true, client_id: cid.trim(), client_secret: secret.trim() } };
      await saveConfig(next);
      await api.driveConnect();
      await api.vaultImportFromDrive();
      await refreshVault();
    });

  if (!vault) return null;

  return (
    <div className="unlock">
      <div className="unlock-card">
        <div className="brand">
          <span className="logo" />
          <div>
            <h1>VaultLM</h1>
            <p className="muted">로컬 LLM 전용 · 종단간 암호화 대화 금고</p>
          </div>
        </div>

        {vault.exists ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              unlock();
            }}
          >
            <label>패스프레이즈</label>
            <input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />이 기기에서
              기억 (OS 키체인)
            </label>
            <button className="primary" disabled={busy || !pass}>
              {busy ? "키 유도 중…" : "잠금 해제"}
            </button>
          </form>
        ) : (
          <>
            <div className="seg">
              <button className={tab === "create" ? "on" : ""} onClick={() => setTab("create")}>
                새 금고 만들기
              </button>
              <button className={tab === "import" ? "on" : ""} onClick={() => setTab("import")}>
                드라이브에서 가져오기
              </button>
            </div>
            {tab === "create" ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  createVault();
                }}
              >
                <p className="muted small">
                  모든 대화는 이 패스프레이즈로 암호화됩니다. 잃어버리면 복구할 방법이 없습니다. 다른 기기에서도 같은
                  패스프레이즈를 씁니다.
                </p>
                <label>패스프레이즈 (8자 이상)</label>
                <input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
                <label>패스프레이즈 확인</label>
                <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
                <label className="check">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />이 기기에서
                  기억 (OS 키체인)
                </label>
                <button className="primary" disabled={busy || pass.length < 8}>
                  {busy ? "생성 중…" : "금고 만들기"}
                </button>
                <p className="muted small">저장 위치: {vault.vaultDir}</p>
              </form>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  importDrive();
                }}
              >
                <p className="muted small">
                  다른 기기에서 만든 금고를 이어서 씁니다. 드라이브에는 암호화된 파일만 있으므로, 연결 후 원래
                  패스프레이즈로 잠금을 해제하세요.
                </p>
                <label>Google OAuth Client ID</label>
                <input value={cid} onChange={(e) => setCid(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" />
                <label>Client Secret</label>
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
                <button className="primary" disabled={busy || !cid}>
                  {busy ? "브라우저에서 로그인 진행 중…" : "드라이브 연결 후 가져오기"}
                </button>
              </form>
            )}
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
