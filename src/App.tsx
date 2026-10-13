import { useEffect } from "react";
import { useApp } from "./store";
import { Unlock } from "./components/Unlock";
import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { CodeSide } from "./components/CodeSide";
import { Settings } from "./components/Settings";

function ApprovalDialog() {
  const { approval } = useApp();
  if (!approval) return null;
  const done = (ok: boolean) => {
    approval.resolve(ok);
    useApp.setState({ approval: null });
  };
  return (
    <div className="modal-bg">
      <div className="approval" onKeyDown={(e) => e.key === "Escape" && done(false)}>
        <h3>{approval.title}</h3>
        <p className="muted small">모델이 다음 작업을 요청했습니다. 내용을 확인하고 허용하세요.</p>
        <pre>{approval.detail.length > 30000 ? approval.detail.slice(0, 30000) + "\n…" : approval.detail}</pre>
        <div className="row gap end">
          <button className="ghost" onClick={() => done(false)}>
            거부
          </button>
          <button className="primary" autoFocus onClick={() => done(true)}>
            허용
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { init, vault, current, settingsOpen, toast, mode } = useApp();

  useEffect(() => {
    init();
    // block any in-webview navigation away from the app (e.g. dropped links)
    const stopDrop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stopDrop);
    window.addEventListener("drop", stopDrop);
    return () => {
      window.removeEventListener("dragover", stopDrop);
      window.removeEventListener("drop", stopDrop);
    };
  }, [init]);

  if (!vault) return <div className="boot" />;
  if (!vault.unlocked) return <Unlock />;

  const showCode = mode === "code" && current?.mode === "code";

  return (
    <div className={`app ${showCode ? "with-code" : ""}`}>
      <Sidebar />
      <main className="main">
        <ChatPane />
      </main>
      {showCode && <CodeSide />}
      {settingsOpen && <Settings />}
      <ApprovalDialog />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
