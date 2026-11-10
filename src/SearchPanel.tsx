import { useEffect, useRef, useState } from "react";
import { ArrowLeft, FolderSearch, Search, Square } from "lucide-react";
import { Channel } from "@tauri-apps/api/core";
import { call, desktop } from "./bridge";
import FileIcon from "./FileIcon";
import { fileCategoryLabels } from "./fileTypes";
import { formatSize, type Entry } from "./model";

export type SearchReport = {
  hits: { entry: Entry; parent: string }[];
  indexed: boolean;
  limited: boolean;
  skipped: number;
};
type SearchFields = { query: string; category: string; date: string; size: string };
type SavedSearch = SearchFields & { id: string };

function savedSearches(path: string): SavedSearch[] {
  try {
    const saved = JSON.parse(localStorage.getItem("filepace-searches:" + path) ?? "[]") as SavedSearch[];
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export default function SearchPanel({
  path,
  hidden,
  onBrowse,
  onClose,
}: {
  path: string;
  hidden: boolean;
  onBrowse: (path: string, selected?: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [date, setDate] = useState("");
  const [size, setSize] = useState("");
  const [saved, setSaved] = useState(() => savedSearches(path));
  const [report, setReport] = useState<SearchReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const request = useRef("");
  const lastSearch = useRef<SearchFields>({ query: "", category: "", date: "", size: "" });
  const hasFilter = Boolean(query.trim() || category || date || size);
  useEffect(
    () => () => {
      if (!request.current) return;
      void call("cancel_search", { id: request.current }).catch(() => {});
      request.current = "";
    },
    [],
  );

  async function find(exhaustive = false) {
    const text = query.trim();
    if (!hasFilter || request.current) return;
    const id = crypto.randomUUID();
    request.current = id;
    lastSearch.current = { query: text, category, date, size };
    setBusy(true);
    setNotice("");
    setReport(null);
    const onBatch = desktop ? new Channel<SearchReport["hits"]>() : undefined;
    if (onBatch) onBatch.onmessage = (hits) => {
      if (request.current !== id) return;
      setReport((prior) => ({
        hits: [...(prior?.hits ?? []), ...hits],
        indexed: false,
        limited: false,
        skipped: 0,
      }));
    };
    try {
      const result = await call<SearchReport | null>("search_files", {
        path,
        query: text,
        category,
        hidden,
        exhaustive,
        id,
        minSize: size ? Math.ceil(Number(size) * 1024 ** 2) : undefined,
        modifiedAfter: date ? Math.floor(new Date(date + "T00:00:00").getTime() / 1000) : undefined,
        onBatch,
      });
      if (request.current === id) {
        if (result) setReport(result);
        if (!result) setNotice("搜索已停止。");
      }
    } catch (error) {
      if (request.current === id) setNotice(String(error));
    } finally {
      if (request.current === id) {
        request.current = "";
        setBusy(false);
      }
    }
  }

  return (
    <section className="storage-dashboard search-panel" aria-label="跨目录搜索">
      <header className="storage-heading">
        <span className="storage-heading-mark">
          <FolderSearch size={22} />
        </span>
        <div>
          <h1>跨目录搜索</h1>
          <p className="search-path" title={path}>
            {path}
          </p>
        </div>
        <button className="storage-secondary" onClick={onClose}>
          <ArrowLeft size={15} /> 返回文件
        </button>
      </header>
      <form
        className="storage-card search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void find();
        }}
      >
        <label>
          <span>文件名关键词</span>
          <input
            aria-label="文件名关键词"
            autoFocus
            value={query}
            maxLength={300}
            placeholder="输入名称的一部分"
            disabled={busy}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span>修改日期起</span>
          <input type="date" value={date} disabled={busy} onChange={(event) => setDate(event.target.value)} />
        </label>
        <label>
          <span>至少（MB）</span>
          <input type="number" min="0" max="1000000000" step="any" value={size} disabled={busy} onChange={(event) => setSize(event.target.value)} />
        </label>
        <label>
          <span>文件类型</span>
          <select
            aria-label="文件类型"
            value={category}
            disabled={busy}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">所有类型</option>
            {Object.entries(fileCategoryLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {busy ? (
          <button
            type="button"
            className="storage-secondary"
            onClick={() => {
              void call("cancel_search", { id: request.current }).catch(
                (error) => setNotice(String(error)),
              );
            }}
          >
            <Square size={13} /> 停止搜索
          </button>
        ) : (
          <button
            className="storage-primary"
            type="submit"
            disabled={!hasFilter}
          >
            <Search size={14} /> 开始搜索
          </button>
        )}
        <button
          className="storage-secondary"
          type="button"
          disabled={!hasFilter || busy}
          onClick={() => {
            const next = [{ id: crypto.randomUUID(), query, category, date, size }, ...saved].slice(0, 12);
            localStorage.setItem("filepace-searches:" + path, JSON.stringify(next));
            setSaved(next);
            setNotice("已保存当前目录的搜索条件。");
          }}
        >
          保存条件
        </button>
        {saved.length > 0 && (
          <label>
            <span>已保存条件</span>
            <select value="" disabled={busy} onChange={(event) => {
              const item = saved.find((item) => item.id === event.target.value);
              if (!item) return;
              setQuery(item.query);
              setCategory(item.category);
              setDate(item.date);
              setSize(item.size);
            }}>
              <option value="">选择条件</option>
              {saved.map((item) => <option key={item.id} value={item.id}>{[item.query, item.category && fileCategoryLabels[item.category as keyof typeof fileCategoryLabels], item.date, item.size && item.size + " MB"].filter(Boolean).join(" · ")}</option>)}
            </select>
          </label>
        )}
      </form>
      {busy && (
        <p className="storage-muted" role="status">
          正在查找匹配的文件和文件夹…
        </p>
      )}
      {notice && (
        <p className="storage-muted" role="status">
          {notice}
        </p>
      )}
      {report && (
        <section className="storage-card search-results">
          <div className="storage-section-heading">
            <div>
              <h2>搜索结果</h2>
              <p>
                {report.limited ? "显示前 " : ""}
                {report.hits.length} 项{" · "}
                {report.indexed ? "系统索引" : "目录扫描"}
                {report.skipped > 0 &&
                  ` · 跳过 ${report.skipped} 个无法读取的项目`}
              </p>
            </div>
            {report.indexed &&
              query.trim() === lastSearch.current.query &&
              category === lastSearch.current.category &&
              date === lastSearch.current.date &&
              size === lastSearch.current.size && (
                <button
                  className="storage-secondary"
                  onClick={() => void find(true)}
                >
                  扫描全部子目录
                </button>
              )}
          </div>
          {report.hits.length ? (
            <ul className="storage-items">
              {report.hits.map(({ entry, parent }) => (
                <li key={entry.path}>
                  <button
                    className="storage-item"
                    title={entry.path}
                    onClick={() =>
                      entry.isDir
                        ? onBrowse(entry.path)
                        : onBrowse(parent, entry.path)
                    }
                  >
                    <FileIcon entry={entry} showThumbnail={false} />
                    <span>
                      <b>{entry.name}</b>
                      <small>{parent}</small>
                    </span>
                    {!entry.isDir && <small>{formatSize(entry.size)}</small>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="storage-muted">这个范围没有匹配的项目。</p>
          )}
        </section>
      )}
    </section>
  );
}
