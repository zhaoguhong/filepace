import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  FolderSearch,
  Search,
  Square,
  Pin,
  PinOff,
  Pencil,
  Trash2,
} from "lucide-react";
import { Channel } from "@tauri-apps/api/core";
import { call, desktop } from "./bridge";
import { fileCategoryLabels } from "./fileTypes";
import type { Entry } from "./model";
import ResultFiles from "./ResultFiles";
import type { ResultActionProps } from "./resultActions";
import { usePreservedScroll } from "./preservedScroll";
import {
  readSavedSearches,
  writeSavedSearches,
  savedSearchesChanged,
  type SearchFields,
  type SavedSearch,
} from "./savedSearches";

export type SearchReport = {
  hits: { entry: Entry; parent: string }[];
  indexed: boolean;
  limited: boolean;
  skipped: number;
};
export default function SearchPanel({
  path,
  hidden,
  visible = true,
  restoreSearch,
  onBrowse,
  onClose,
  onFileAction,
  fileChanges,
  fileChangeBatches,
}: ResultActionProps & {
  path: string;
  hidden: boolean;
  visible?: boolean;
  restoreSearch?: SavedSearch;
  onBrowse: (path: string, selected?: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [date, setDate] = useState("");
  const [size, setSize] = useState("");
  const [saved, setSaved] = useState(() => readSavedSearches(path));
  const [selectedSaved, setSelectedSaved] = useState("");
  const [savedEditor, setSavedEditor] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [report, setReport] = useState<SearchReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [resultKey, setResultKey] = useState("");
  const [resultBaseline, setResultBaseline] = useState(0);
  const request = useRef("");
  const lastSearch = useRef<SearchFields>({
    query: "",
    category: "",
    date: "",
    size: "",
  });
  const hasFilter = Boolean(query.trim() || category || date || size);
  const queryInput = useRef<HTMLInputElement>(null);
  const preservedScroll = usePreservedScroll(visible);
  useEffect(() => {
    const sync = () => setSaved(readSavedSearches(path));
    window.addEventListener(savedSearchesChanged, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(savedSearchesChanged, sync);
      window.removeEventListener("storage", sync);
    };
  }, [path]);
  useEffect(() => {
    if (!restoreSearch || restoreSearch.path !== path) return;
    setQuery(restoreSearch.query);
    setCategory(restoreSearch.category);
    setDate(restoreSearch.date);
    setSize(restoreSearch.size);
    setSelectedSaved(restoreSearch.id);
    setNotice(`已载入「${restoreSearch.name}」，点击开始搜索更新结果。`);
  }, [restoreSearch, path]);
  useEffect(() => {
    if (visible) queryInput.current?.focus({ preventScroll: true });
  }, [visible]);
  useEffect(
    () => () => {
      if (!request.current) return;
      void call("cancel_search", { id: request.current }).catch(() => {});
      request.current = "";
    },
    [],
  );

  function save(items: SavedSearch[]) {
    try {
      writeSavedSearches(items);
      setSaved(readSavedSearches(path));
      return true;
    } catch (error) {
      setNotice(`无法保存搜索条件：${String(error)}`);
      return false;
    }
  }

  async function find(exhaustive = false) {
    const text = query.trim();
    if (!hasFilter || request.current) return;
    const id = crypto.randomUUID();
    request.current = id;
    lastSearch.current = { query: text, category, date, size };
    setBusy(true);
    setNotice("");
    setReport(null);
    setResultKey(id);
    setResultBaseline(fileChangeBatches?.at(-1)?.sequence ?? 0);
    const onBatch = desktop ? new Channel<SearchReport["hits"]>() : undefined;
    if (onBatch)
      onBatch.onmessage = (hits) => {
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
        modifiedAfter: date
          ? Math.floor(new Date(date + "T00:00:00").getTime() / 1000)
          : undefined,
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
    <section
      {...preservedScroll}
      className="storage-dashboard search-panel"
      aria-label="搜索子文件夹"
      hidden={!visible}
    >
      <header className="storage-heading">
        <span className="storage-heading-mark">
          <FolderSearch size={22} />
        </span>
        <div>
          <h1>搜索子文件夹</h1>
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
            ref={queryInput}
            value={query}
            maxLength={300}
            placeholder="输入名称的一部分"
            disabled={busy}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span>修改日期起</span>
          <input
            type="date"
            value={date}
            disabled={busy}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <label>
          <span>至少（MB）</span>
          <input
            type="number"
            min="0"
            max="1000000000"
            step="any"
            value={size}
            disabled={busy}
            onChange={(event) => setSize(event.target.value)}
          />
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
            setSavedEditor({ id: "", name: query.trim() || "新的搜索" });
          }}
        >
          保存条件
        </button>
        {saved.length > 0 && (
          <label>
            <span>已保存条件</span>
            <select
              value={selectedSaved}
              disabled={busy}
              onChange={(event) => {
                const item = saved.find(
                  (item) => item.id === event.target.value,
                );
                if (!item) return;
                setSelectedSaved(item.id);
                setQuery(item.query);
                setCategory(item.category);
                setDate(item.date);
                setSize(item.size);
              }}
            >
              <option value="">选择条件</option>
              {saved.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </form>
      {savedEditor && (
        <form
          className="storage-card saved-search-editor"
          aria-label="保存搜索条件"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setSavedEditor(null);
              queryInput.current?.focus({ preventScroll: true });
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            const name = savedEditor.name.trim();
            if (!name || !hasFilter || busy) return;
            const existing = saved.find((item) => item.id === savedEditor.id);
            const item: SavedSearch = {
              id: existing?.id ?? crypto.randomUUID(),
              path,
              name,
              pinned: existing?.pinned ?? false,
              query,
              category,
              date,
              size,
            };
            const all = readSavedSearches();
            if (save([item, ...all.filter((other) => other.id !== item.id)])) {
              setSelectedSaved(item.id);
              setSavedEditor(null);
              setNotice(`已保存「${name}」。`);
            }
          }}
        >
          <input
            aria-label="搜索名称"
            maxLength={100}
            autoFocus
            value={savedEditor.name}
            onChange={(event) =>
              setSavedEditor({ ...savedEditor, name: event.target.value })
            }
          />
          <button
            className="storage-primary"
            type="submit"
            disabled={!savedEditor.name.trim() || !hasFilter || busy}
          >
            保存搜索
          </button>
          <button
            className="storage-secondary"
            type="button"
            onClick={() => setSavedEditor(null)}
          >
            取消
          </button>
        </form>
      )}
      {saved.length > 0 && (
        <details className="storage-card saved-searches">
          <summary>管理已保存搜索 · {saved.length}</summary>
          {saved.map((item) => (
            <div className="saved-search-row" key={item.id}>
              <button
                disabled={busy}
                title={item.name}
                onClick={() => {
                  setQuery(item.query);
                  setCategory(item.category);
                  setDate(item.date);
                  setSize(item.size);
                  setSelectedSaved(item.id);
                }}
              >
                {item.name}
              </button>
              <button
                disabled={busy}
                aria-label={`更新 ${item.name}`}
                title="用当前条件更新并重命名"
                onClick={() => setSavedEditor({ id: item.id, name: item.name })}
              >
                <Pencil size={13} />
              </button>
              <button
                aria-label={`${item.pinned ? "取消固定" : "固定到侧栏"} ${item.name}`}
                title={item.pinned ? "取消固定" : "固定到侧栏"}
                onClick={() =>
                  save(
                    readSavedSearches().map((other) =>
                      other.id === item.id
                        ? { ...other, pinned: !other.pinned }
                        : other,
                    ),
                  )
                }
              >
                {item.pinned ? <PinOff size={13} /> : <Pin size={13} />}
              </button>
              <button
                aria-label={`删除搜索 ${item.name}`}
                title="删除搜索条件"
                onClick={() => {
                  if (
                    save(
                      readSavedSearches().filter(
                        (other) => other.id !== item.id,
                      ),
                    ) &&
                    selectedSaved === item.id
                  )
                    setSelectedSaved("");
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </details>
      )}
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
          {!busy &&
            (query.trim() !== lastSearch.current.query ||
              category !== lastSearch.current.category ||
              date !== lastSearch.current.date ||
              size !== lastSearch.current.size) && (
              <p className="results-snapshot-note" role="status">
                搜索条件已更改；以下保留上次结果，开始搜索后更新。
              </p>
            )}
          {report.hits.length ? (
            <ResultFiles
              key={resultKey}
              items={report.hits}
              scope={path}
              label="搜索结果"
              visible={visible}
              changeBaseline={resultBaseline}
              onBrowse={onBrowse}
              onFileAction={onFileAction}
              fileChanges={fileChanges}
              fileChangeBatches={fileChangeBatches}
            />
          ) : (
            <p className="storage-muted">这个范围没有匹配的项目。</p>
          )}
        </section>
      )}
    </section>
  );
}
