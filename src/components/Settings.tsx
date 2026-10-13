import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errMsg, uid } from "../api";
import { useApp } from "../store";
import type { AppConfig, ModelProfile } from "../types";

type Tab = "server" | "gen" | "storage" | "security";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Settings() {
  const { cfg, saveConfig, setSettingsOpen, server, pollServer, vault, refreshVault, syncAll, showToast, afterUnlock } =
    useApp();
  const [tab, setTab] = useState<Tab>("server");
  const [c, setC] = useState<AppConfig>(structuredClone(cfg!));
  const [models, setModels] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (tab !== "server") return;
    const t = setInterval(async () => setLogs(await api.serverLogs()), 1500);
    api.serverLogs().then(setLogs);
    return () => clearInterval(t);
  }, [tab]);

  const up = (fn: (d: AppConfig) => void) =>
    setC((prev) => {
      const d = structuredClone(prev);
      fn(d);
      return d;
    });

  const active = c.server.profiles.find((p) => p.id === c.server.active_profile) ?? c.server.profiles[0];
  const upProfile = (fn: (p: ModelProfile) => void) =>
    up((d) => {
      const p = d.server.profiles.find((x) => x.id === active?.id);
      if (p) fn(p);
    });

  const save = async (close = true) => {
    try {
      await saveConfig(c);
      if (close) setSettingsOpen(false);
      return true;
    } catch (e) {
      showToast(errMsg(e));
      return false;
    }
  };

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      showToast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={() => setSettingsOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-side">
          <h3>설정</h3>
          {(
            [
              ["server", "모델 서버"],
              ["gen", "생성 · 맥락"],
              ["storage", "저장소 · 동기화"],
              ["security", "보안"],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {tab === "server" && (
            <>
              <Field label="llama-server 실행 파일" hint="비워두면 PATH에서 찾습니다. CUDA 빌드를 받으세요 (Windows: llama-*-bin-win-cuda-*.zip).">
                <div className="row gap">
                  <input
                    className="grow"
                    value={c.server.llama_server_path}
                    onChange={(e) => up((d) => void (d.server.llama_server_path = e.target.value))}
                  />
                  <button
                    className="ghost"
                    onClick={async () => {
                      const f = await open({ title: "llama-server 선택" });
                      if (typeof f === "string") up((d) => void (d.server.llama_server_path = f));
                    }}
                  >
                    찾기
                  </button>
                </div>
              </Field>

              <Field label="모델 프로필" hint="프로필만 바꾸면 다른 모델로 교체됩니다. 서버는 항상 127.0.0.1에만 바인딩됩니다.">
                <div className="row gap">
                  <select
                    className="grow"
                    value={active?.id}
                    onChange={(e) => up((d) => void (d.server.active_profile = e.target.value))}
                  >
                    {c.server.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="ghost"
                    onClick={() =>
                      up((d) => {
                        const p: ModelProfile = {
                          id: uid(),
                          name: "새 프로필",
                          model_path: "",
                          port: 8080,
                          ctx_size: 32768,
                          extra_args: "-ngl 99 -fa on --jinja",
                        };
                        d.server.profiles.push(p);
                        d.server.active_profile = p.id;
                      })
                    }
                  >
                    추가
                  </button>
                  <button
                    className="ghost danger"
                    disabled={c.server.profiles.length <= 1}
                    onClick={() =>
                      up((d) => {
                        d.server.profiles = d.server.profiles.filter((p) => p.id !== active?.id);
                        d.server.active_profile = d.server.profiles[0]?.id ?? null;
                      })
                    }
                  >
                    삭제
                  </button>
                </div>
              </Field>

              {active && (
                <div className="card">
                  <Field label="이름">
                    <input value={active.name} onChange={(e) => upProfile((p) => void (p.name = e.target.value))} />
                  </Field>
                  <Field label="GGUF 모델 파일">
                    <div className="row gap">
                      <input
                        className="grow"
                        value={active.model_path}
                        onChange={(e) => upProfile((p) => void (p.model_path = e.target.value))}
                      />
                      <button
                        className="ghost"
                        onClick={async () => {
                          const f = await open({ title: "GGUF 선택", filters: [{ name: "GGUF", extensions: ["gguf"] }] });
                          if (typeof f === "string") upProfile((p) => void (p.model_path = f));
                        }}
                      >
                        찾기
                      </button>
                    </div>
                  </Field>
                  <div className="row gap">
                    <Field label="포트">
                      <input
                        type="number"
                        value={active.port}
                        onChange={(e) => upProfile((p) => void (p.port = Number(e.target.value)))}
                      />
                    </Field>
                    <Field label="컨텍스트 (-c)">
                      <input
                        type="number"
                        value={active.ctx_size}
                        onChange={(e) => upProfile((p) => void (p.ctx_size = Number(e.target.value)))}
                      />
                    </Field>
                  </div>
                  <Field
                    label="추가 인자"
                    hint="MoE 예: -ngl 99 --n-cpu-moe 30 -fa on --jinja  /  Dense 예: -ngl 28 -fa on --jinja. VRAM이 넘치면 --n-cpu-moe를 올리세요."
                  >
                    <input
                      className="mono"
                      value={active.extra_args}
                      onChange={(e) => upProfile((p) => void (p.extra_args = e.target.value))}
                    />
                  </Field>
                </div>
              )}

              <label className="check">
                <input
                  type="checkbox"
                  checked={c.server.auto_start}
                  onChange={(e) => up((d) => void (d.server.auto_start = e.target.checked))}
                />
                앱 시작 시 서버 자동 실행
              </label>

              <div className="row gap">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    wrap(async () => {
                      if (!(await save(false))) return;
                      await api.serverStart(active?.id);
                      const fresh = await api.getConfig();
                      setC(fresh);
                      useApp.setState({ cfg: fresh });
                      pollServer();
                    })
                  }
                >
                  {server?.running ? "이 프로필로 재시작" : "저장 후 서버 시작"}
                </button>
                {server?.running && (
                  <button className="ghost" onClick={() => wrap(async () => (await api.serverStop(), pollServer()))}>
                    중지
                  </button>
                )}
                <span className="muted small">
                  {server?.ready ? "응답 중" : server?.running ? "로딩 중…" : "꺼짐"}
                  {server?.pid ? ` · pid ${server.pid}` : ""}
                </span>
              </div>
              <pre className="logs">{logs.slice(-200).join("\n") || "(로그 없음)"}</pre>
            </>
          )}

          {tab === "gen" && (
            <>
              <Field
                label="엔드포인트 (OpenAI 호환)"
                hint="localhost/127.0.0.1만 허용. 서버 시작 시 자동으로 맞춰집니다. Ollama: http://127.0.0.1:11434/v1"
              >
                <input value={c.llm.base_url} onChange={(e) => up((d) => void (d.llm.base_url = e.target.value))} />
              </Field>
              <Field label="모델 이름" hint="llama-server는 아무 값이나 받습니다. Ollama는 모델 태그가 필요합니다.">
                <div className="row gap">
                  <input
                    className="grow"
                    list="models"
                    value={c.llm.model}
                    onChange={(e) => up((d) => void (d.llm.model = e.target.value))}
                  />
                  <datalist id="models">
                    {models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <button className="ghost" onClick={() => wrap(async () => setModels(await api.llmModels()))}>
                    불러오기
                  </button>
                </div>
              </Field>
              <div className="row gap">
                <Field label="temperature">
                  <input
                    type="number"
                    step="0.05"
                    value={c.llm.temperature}
                    onChange={(e) => up((d) => void (d.llm.temperature = Number(e.target.value)))}
                  />
                </Field>
                <Field label="top_p">
                  <input
                    type="number"
                    step="0.05"
                    value={c.llm.top_p}
                    onChange={(e) => up((d) => void (d.llm.top_p = Number(e.target.value)))}
                  />
                </Field>
                <Field label="max_tokens">
                  <input
                    type="number"
                    value={c.llm.max_tokens}
                    onChange={(e) => up((d) => void (d.llm.max_tokens = Number(e.target.value)))}
                  />
                </Field>
              </div>
              <Field
                label="프롬프트 예산 (토큰)"
                hint="서버 컨텍스트(-c)에서 max_tokens를 뺀 값보다 작게. 넘치는 오래된 메시지는 자동 제외되고, '맥락 압축'으로 요약할 수 있습니다."
              >
                <input
                  type="number"
                  value={c.llm.context_tokens}
                  onChange={(e) => up((d) => void (d.llm.context_tokens = Number(e.target.value)))}
                />
              </Field>
              <Field label="시스템 프롬프트 · Chat">
                <textarea
                  rows={4}
                  value={c.llm.system_prompt_chat}
                  onChange={(e) => up((d) => void (d.llm.system_prompt_chat = e.target.value))}
                />
              </Field>
              <Field label="시스템 프롬프트 · Code">
                <textarea
                  rows={4}
                  value={c.llm.system_prompt_code}
                  onChange={(e) => up((d) => void (d.llm.system_prompt_code = e.target.value))}
                />
              </Field>
            </>
          )}

          {tab === "storage" && (
            <>
              <Field
                label="금고 폴더"
                hint={`현재: ${vault?.vaultDir}. 비우면 기본 위치. 'Google Drive for Desktop' 동기화 폴더를 지정해도 됩니다 (파일은 이미 암호화됨). 바꾸면 다시 잠금 해제해야 합니다.`}
              >
                <div className="row gap">
                  <input className="grow" value={c.vault_dir} onChange={(e) => up((d) => void (d.vault_dir = e.target.value))} />
                  <button
                    className="ghost"
                    onClick={async () => {
                      const dir = await open({ directory: true, title: "금고 폴더" });
                      if (typeof dir === "string") up((d) => void (d.vault_dir = dir));
                    }}
                  >
                    찾기
                  </button>
                </div>
              </Field>

              <div className="card">
                <h4>구글 드라이브 동기화 (종단간 암호화)</h4>
                <p className="muted small">
                  앱 전용 숨김 폴더(appDataFolder)만 접근하는 권한을 씁니다. 업로드되는 것은 암호화된 파일뿐이고, 파일명도 무작위
                  ID라 구글은 제목·내용을 볼 수 없습니다. Client ID는 본인 Google Cloud 프로젝트에서 "데스크톱 앱" 유형으로
                  만드세요 (README 참고).
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={c.drive.enabled}
                    onChange={(e) => up((d) => void (d.drive.enabled = e.target.checked))}
                  />
                  드라이브 동기화 사용
                </label>
                <Field label="OAuth Client ID">
                  <input value={c.drive.client_id} onChange={(e) => up((d) => void (d.drive.client_id = e.target.value))} />
                </Field>
                <Field label="Client Secret">
                  <input
                    type="password"
                    value={c.drive.client_secret}
                    onChange={(e) => up((d) => void (d.drive.client_secret = e.target.value))}
                  />
                </Field>
                <Field label="자동 동기화 주기 (초)">
                  <input
                    type="number"
                    value={c.drive.auto_sync_secs}
                    onChange={(e) => up((d) => void (d.drive.auto_sync_secs = Number(e.target.value)))}
                  />
                </Field>
                <div className="row gap">
                  {vault?.driveConnected ? (
                    <>
                      <span className="badge ok">연결됨</span>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          wrap(async () => {
                            if (!(await save(false))) return;
                            await afterUnlock();
                            await syncAll();
                            showToast("동기화 완료");
                          })
                        }
                      >
                        저장 후 지금 동기화
                      </button>
                      <button
                        className="ghost danger"
                        onClick={() =>
                          wrap(async () => {
                            await api.driveDisconnect();
                            await refreshVault();
                            useApp.setState({ sync: { status: "off" } });
                          })
                        }
                      >
                        연결 해제
                      </button>
                    </>
                  ) : (
                    <button
                      className="primary"
                      disabled={busy || !c.drive.client_id}
                      onClick={() =>
                        wrap(async () => {
                          const next = { ...c, drive: { ...c.drive, enabled: true } };
                          setC(next);
                          await saveConfig(next);
                          await api.driveConnect();
                          await refreshVault();
                          await afterUnlock();
                          showToast("드라이브 연결 완료");
                        })
                      }
                    >
                      {busy ? "브라우저에서 로그인 중…" : "저장 후 구글 계정 연결"}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {tab === "security" && (
            <>
              <div className="card">
                <h4>네트워크 차단 정책</h4>
                <ul className="small muted">
                  <li>화면(웹뷰)은 CSP로 모든 외부 네트워크가 막혀 있습니다.</li>
                  <li>LLM 요청은 Rust에서 루프백 주소만 허용하며, 리다이렉트와 시스템 프록시를 쓰지 않습니다.</li>
                  <li>llama-server는 강제로 127.0.0.1에만 바인딩됩니다.</li>
                  <li>외부 통신은 사용자가 켠 구글 드라이브 동기화(암호문)뿐입니다.</li>
                </ul>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={c.allow_private_lan}
                  onChange={(e) => up((d) => void (d.allow_private_lan = e.target.checked))}
                />
                사설망/Tailscale IP의 LLM 서버도 허용 (예: 집 데스크톱 GPU 서버)
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={c.auto_approve_reads}
                  onChange={(e) => up((d) => void (d.auto_approve_reads = e.target.checked))}
                />
                Code 모드: 읽기 전용 도구(목록/읽기/검색)는 자동 승인
              </label>
              <div className="row gap">
                <button
                  className="ghost danger"
                  onClick={async () => {
                    await api.vaultLock(true);
                    try {
                      sessionStorage.setItem("vlm-locked", "1");
                    } catch {
                      /* ignore */
                    }
                    location.reload();
                  }}
                >
                  잠그고 이 기기에서 키 삭제
                </button>
              </div>
            </>
          )}

          <div className="modal-foot">
            <button className="ghost" onClick={() => setSettingsOpen(false)}>
              닫기
            </button>
            <button className="primary" onClick={() => save(true)}>
              저장
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
