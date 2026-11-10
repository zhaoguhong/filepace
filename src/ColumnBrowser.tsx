import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Folder, LoaderCircle } from "lucide-react";
import FileIcon from "./FileIcon";
import { useDirectoryListing, type PaneSide } from "./browsePane";
import { useFilePreview } from "./filePreview";
import { describeFile } from "./fileTypes";
import {
  basename,
  columnPaths,
  formatSize,
  visibleEntries,
  type Entry,
  type Tab,
} from "./model";
import "./columns.css";

type Props = {
  tab: Tab;
  side: PaneSide;
  hidden: boolean;
  revision: number;
  active: ReactNode;
  preview?: Entry;
  dropPath?: string;
  renderRow: (
    entry: Entry,
    directory: string,
    columns: string[],
    child?: string,
  ) => ReactNode;
  onChoose: (columns: string[]) => void;
  onContext: (event: MouseEvent, columns: string[]) => void;
  onOpen: (entry: Entry) => void;
};

function Ancestor({
  path,
  child,
  columns,
  tab,
  side,
  hidden,
  revision,
  dropPath,
  renderRow,
  onChoose,
  onContext,
}: Omit<Props, "active" | "preview" | "onOpen"> & {
  path: string;
  child: string;
  columns: string[];
}) {
  const { listing, loading, error } = useDirectoryListing(path, revision);
  const [scroll, setScroll] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const entries = listing
    ? visibleEntries(listing.entries, { ...tab, query: "" }, hidden)
    : [];
  const start = Math.max(
    0,
    Math.min(entries.length - 1, Math.floor(scroll / 34) - 8),
  );
  const shown = entries.slice(start, start + 55);

  useLayoutEffect(() => {
    const index = entries.findIndex((entry) => entry.path === child);
    if (index < 0 || !list.current) return;
    const element = list.current;
    const top = index * 34;
    if (
      top < element.scrollTop ||
      top + 34 > element.scrollTop + element.clientHeight
    ) {
      element.scrollTop = Math.max(0, top - (element.clientHeight - 34) / 2);
      setScroll(element.scrollTop);
    }
  }, [listing, child]);

  return (
    <section
      className="directory-column"
      aria-label={`目录列 · ${basename(path)}`}
    >
      <button
        className="column-heading"
        title={path}
        onClick={() => onChoose(columns)}
      >
        <Folder size={14} />
        <span>{basename(path)}</span>
      </button>
      <div
        className={`file-area column-list${dropPath && dropPath === listing?.path ? " drop-target" : ""}`}
        aria-label={`文件夹 · ${basename(path)}`}
        data-pane={side}
        data-drop-path={listing?.path}
        ref={list}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
        onClick={() => onChoose(columns)}
        onContextMenu={(event) => onContext(event, columns)}
      >
        {loading && !listing ? (
          <p className="column-empty">
            <LoaderCircle className="spin" size={16} /> 正在读取…
          </p>
        ) : error ? (
          <p className="column-empty" title={error}>
            无法读取这个文件夹
          </p>
        ) : !entries.length ? (
          <p className="column-empty">这个文件夹还是空的</p>
        ) : (
          <>
            <div style={{ height: start * 34 }} />
            {shown.map((entry) =>
              renderRow(entry, listing?.path ?? path, columns, child),
            )}
            <div
              style={{
                height: Math.max(0, entries.length - start - shown.length) * 34,
              }}
            />
          </>
        )}
      </div>
    </section>
  );
}

function PreviewColumn({
  entry,
  onOpen,
}: {
  entry: Entry;
  onOpen: () => void;
}) {
  const result = useFilePreview(entry, true);
  return (
    <section
      className="directory-column file-preview-column"
      aria-label="文件预览"
    >
      <div className="column-heading">预览</div>
      <div className="column-preview-body">
        {result?.image ? (
          <img src={result.image} alt={entry.name} />
        ) : result?.text ? (
          <pre>{result.text}</pre>
        ) : (
          <FileIcon entry={entry} showThumbnail={false} />
        )}
        <h3>{entry.name}</h3>
        <dl>
          <dt>类型</dt>
          <dd>{describeFile(entry).label}</dd>
          <dt>大小</dt>
          <dd>{formatSize(entry.size)}</dd>
          <dt>修改日期</dt>
          <dd>{new Date(entry.modified * 1000).toLocaleDateString("zh-CN")}</dd>
        </dl>
        <button className="column-open" onClick={onOpen}>
          打开文件
        </button>
      </div>
    </section>
  );
}

export default function ColumnBrowser(props: Props) {
  const { tab, active, preview, onOpen } = props;
  const columns = columnPaths(tab);
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (strip.current) strip.current.scrollLeft = strip.current.scrollWidth;
  }, [tab.id, tab.path, columns.length, preview?.path]);
  return (
    <div className="column-browser" ref={strip} aria-label="列视图目录">
      {columns.slice(0, -1).map((path, index) => (
        <Ancestor
          key={`${tab.id}-${index}-${path}`}
          {...props}
          path={path}
          child={columns[index + 1]}
          columns={columns.slice(0, index + 1)}
        />
      ))}
      <section
        className="directory-column active-column"
        aria-label={`当前目录列 · ${basename(tab.path)}`}
      >
        <div className="column-heading" title={tab.path}>
          <Folder size={14} />
          <span>{basename(tab.path)}</span>
        </div>
        {active}
      </section>
      {preview && (
        <PreviewColumn entry={preview} onOpen={() => onOpen(preview)} />
      )}
    </div>
  );
}
