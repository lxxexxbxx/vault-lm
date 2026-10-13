import { api, errMsg } from "../api";

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders under a directory of the workspace (recursive, gitignore-aware).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory, '' for workspace root" },
          depth: { type: "integer", description: "Max depth, default 2" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file. For large files pass start_line/end_line (1-based, inclusive).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Regex search across workspace files. Returns path:line: text.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string", description: "Optional sub-directory" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with full content.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exactly one occurrence of old_string with new_string in a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the workspace root (sh on macOS/Linux, PowerShell on Windows). Returns exit code and output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, timeout_secs: { type: "integer" } },
        required: ["command"],
      },
    },
  },
];

const READ_ONLY = new Set(["list_dir", "read_file", "search"]);

export interface ApprovalRequest {
  tool: string;
  title: string;
  detail: string;
}

export type Approver = (req: ApprovalRequest) => Promise<boolean>;

function describe(name: string, a: Record<string, any>): ApprovalRequest {
  switch (name) {
    case "write_file":
      return { tool: name, title: `파일 쓰기: ${a.path}`, detail: String(a.content ?? "") };
    case "edit_file":
      return {
        tool: name,
        title: `파일 수정: ${a.path}`,
        detail: `--- 기존\n${a.old_string}\n+++ 변경\n${a.new_string}`,
      };
    case "run_command":
      return { tool: name, title: "명령 실행", detail: String(a.command ?? "") };
    default:
      return { tool: name, title: name, detail: JSON.stringify(a, null, 2) };
  }
}

/** Hard cap per tool result so one big file can't flood the context window. */
const MAX_TOOL_CHARS = 14000;

function capOutput(name: string, out: string): string {
  if (out.length <= MAX_TOOL_CHARS) return out;
  const hint =
    name === "read_file"
      ? "start_line/end_line로 나머지 부분을 읽을 것"
      : name === "list_dir"
        ? "더 좁은 path나 낮은 depth로 다시 호출할 것"
        : "더 좁은 범위로 다시 호출할 것";
  return `${out.slice(0, MAX_TOOL_CHARS)}\n…[출력 ${out.length.toLocaleString()}자 중 앞 ${MAX_TOOL_CHARS.toLocaleString()}자만 표시. ${hint}]`;
}

export async function runTool(
  name: string,
  rawArgs: string,
  root: string,
  approve: Approver,
  autoApproveReads: boolean,
): Promise<string> {
  return capOutput(name, await runToolRaw(name, rawArgs, root, approve, autoApproveReads));
}

async function runToolRaw(
  name: string,
  rawArgs: string,
  root: string,
  approve: Approver,
  autoApproveReads: boolean,
): Promise<string> {
  let a: Record<string, any>;
  try {
    a = rawArgs?.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return `Error: arguments were not valid JSON: ${rawArgs.slice(0, 200)}`;
  }
  if (!(READ_ONLY.has(name) && autoApproveReads)) {
    const ok = await approve(describe(name, a));
    if (!ok) return "Error: the user denied this action. Ask what they want instead.";
  }
  try {
    switch (name) {
      case "list_dir": {
        const entries = await api.wsTree(root, a.path ?? "", Math.min(Number(a.depth ?? 2), 6));
        if (!entries.length) return "(empty)";
        return entries.map((e) => (e.isDir ? `${e.path}/` : `${e.path} (${e.size}b)`)).join("\n");
      }
      case "read_file":
        return await api.wsRead(root, a.path, a.start_line, a.end_line);
      case "search":
        return await api.wsSearch(root, a.pattern, a.path);
      case "write_file":
        return await api.wsWrite(root, a.path, a.content ?? "");
      case "edit_file":
        return await api.wsEdit(root, a.path, a.old_string ?? "", a.new_string ?? "");
      case "run_command":
        return await api.wsRun(root, a.command, a.timeout_secs);
      default:
        return `Error: unknown tool ${name}`;
    }
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}
