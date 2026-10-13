import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";
import { api, errMsg } from "../api";
import { useApp } from "../store";
import type { FileEntry } from "../types";
import { useUi } from "../ui";
import { Resizer } from "./Resizer";

interface Node {
  name: string;
  path: string;
  isDir: boolean;
  children: Node[];
}

function buildTree(entries: FileEntry[]): Node[] {
  const root: Node = { name: "", path: "", isDir: true, children: [] };
  const index = new Map<string, Node>([["", root]]);
  for (const e of entries) {
    const parts = e.path.split("/");
    let parentPath = "";
    for (let i = 0; i < parts.length; i++) {
      const p = parts.slice(0, i + 1).join("/");
      if (!index.has(p)) {
        const n: Node = { name: parts[i], path: p, isDir: i < parts.length - 1 || e.isDir, children: [] };
        index.get(parentPath)!.children.push(n);
        index.set(p, n);
      }
      parentPath = p;
    }
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function TreeNode({ n, depth, onOpen, sel }: { n: Node; depth: number; onOpen: (p: string) => void; sel: string | null }) {
  const [open, setOpen] = useState(depth < 1);
  return (
    <>
      <div
        className={`tree-row ${sel === n.path ? "sel" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (n.isDir ? setOpen(!open) : onOpen(n.path))}
      >
        <span className="tw">{n.isDir ? (open ? "▾" : "▸") : ""}</span>
        <span className={n.isDir ? "dir" : ""}>{n.name}</span>
      </div>
      {open && n.children.map((c) => <TreeNode key={c.path} n={c} depth={depth + 1} onOpen={onOpen} sel={sel} />)}
    </>
  );
}

export function CodeSide() {
  const { current, streaming } = useApp();
  const root = current?.workspace ?? null;
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const { treeRatio, setTreeRatio } = useUi();
  const boxRef = useRef<HTMLElement>(null);
  const ratioStart = useRef(treeRatio);

  const refresh = useCallback(async () => {
    if (!root) return;
    try {
      setEntries(await api.wsTree(root, "", 6));
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, [root]);

  const openFile = useCallback(
    async (p: string) => {
      if (!root) return;
      setSel(p);
      try {
        setContent(await api.wsRead(root, p));
      } catch (e) {
        setContent(`// ${errMsg(e)}`);
      }
    },
    [root],
  );

  useEffect(() => {
    setSel(null);
    setContent("");
    refresh();
  }, [refresh]);

  // refresh after each agent step finishes (files may have changed)
  useEffect(() => {
    if (!streaming) {
      refresh();
      if (sel) openFile(sel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming?.step, !!streaming]);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const html = useMemo(() => {
    if (!sel || !content) return "";
    const ext = sel.split(".").pop() ?? "";
    try {
      return hljs.getLanguage(ext)
        ? hljs.highlight(content, { language: ext }).value
        : hljs.highlightAuto(content.slice(0, 200_000)).value;
    } catch {
      return content.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    }
  }, [sel, content]);

  if (!root) return <aside className="code-side muted pad">워크스페이스가 없습니다</aside>;

  return (
    <aside className="code-side" ref={boxRef} style={{ gridTemplateRows: `minmax(0, ${treeRatio}fr) auto minmax(0, ${1 - treeRatio}fr)` }}>
      <div className="tree">
        <div className="pane-head">
          <span className="ellipsis">{root.split(/[\\/]/).pop()}</span>
          <button className="ghost sm" onClick={refresh}>
            새로고침
          </button>
        </div>
        {err && <div className="error small">{err}</div>}
        <div className="tree-body">
          {tree.map((n) => (
            <TreeNode key={n.path} n={n} depth={0} onOpen={openFile} sel={sel} />
          ))}
        </div>
      </div>
      <Resizer
        dir="row"
        title="드래그해서 트리/뷰어 비율 조절 · 더블클릭으로 기본값"
        onStart={() => (ratioStart.current = treeRatio)}
        onDrag={(dy) => setTreeRatio(ratioStart.current + dy / (boxRef.current?.clientHeight || 1))}
        onReset={() => setTreeRatio(0.38)}
      />
      <div className="viewer">
        <div className="pane-head">
          <span className="ellipsis">{sel ?? "파일을 선택하세요"}</span>
        </div>
        {sel && (
          <pre className="viewer-body hljs">
            <code dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
        )}
      </div>
    </aside>
  );
}
