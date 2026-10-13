import { useEffect, useRef } from "react";
import { useApp } from "./store";
import { Unlock } from "./components/Unlock";
import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { CodeSide } from "./components/CodeSide";
import { Settings } from "./components/Settings";
import { Resizer } from "./components/Resizer";
import { maxRightWidth, RIGHT_DEFAULT, RIGHT_MIN, useUi } from "./ui";

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
  const { leftOpen, rightOpen, rightWidth, setRightWidth, toggleLeft, toggleRight } = useUi();
  const dragStart = useRef(rightWidth);

  useEffect(() => {
    init();
    // block any in-webview navigation away from the app (e.g. dropped links)
    const stopDrop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stopDrop);
    window.addEventListener("drop", stopDrop);
    // Ctrl/Cmd+B: left panel, Ctrl/Cmd+Shift+B: right panel
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "b") return;
      e.preventDefault();
      if (e.shiftKey) toggleRight();
      else toggleLeft();
    };
    window.addEventListener("keydown", onKey);
    // keep the right panel within bounds when the window shrinks
    const onResize = () => {
      const { rightWidth: w, leftOpen: l } = useUi.getState();
      const max = maxRightWidth(l);
      if (w > max) useUi.getState().setRightWidth(max);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("dragover", stopDrop);
      window.removeEventListener("drop", stopDrop);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [init, toggleLeft, toggleRight]);

  if (!vault) return <div className="boot" />;
  if (!vault.unlocked) return <Unlock />;

  const showCode = mode === "code" && current?.mode === "code";
  const width = Math.min(Math.max(rightWidth, RIGHT_MIN), maxRightWidth(leftOpen));

  return (
    <div className="app">
      <div className={`left-slot ${leftOpen ? "" : "closed"}`} aria-hidden={!leftOpen}>
        <Sidebar />
      </div>
      <main className="main">
        <ChatPane hasRight={showCode} />
      </main>
      {showCode && (
        <>
          {rightOpen && <Resizer
            dir="col"
            title="드래그해서 크기 조절 · 더블클릭으로 기본 크기"
            onStart={() => (dragStart.current = width)}
            onDrag={(dx) =>
              setRightWidth(Math.min(Math.max(dragStart.current - dx, RIGHT_MIN), maxRightWidth(leftOpen)))
            }
            onReset={() => setRightWidth(Math.min(RIGHT_DEFAULT, maxRightWidth(leftOpen)))}
          />}
          {/* stays mounted while hidden so the open file / expanded folders survive a toggle */}
          <div className={`right-slot ${rightOpen ? "" : "closed"}`} style={{ width }} aria-hidden={!rightOpen}>
            <CodeSide />
          </div>
        </>
      )}
      {settingsOpen && <Settings />}
      <ApprovalDialog />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
