import { create } from "zustand";
import { api, errMsg, now, uid } from "./api";
import { buildPrompt, compressible, splitThink, transcript } from "./lib/context";
import { runTool, TOOLS, type ApprovalRequest } from "./lib/agent";
import type { AppConfig, Message, Mode, ServerStatus, Session, SessionMeta, VaultStatus } from "./types";

interface Streaming {
  requestId: string;
  text: string;
  reasoning: string;
  tool?: string;
  step: number;
}

interface Approval extends ApprovalRequest {
  resolve: (ok: boolean) => void;
}

interface SyncState {
  status: "off" | "idle" | "syncing" | "error";
  lastAt?: number;
  error?: string;
}

interface State {
  cfg: AppConfig | null;
  vault: VaultStatus | null;
  mode: Mode;
  sessions: SessionMeta[];
  current: Session | null;
  streaming: Streaming | null;
  server: ServerStatus | null;
  sync: SyncState;
  approval: Approval | null;
  settingsOpen: boolean;
  toast: string | null;
  lastStats: string | null;

  init(): Promise<void>;
  refreshVault(): Promise<void>;
  afterUnlock(): Promise<void>;
  saveConfig(cfg: AppConfig): Promise<void>;
  setMode(m: Mode): void;
  loadSessions(): Promise<void>;
  newSession(mode: Mode, workspace?: string): Promise<void>;
  openSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  togglePin(id: string): Promise<void>;
  persist(s: Session): Promise<void>;
  send(text: string): Promise<void>;
  regenerate(): Promise<void>;
  stop(): void;
  compress(silent?: boolean): Promise<void>;
  setWorkspace(path: string): Promise<void>;
  syncAll(): Promise<void>;
  pollServer(): Promise<void>;
  showToast(msg: string): void;
  setSettingsOpen(v: boolean): void;
}

let stopRequested = false;
let initialized = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncInterval: ReturnType<typeof setInterval> | null = null;
const pendingSync = new Set<string>();

function newMessage(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  const t = now();
  return { id: uid(), role, content, created_at: t, updated_at: t, ...extra };
}

