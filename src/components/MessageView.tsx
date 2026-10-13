import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Message } from "../types";

function CodeBlock(props: any) {
  const { children, className, node: _n, ...rest } = props;
  const inline = !className && !String(children).includes("\n");
  if (inline) return <code {...rest}>{children}</code>;
  return (
    <code className={className} {...rest}>
      {children}
    </code>
  );
}

function Pre({ children }: any) {
  const [copied, setCopied] = useState(false);
  const text = extractText(children);
  return (
    <div className="codewrap">
      <button
        className="copy"
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? "복사됨" : "복사"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

function extractText(n: any): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(extractText).join("");
  return extractText(n.props?.children);
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{ code: CodeBlock, pre: Pre, a: ({ children }) => <span className="link">{children}</span> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export function Reasoning({ text, live }: { text: string; live?: boolean }) {
  if (!text) return null;
  return (
    <details className="reasoning" open={live}>
      <summary>{live ? "생각 중…" : "생각 과정"}</summary>
      <div className="reasoning-body">{text}</div>
    </details>
  );
}

function shortArgs(raw: string) {
  try {
    const a = JSON.parse(raw);
    if (a.path && a.command === undefined) return a.path;
    if (a.command) return a.command;
    if (a.pattern) return a.pattern;
    return raw.slice(0, 80);
  } catch {
    return raw.slice(0, 80);
  }
}

export const MessageView = memo(function MessageView({ m }: { m: Message }) {
  if (m.deleted) return null;
  if (m.role === "user")
    return (
      <div className="msg user">
        <div className="bubble">{m.content}</div>
      </div>
    );
  if (m.role === "tool") {
    const isErr = m.content.startsWith("Error:");
    return (
      <details className={`tool-result ${isErr ? "err" : ""}`}>
        <summary>
          {isErr ? "실패" : "결과"} · {m.name} · {m.content.length.toLocaleString()}자
        </summary>
        <pre>{m.content.length > 20000 ? m.content.slice(0, 20000) + "\n…" : m.content}</pre>
      </details>
    );
  }
  return (
    <div className="msg assistant">
      <Reasoning text={m.reasoning ?? ""} />
      {m.content && <Markdown text={m.content} />}
      {m.tool_calls?.map((t) => (
        <div key={t.id} className="tool-call">
          <span className="tool-name">{t.function.name}</span>
          <code>{shortArgs(t.function.arguments)}</code>
        </div>
      ))}
    </div>
  );
});
