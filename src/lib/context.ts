import type { Message, Session } from "../types";

/**
 * Token estimate for mixed Korean/English/code. Hangul syllables cost
 * roughly one token each with Qwen's tokenizer; ASCII text/code ~3.5 chars.
 * Deliberately a little pessimistic.
 */
export function estTokens(s: string): number {
  let hangul = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xac00 && c <= 0xd7a3) hangul++;
  }
  return Math.ceil(hangul * 1.1 + (s.length - hangul) / 3.2) + 6;
}

/** Splits inline <think>…</think> (some templates emit it in content). */
export function splitThink(content: string): { reasoning: string; answer: string } {
  const open = content.indexOf("<think>");
  if (open === -1) return { reasoning: "", answer: content };
  const close = content.indexOf("</think>", open);
  if (close === -1) return { reasoning: content.slice(open + 7), answer: content.slice(0, open) };
  return {
    reasoning: content.slice(open + 7, close).trim(),
    answer: (content.slice(0, open) + content.slice(close + 8)).trim(),
  };
}

type OAIMessage = {
  role: string;
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
};

function toOAI(m: Message): OAIMessage {
  const o: OAIMessage = { role: m.role, content: m.content };
  if (m.role === "assistant" && m.tool_calls?.length) {
    o.tool_calls = m.tool_calls;
    if (!m.content) o.content = null;
  }
  if (m.role === "tool") {
    o.tool_call_id = m.tool_call_id;
    o.name = m.name;
  }
  return o;
}

const cost = (m: Message) => estTokens(m.content) + (m.tool_calls ? estTokens(JSON.stringify(m.tool_calls)) : 0);
const costAll = (ms: Message[]) => ms.reduce((n, m) => n + cost(m), 0);

/** Replaces a tool result with a short stub (keeps tool_call_id pairing valid). */
function stubTool(m: Message, keepChars: number): Message {
  if (m.content.length <= keepChars + 200) return m;
  const head = m.content.slice(0, keepChars);
  return {
    ...m,
    content: `${head}\n…[${m.name} 결과 ${m.content.length.toLocaleString()}자 중 일부만 표시. 필요하면 도구를 다시 호출할 것]`,
  };
}

/** Splits messages into turns; each turn starts at a user message. */
function toTurns(msgs: Message[]): Message[][] {
  const turns: Message[][] = [];
  for (const m of msgs) {
    if (m.role === "user" || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1].push(m);
  }
  return turns;
}

/**
 * Builds the prompt so the model never loses the task it is working on:
 *
 * 1. The current turn (latest user message + every tool exchange after it)
 *    is ALWAYS included. If it is too big, older tool results inside it are
 *    shrunk to stubs, oldest first — the user's request itself is never cut.
 * 2. Earlier turns are added newest-first as whole turns (never split, so
 *    tool_call / tool_result pairs stay intact), with their tool outputs
 *    stubbed since past file dumps are rarely needed again.
 * 3. Reasoning traces are never sent back.
 */
export function buildPrompt(
  session: Session,
  system: string,
  budget: number,
): { messages: OAIMessage[]; dropped: number } {
  let msgs = session.messages.filter((m) => !m.deleted);
  let sys = system;
  if (session.summary && session.summary_until) {
    const idx = msgs.findIndex((m) => m.id === session.summary_until);
    if (idx >= 0) {
      msgs = msgs.slice(idx + 1);
      sys += `\n\n[Summary of earlier conversation]\n${session.summary}`;
    }
  }
  const turns = toTurns(msgs);
  const current = turns.pop() ?? [];
  let room = budget - estTokens(sys);

  // 1) current turn, shrinking its oldest tool results until it fits
  let cur = [...current];
  for (const keep of [2000, 600, 150]) {
    if (costAll(cur) <= room) break;
    const toolIdx = cur.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
    // always keep the newest tool result at full size if possible
    for (const i of toolIdx.slice(0, -1)) {
      cur[i] = stubTool(cur[i], keep);
      if (costAll(cur) <= room) break;
    }
  }
  if (costAll(cur) > room) {
    const last = cur.length - 1;
    if (cur[last]?.role === "tool") cur[last] = stubTool(cur[last], Math.max(500, (room - costAll(cur.slice(0, -1))) * 3));
  }
  room -= costAll(cur);

  // 2) earlier turns, whole, newest first
  const prev: Message[][] = [];
  let dropped = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i].map((m) => (m.role === "tool" ? stubTool(m, 400) : m));
    const c = costAll(t);
    if (c > room) {
      dropped = turns.slice(0, i + 1).reduce((n, x) => n + x.length, 0);
      break;
    }
    room -= c;
    prev.unshift(t);
  }

  return {
    messages: [{ role: "system", content: sys }, ...prev.flat().map(toOAI), ...cur.map(toOAI)],
    dropped,
  };
}

/** Messages eligible for compression: everything except the last `keep` user turns. */
export function compressible(session: Session, keepTurns = 2): Message[] {
  const msgs = session.messages.filter((m) => !m.deleted);
  let start = 0;
  if (session.summary_until) {
    const idx = msgs.findIndex((m) => m.id === session.summary_until);
    if (idx >= 0) start = idx + 1;
  }
  const userIdx = msgs.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= start);
  if (userIdx.length <= keepTurns) return [];
  const cut = userIdx[userIdx.length - keepTurns];
  return msgs.slice(start, cut);
}

export function transcript(msgs: Message[]): string {
  return msgs
    .map((m) => {
      if (m.role === "tool") return `[tool ${m.name} result]\n${m.content.slice(0, 1500)}`;
      if (m.tool_calls?.length)
        return `ASSISTANT called: ${m.tool_calls.map((t) => `${t.function.name}(${t.function.arguments.slice(0, 300)})`).join(", ")}\n${m.content}`;
      return `${m.role.toUpperCase()}: ${m.content}`;
    })
    .join("\n\n");
}