export const useApp = create<State>((set, get) => ({
  cfg: null,
  vault: null,
  mode: "chat",
  sessions: [],
  current: null,
  streaming: null,
  server: null,
  sync: { status: "off" },
  approval: null,
  settingsOpen: false,
  toast: null,
  lastStats: null,

  async init() {
    if (initialized) return;
    initialized = true;
    const cfg = await api.getConfig();
    set({ cfg });
    await get().refreshVault();
    let manuallyLocked = false;
    try {
      manuallyLocked = sessionStorage.getItem("vlm-locked") === "1";
    } catch {
      /* ignore */
    }
    if (!manuallyLocked && get().vault?.exists && !get().vault?.unlocked && get().vault?.remembered) {
      if (await api.vaultAutoUnlock()) await get().refreshVault();
    }
    if (get().vault?.unlocked) await get().afterUnlock();
    get().pollServer();
    setInterval(() => get().pollServer(), 5000);
  },

  async refreshVault() {
    set({ vault: await api.vaultStatus() });
  },

  async afterUnlock() {
    try {
      sessionStorage.removeItem("vlm-locked");
    } catch {
      /* ignore */
    }
    await get().refreshVault();
    await get().loadSessions();
    const { cfg, vault } = get();
    if (cfg?.drive.enabled && vault?.driveConnected) {
      set({ sync: { status: "idle" } });
      get().syncAll();
      const every = Math.max(30, cfg.drive.auto_sync_secs || 120) * 1000;
      if (syncInterval) clearInterval(syncInterval);
      syncInterval = setInterval(() => {
        if (!get().streaming) get().syncAll();
      }, every);
    }
  },

  async saveConfig(cfg) {
    const prevDir = get().cfg?.vault_dir;
    await api.setConfig(cfg);
    set({ cfg });
    if (prevDir !== cfg.vault_dir) {
      await api.vaultLock(false);
      set({ current: null, sessions: [] });
      await get().refreshVault();
    }
  },

  setMode(m) {
    const cur = get().current;
    set({ mode: m, current: cur && cur.mode === m ? cur : null });
  },

  async loadSessions() {
    try {
      set({ sessions: await api.sessionsList() });
    } catch (e) {
      get().showToast(errMsg(e));
    }
  },

  async newSession(mode, workspace) {
    const t = now();
    const s: Session = {
      id: uid(),
      title: mode === "code" ? "새 코드 작업" : "새 대화",
      mode,
      workspace: workspace ?? null,
      created_at: t,
      updated_at: t,
      deleted: false,
      pinned: false,
      messages: [],
    };
    set({ current: s, mode });
  },

  async openSession(id) {
    if (get().streaming) return;
    try {
      const s = await api.sessionGet(id);
      set({ current: s, mode: s.mode });
    } catch (e) {
      get().showToast(errMsg(e));
    }
  },

  async deleteSession(id) {
    await api.sessionDelete(id);
    if (get().current?.id === id) set({ current: null });
    pendingSync.add(id);
    scheduleSync();
    await get().loadSessions();
  },

  async renameSession(id, title) {
    const s = get().current?.id === id ? get().current! : await api.sessionGet(id);
    await get().persist({ ...s, title, updated_at: now() });
  },

  async togglePin(id) {
    const s = get().current?.id === id ? get().current! : await api.sessionGet(id);
    await get().persist({ ...s, pinned: !s.pinned, updated_at: now() });
  },

  async persist(s) {
    if (get().current?.id === s.id) set({ current: s });
    await api.sessionSave(s);
    pendingSync.add(s.id);
    scheduleSync();
    // cheap meta refresh without re-decrypting everything
    const meta: SessionMeta = {
      id: s.id,
      title: s.title,
      mode: s.mode,
      workspace: s.workspace,
      created_at: s.created_at,
      updated_at: s.updated_at,
      pinned: s.pinned,
      message_count: s.messages.length,
    };
    const rest = get().sessions.filter((x) => x.id !== s.id);
    const list = [meta, ...rest].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
    set({ sessions: list });
  },

  async send(text) {
    const s = get().current;
    if (!s || get().streaming || !text.trim()) return;
    if (s.mode === "code" && !s.workspace) {
      get().showToast("먼저 워크스페이스 폴더를 선택하세요");
      return;
    }
    const updated = { ...s, messages: [...s.messages, newMessage("user", text)], updated_at: now() };
    await get().persist(updated);
    await runTurn(get, set);
  },

  async regenerate() {
    const s = get().current;
    if (!s || get().streaming) return;
    const msgs = [...s.messages];
    while (msgs.length && msgs[msgs.length - 1].role !== "user") msgs.pop();
    if (!msgs.length) return;
    // keep removed messages as tombstones so other devices drop them too
    const keep = new Set(msgs.map((m) => m.id));
    const t = now();
    const marked = s.messages.map((m) => (keep.has(m.id) ? m : { ...m, deleted: true, updated_at: t }));
    await get().persist({ ...s, messages: marked, updated_at: t });
    await runTurn(get, set);
  },

  stop() {
    stopRequested = true;
    const st = get().streaming;
    if (st) api.llmCancel(st.requestId);
    const a = get().approval;
    if (a) {
      a.resolve(false);
      set({ approval: null });
    }
  },

  async compress(silent = false) {
    const s = get().current;
    const cfg = get().cfg;
    if (!s || !cfg || get().streaming) return;
    const older = compressible(s, silent ? 1 : 2);
    if (older.length < 2) {
      if (!silent) get().showToast("압축할 만큼 오래된 대화가 없습니다");
      return;
    }
    set({ streaming: { requestId: "compress", text: "", reasoning: "", tool: "맥락 요약 중", step: 0 } });
    try {
      const prev = s.summary ? `Existing summary:\n${s.summary}\n\n` : "";
      const out = await api.llmComplete({
        model: cfg.llm.model,
        temperature: 0.2,
        max_tokens: 1200,
        messages: [
          {
            role: "system",
            content:
              "Summarize the conversation so it can replace the original history. Keep decisions, facts, file paths, code identifiers, open TODOs and user preferences. Write in the conversation's language. Be dense; no preamble.",
          },
          { role: "user", content: `${prev}New messages:\n${transcript(older)}` },
        ],
      });
      const summary = splitThink(out).answer.trim();
      await get().persist({ ...s, summary, summary_until: older[older.length - 1].id, updated_at: now() });
      get().showToast(`이전 메시지 ${older.length}개를 요약으로 압축했습니다`);
    } catch (e) {
      get().showToast(errMsg(e));
    } finally {
      set({ streaming: null });
    }
  },

  async setWorkspace(path) {
    const s = get().current;
    if (!s) return;
    await get().persist({ ...s, workspace: path, updated_at: now() });
  },

  async syncAll() {
    const { cfg, vault } = get();
    if (!cfg?.drive.enabled || !vault?.driveConnected || !vault.unlocked) return;
    set({ sync: { ...get().sync, status: "syncing" } });
    try {
      const r = await api.driveSyncAll();
      set({ sync: { status: "idle", lastAt: r.at } });
      if (r.downloaded > 0) {
        await get().loadSessions();
        const cur = get().current;
        if (cur && !get().streaming) {
          try {
            const fresh = await api.sessionGet(cur.id);
            if (fresh.updated_at !== cur.updated_at) set({ current: fresh.deleted ? null : fresh });
          } catch {
            /* new unsaved session */
          }
        }
      }
    } catch (e) {
      set({ sync: { status: "error", error: errMsg(e), lastAt: get().sync.lastAt } });
    }
  },

  async pollServer() {
    try {
      set({ server: await api.serverStatus() });
    } catch {
      /* ignore */
    }
  },

  showToast(msg) {
    set({ toast: msg });
    setTimeout(() => {
      if (get().toast === msg) set({ toast: null });
    }, 4500);
  },

  setSettingsOpen(v) {
    set({ settingsOpen: v });
  },
}));

