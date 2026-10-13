import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "../store";
import { Markdown, MessageView, Reasoning } from "./MessageView";
import { estTokens, splitThink } from "../lib/context";

export function ChatPane() {
  const { current, streaming, send, stop, regenerate, compress, lastStats, cfg, setWorkspace, mode, newSession, server } =
    useApp();
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [current?.messages.length, streaming?.text, streaming?.reasoning, streaming?.tool]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 260) + "px";
  }, [text]);

  if (!current) {
    return (
      <div className="empty">
        <div className="logo lg" />
        <h2>{mode === "code" ? "로컬 코드 에이전트" : "무엇을 도와드릴까요?"}</h2>
        <p className="muted">
          모든 추론은 이 PC에서만 실행되고, 대화는 암호화되어 저장됩니다.
          {!server?.ready && " 왼쪽 아래에서 모델 서버를 먼저 시작하세요."}
        </p>
        <button
          className="primary"
          onClick={async () => {
            if (mode === "code") {
              const dir = await open({ directory: true, title: "워크스페이스 폴더 선택" });
              if (typeof dir === "string") newSession("code", dir);
            } else newSession("chat");
          }}
        >
          {mode === "code" ? "폴더 열고 시작" : "새 대화 시작"}
        </button>
      </div>
    );
  }

  const submit = () => {
    if (!text.trim() || streaming) return;
    send(text);
    setText("");
    stick.current = true;
  };

  const ctxUsed = current.messages.filter((m) => !m.deleted).reduce((n, m) => n + estTokens(m.content), 0);
  const ctxPct = cfg ? Math.min(100, Math.round((ctxUsed / cfg.llm.context_tokens) * 100)) : 0;
  const live = streaming && streaming.requestId !== "compress" ? splitThink(streaming.text) : null;
  const lastIsAssistant = [...current.messages].reverse().find((m) => !m.deleted)?.role !== "user";

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="ellipsis">
          <b>{current.title}</b>
          {current.mode === "code" && (
            <button
              className="ws-chip"
              title="워크스페이스 변경"
              onClick={async () => {
                const dir = await open({ directory: true, title: "워크스페이스 폴더 선택" });
                if (typeof dir === "string") setWorkspace(dir);
              }}
            >
              {current.workspace ?? "폴더 선택"}
            </button>
          )}
        </div>
        <div className="row gap">
          <span className={`ctx ${ctxPct > 85 ? "hot" : ""}`} title="대략적인 맥락 사용량">
            맥락 {ctxPct}%
          </span>
          {current.summary && <span className="ctx" title={current.summary}>요약 적용됨</span>}
          <button className="ghost sm" onClick={() => compress()} disabled={!!streaming} title="오래된 메시지를 요약해 맥락을 확보">
            맥락 압축
          </button>
        </div>
      </header>

      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="messages-inner">
          {current.messages.map((m) => (
            <MessageView key={m.id} m={m} />
          ))}
          {streaming && (
            <div className="msg assistant">
              <Reasoning text={streaming.reasoning || live?.reasoning || ""} live />
              {live?.answer && <Markdown text={live.answer} />}
              {streaming.tool && <div className="tool-call live">{streaming.tool}</div>}
              {!streaming.text && !streaming.reasoning && !streaming.tool && <div className="typing">●●●</div>}
            </div>
          )}
          {!streaming && lastStats && current.messages.length > 0 && <div className="stats">{lastStats}</div>}
          {!streaming && lastIsAssistant && current.messages.length > 0 && (
            <div className="row">
              <button className="ghost sm" onClick={regenerate}>
                다시 생성
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="composer">
        <textarea
          ref={taRef}
          value={text}
          placeholder={current.mode === "code" ? "무엇을 만들거나 고칠까요?" : "메시지 입력 (Shift+Enter 줄바꿈)"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {streaming ? (
          <button className="stop" onClick={stop}>
            중지
          </button>
        ) : (
          <button className="primary send" onClick={submit} disabled={!text.trim()}>
            전송
          </button>
        )}
      </div>
    </div>
  );
}
