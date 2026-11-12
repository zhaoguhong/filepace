import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  codeTokens,
  formatJson,
  parseDelimited,
  safePreviewLink,
  TABLE_COLUMN_LIMIT,
  TABLE_ROW_LIMIT,
  TEXT_PREVIEW_LIMIT,
  textPreviewKind,
} from "./textPreviewFormat";
import "./textPreview.css";

function HighlightedCode({ text }: { text: string }) {
  const tokens = useMemo(() => codeTokens(text), [text]);
  return (
    <pre className="text-preview-code">
      <code>
        {tokens.map((token, index) =>
          token.kind ? (
            <span className={`syntax-${token.kind}`} key={index}>
              {token.text}
            </span>
          ) : (
            <Fragment key={index}>{token.text}</Fragment>
          ),
        )}
      </code>
    </pre>
  );
}

function inline(source: string, depth = 0): ReactNode {
  if (depth >= 3) return source;
  const text = source.slice(0, 6_000);
  const pattern =
    /`([^`\n]+)`|(!?)\[([^\]\n]*)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|~~([^~\n]+)~~/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (nodes.length >= 300) break;
    const index = match.index!;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const key = String(index);
    if (match[1] !== undefined) nodes.push(<code key={key}>{match[1]}</code>);
    else if (match[3] !== undefined) {
      const href = safePreviewLink(match[4]);
      if (match[2])
        nodes.push(
          <span className="markdown-image-label" key={key}>
            [图片：{match[3] || "未命名"}]
          </span>,
        );
      else
        nodes.push(
          href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" key={key}>
              {inline(match[3], depth + 1)}
            </a>
          ) : (
            <span title={match[4]} key={key}>
              {inline(match[3], depth + 1)}
            </span>
          ),
        );
    } else if (match[5] || match[6])
      nodes.push(
        <strong key={key}>{inline(match[5] || match[6], depth + 1)}</strong>,
      );
    else if (match[7] || match[8])
      nodes.push(<em key={key}>{inline(match[7] || match[8], depth + 1)}</em>);
    else nodes.push(<del key={key}>{inline(match[9], depth + 1)}</del>);
    cursor = index + match[0].length;
  }
  nodes.push(source.slice(cursor));
  return nodes;
}

function markdownBlocks(text: string): ReactNode[] {
  const allLines = text.replace(/\r\n?/g, "\n").split("\n");
  const lines = allLines.slice(0, 2_000);
  const blocks: ReactNode[] = [];
  const startsBlock = (line: string) =>
    /^(?:\s*$| {0,3}#{1,6} | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}(?:[-+*]|\d+[.)]) | {0,3}(?:---+|\*\*\*+|___+)\s*$)/.test(
      line,
    );
  let i = 0;
  for (; i < lines.length && blocks.length < 1_000; i++) {
    const line = lines[i];
    const key = String(i);
    if (!line.trim()) continue;
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const contents: string[] = [];
      const close = new RegExp(
        `^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`,
      );
      while (++i < lines.length && !close.test(lines[i]))
        contents.push(lines[i]);
      blocks.push(
        <div className="markdown-fence" key={key}>
          {fence[2].trim() && <small>{fence[2].trim()}</small>}
          <HighlightedCode text={contents.join("\n")} />
        </div>,
      );
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const content = inline(heading[2]);
      blocks.push(
        heading[1].length === 1 ? (
          <h1 key={key}>{content}</h1>
        ) : heading[1].length === 2 ? (
          <h2 key={key}>{content}</h2>
        ) : heading[1].length === 3 ? (
          <h3 key={key}>{content}</h3>
        ) : (
          <h4 key={key}>{content}</h4>
        ),
      );
      continue;
    }
    if (/^ {0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      continue;
    }
    const quote = /^ {0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      const contents = [quote[1]];
      while (i + 1 < lines.length && /^ {0,3}>/.test(lines[i + 1]))
        contents.push(lines[++i].replace(/^ {0,3}>\s?/, ""));
      blocks.push(
        <blockquote key={key}>{inline(contents.join("\n"))}</blockquote>,
      );
      continue;
    }
    const list = /^ {0,3}([-+*]|\d+[.)])\s+(.*)$/.exec(line);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      const items: ReactNode[] = [];
      for (;;) {
        const match = /^ {0,3}([-+*]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!match || /^\d/.test(match[1]) !== ordered) {
          i--;
          break;
        }
        const task = /^\[([ xX])\]\s+(.*)$/.exec(match[2]);
        items.push(
          <li key={i}>
            {task ? (
              <>
                <span
                  className="markdown-task"
                  aria-label={task[1] === " " ? "未完成" : "已完成"}
                >
                  {task[1] === " " ? "☐" : "☑"}
                </span>{" "}
                {inline(task[2])}
              </>
            ) : (
              inline(match[2])
            )}
          </li>,
        );
        i++;
        if (i >= lines.length) break;
      }
      blocks.push(
        ordered ? (
          <ol start={parseInt(list[1])} key={key}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        ),
      );
      continue;
    }
    const paragraph = [line];
    while (i + 1 < lines.length && !startsBlock(lines[i + 1]))
      paragraph.push(lines[++i]);
    blocks.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
  }
  if (i < lines.length)
    blocks.push(<pre key="remaining">{lines.slice(i).join("\n")}</pre>);
  if (allLines.length > lines.length)
    blocks.push(
      <pre key="overflow-lines">{allLines.slice(lines.length).join("\n")}</pre>,
    );
  return blocks;
}

export default function TextPreview({
  name,
  text: inputText,
  error: inputError,
  compact = false,
}: {
  name: string;
  text?: string;
  error?: string;
  compact?: boolean;
}) {
  const [raw, setRaw] = useState(false);
  const text = typeof inputText === "string" ? inputText : undefined;
  const error =
    inputError ??
    (inputText !== undefined && typeof inputText !== "string"
      ? "此文件暂时无法生成文本预览，请用默认应用打开。"
      : undefined);
  const kind = textPreviewKind(name);
  const source = (text ?? "").slice(0, TEXT_PREVIEW_LIMIT);
  const truncated = (text?.length ?? 0) > TEXT_PREVIEW_LIMIT;
  const json = useMemo(
    () => (kind === "json" && !truncated ? formatJson(source) : null),
    [kind, source, truncated],
  );
  const table = useMemo(
    () =>
      (kind === "csv" || kind === "tsv") && !truncated
        ? parseDelimited(source, kind === "csv" ? "," : "\t")
        : null,
    [kind, source, truncated],
  );
  const markdown = useMemo(
    () => (kind === "markdown" ? markdownBlocks(source) : null),
    [kind, source],
  );
  const label = {
    markdown: "Markdown",
    json: "JSON",
    csv: "CSV 表格",
    tsv: "TSV 表格",
    code: "代码",
    text: "文本",
  }[kind];
  const note = !raw && (json?.error || table?.error);
  const formattedTruncated =
    !raw && (json?.text.length ?? 0) > TEXT_PREVIEW_LIMIT;
  return (
    <section
      className={`text-preview${compact ? " text-preview-compact" : ""}`}
      aria-label={`${label}预览`}
    >
      <div className="text-preview-toolbar">
        <span>{label} · 只读</span>
        {kind !== "text" && !error && text !== undefined && (
          <button onClick={() => setRaw(!raw)} aria-pressed={raw}>
            {raw ? "格式预览" : "查看原文"}
          </button>
        )}
      </div>
      {error ? (
        <p className="text-preview-note" role="status">
          {error}
        </p>
      ) : text === undefined ? (
        <p role="status">正在读取…</p>
      ) : text.length === 0 ? (
        <p className="text-preview-note">文件为空</p>
      ) : (
        <>
          {truncated && (
            <p className="text-preview-note" role="status">
              仅预览前 {TEXT_PREVIEW_LIMIT.toLocaleString("zh-CN")}{" "}
              个字符，完整内容请用默认应用打开。
              {kind === "json" || kind === "csv" || kind === "tsv"
                ? " 大文件显示原文。"
                : ""}
            </p>
          )}
          {formattedTruncated && (
            <p className="text-preview-note" role="status">
              排版后的 JSON 较长，仅显示前{" "}
              {TEXT_PREVIEW_LIMIT.toLocaleString("zh-CN")}{" "}
              个字符；可切换原文查看。
            </p>
          )}
          {note && (
            <p className="text-preview-note" role="status">
              {note}
            </p>
          )}
          {raw ||
          note ||
          (truncated && ["json", "csv", "tsv"].includes(kind)) ? (
            <pre className="text-preview-plain">{source}</pre>
          ) : kind === "markdown" ? (
            <article className="markdown-document">{markdown}</article>
          ) : table ? (
            <>
              <p className="text-preview-note">
                {table.rows.length} 行 · {table.columns} 列
                {table.limited &&
                  ` · 仅显示前 ${TABLE_ROW_LIMIT} 行、${TABLE_COLUMN_LIMIT} 列`}
              </p>
              <div
                className="text-preview-table-scroll"
                tabIndex={0}
                aria-label="表格内容"
              >
                <table className="text-preview-table">
                  <thead>
                    <tr>
                      <th aria-label="行号">#</th>
                      {Array.from({ length: table.columns }, (_, index) => (
                        <th key={index}>列 {index + 1}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        <th scope="row">{rowIndex + 1}</th>
                        {Array.from(
                          { length: table.columns },
                          (_, columnIndex) => (
                            <td key={columnIndex}>{row[columnIndex] ?? ""}</td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : kind === "json" || kind === "code" ? (
            <HighlightedCode
              text={(json?.text ?? source).slice(0, TEXT_PREVIEW_LIMIT)}
            />
          ) : (
            <pre className="text-preview-plain">{source}</pre>
          )}
        </>
      )}
    </section>
  );
}