function scheduleSync() {
  const { cfg, vault } = useApp.getState();
  if (!cfg?.drive.enabled || !vault?.driveConnected) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    if (useApp.getState().streaming) return scheduleSync();
    const ids = [...pendingSync];
    pendingSync.clear();
    useApp.setState({ sync: { ...useApp.getState().sync, status: "syncing" } });
    try {
      for (const id of ids) await api.driveSyncSession(id);
      useApp.setState({ sync: { status: "idle", lastAt: Date.now() } });
    } catch (e) {
      ids.forEach((i) => pendingSync.add(i));
      useApp.setState({ sync: { status: "error", error: errMsg(e), lastAt: useApp.getState().sync.lastAt } });
    }
  }, 4000);
}

type Get = () => State;
type Set = (p: Partial<State>) => void;

/** One assistant turn. Chat = single completion; Code = tool-calling loop. */
async function runTurn(get: Get, set: Set) {
  const cfg = get().cfg!;
  stopRequested = false;
  const maxSteps = 30;
  let anyDropped = false;
  // Prompt budget can never exceed what the running server can hold.
  const prof = cfg.server.profiles.find((p) => p.id === (get().server?.profileId ?? cfg.server.active_profile));
  const budget = prof
    ? Math.min(cfg.llm.context_tokens, prof.ctx_size - cfg.llm.max_tokens - 512)
    : cfg.llm.context_tokens;

  for (let step = 0; step < maxSteps; step++) {
    let s = get().current!;
    const isCode = s.mode === "code";
    const rules =
      "\n\nAlways reply in the same language as the user's latest message (Korean if they write in Korean)." +
      (isCode
        ? " Focus on the user's latest request. Gather what you need with tools, then stop calling tools and give a complete final answer. Prefer reading specific files or line ranges over dumping large files."
        : "");
    const system = isCode
      ? `${cfg.llm.system_prompt_code}${rules}\n\nWorkspace root: ${s.workspace}\nOS: ${navigator.platform}`
      : `${cfg.llm.system_prompt_chat}${rules}`;
    const { messages, dropped } = buildPrompt(s, system, Math.max(2048, budget));
    if (dropped > 0) anyDropped = true;
    const requestId = uid();

    // rAF-batched streaming updates keep the UI smooth at high tok/s
    let text = "";
    let reasoning = "";
    let tool: string | undefined;
    let raf = 0;
    const flush = () => {
      raf = 0;
      set({ streaming: { requestId, text, reasoning, tool, step } });
    };
    set({ streaming: { requestId, text: "", reasoning: "", step } });

    let res;
    try {
      res = await api.llmChat(
        requestId,
        {
          model: cfg.llm.model,
          messages,
          temperature: cfg.llm.temperature,
          top_p: cfg.llm.top_p,
          max_tokens: cfg.llm.max_tokens,
          ...(isCode ? { tools: TOOLS, tool_choice: "auto" } : {}),
        },
        (ev) => {
          if (ev.type === "token") text += ev.text;
          else if (ev.type === "reasoning") reasoning += ev.text;
          else if (ev.type === "toolCall") tool = ev.name;
          if (!raf) raf = requestAnimationFrame(flush);
        },
      );
    } catch (e) {
      if (raf) cancelAnimationFrame(raf);
      set({ streaming: null });
      get().showToast(errMsg(e));
      return;
    }
    if (raf) cancelAnimationFrame(raf);

    const split = splitThink(res.content);
    const assistant = newMessage("assistant", split.answer, {
      reasoning: (res.reasoning || split.reasoning) || undefined,
      tool_calls: res.toolCalls.length ? res.toolCalls : undefined,
      model: cfg.llm.model,
    });
    const stats = [
      res.tokensPerSec ? `${res.tokensPerSec.toFixed(1)} tok/s` : null,
      res.completionTokens ? `${res.completionTokens} tok` : null,
      dropped > 0 ? `이전 메시지 ${dropped}개 제외됨 (자동 요약 예정)` : null,
      res.cancelled ? "중단됨" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    set({ lastStats: stats || null });

    s = get().current!;
    if (assistant.content || assistant.tool_calls || assistant.reasoning) {
      s = { ...s, messages: [...s.messages, assistant], updated_at: now() };
      await get().persist(s);
    }

    if (s.messages.filter((m) => m.role === "assistant").length === 1 && step === 0 && !res.cancelled) {
      autoTitle(get, s).catch(() => {});
    }

    if (res.cancelled || stopRequested || !assistant.tool_calls?.length) break;

    // execute tool calls sequentially (each may need approval)
    for (const tc of assistant.tool_calls) {
      if (stopRequested) break;
      set({ streaming: { requestId, text: "", reasoning: "", tool: `${tc.function.name} 실행 중`, step } });
      const out = await runTool(
        tc.function.name,
        tc.function.arguments,
        s.workspace!,
        (req) =>
          new Promise<boolean>((resolve) => {
            set({ approval: { ...req, resolve } });
          }),
        cfg.auto_approve_reads,
      );
      set({ approval: null });
      const cur = get().current!;
      await get().persist({
        ...cur,
        messages: [...cur.messages, newMessage("tool", out, { tool_call_id: tc.id, name: tc.function.name })],
        updated_at: now(),
      });
    }
    if (stopRequested) break;
  }
  set({ streaming: null });
  // Older turns no longer fit: fold them into the rolling summary so the
  // next turn still "remembers" them instead of silently losing them.
  if (anyDropped && !stopRequested) await get().compress(true);
}

async function autoTitle(get: Get, s: Session) {
  const cfg = get().cfg!;
  const first = s.messages.find((m) => m.role === "user")?.content ?? "";
  const out = await api.llmComplete({
    model: cfg.llm.model,
    temperature: 0.3,
    max_tokens: 400,
    messages: [
      {
        role: "system",
        content:
          "Return only a short title (max 6 words) for this conversation, in the user's language. No quotes, no punctuation at the end. /no_think",
      },
      { role: "user", content: first.slice(0, 2000) },
    ],
  });
  const title = splitThink(out).answer.split("\n")[0].replace(/^["'#\s]+|["'\s]+$/g, "").slice(0, 60);
  if (!title) return;
  const cur = get().current;
  const base = cur?.id === s.id ? cur : await api.sessionGet(s.id);
  await get().persist({ ...base, title, updated_at: now() });
}
