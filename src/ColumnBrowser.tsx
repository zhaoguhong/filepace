import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { LoaderCircle } from "lucide-react";
import FileIcon from "./FileIcon";
import { useDirectoryListing, type PaneSide } from "./browsePane";
import { revealItem, useFileViewport, visibleRange } from "./fileViewport";
import { useFilePreview } from "./filePreview";
import { describeFile } from "./fileTypes";
import {
  basename,
  columnPaths,
  formatSize,
  sortEntries,
  type Entry,
  type Tab,
} from "./model";
import "./columns.css";

type Props = {
  tab: Tab;
  side: PaneSide;
  hidden: boolean;
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
  onMarquee: (
    event: PointerEvent<HTMLDivElement>,
    columns: string[],
    directory: string,
    entries: Entry[],
  ) => void;
  onOpen: (entry: Entry) => void;
};

function Ancestor({
  path,
  child,
  columns,
  tab,
  side,
  hidden,
  dropPath,
  renderRow,
  onChoose,
  onContext,
  onMarquee,
}: Omit<Props, "active" | "preview" | "onOpen"> & {
  path: string;
  child: string;
  columns: string[];
}) {
  const { listing, loading, error } = useDirectoryListing(path);
  const [scroll, setScroll] = useState(0);
  const { listRef: list, attachList, height, layout } = useFileViewport("columns");
  const entries = useMemo(
    () => listing ? sortEntries(listing.entries, tab.sort, tab.descending, hidden) : [],
    [listing, tab.sort, tab.descending, hidden],
  );
  const range = visibleRange(entries.length, scroll, height, layout);
  const shown = entries.slice(range.start, range.end);

  useLayoutEffect(() => {
    const index = entries.findIndex((entry) => entry.path === child);
    if (index < 0 || !list.current) return;
    revealItem(list.current, index, layout);
    setScroll(list.current.scrollTop);
  }, [entries, child, height]);

  return (
    <section
      className="directory-column"
      aria-label={`目录列 · ${basename(path)}`}
    >
      <div
        className={`file-area column-list${dropPath && dropPath === listing?.path ? " drop-target" : ""}`}
        aria-label={`文件夹 · ${basename(path)}`}
        data-pane={side}
        data-drop-path={listing?.path}
        ref={attachList}
        role="listbox"
        aria-multiselectable="true"
        tabIndex={-1}
        onPointerDown={(event) =>
          onMarquee(event, columns, listing?.path ?? path, entries)
        }
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
            <div style={{ height: range.above }} />
            {shown.map((entry) =>
              renderRow(entry, listing?.path ?? path, columns, child),
            )}
            <div style={{ height: range.below }} />
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
      <div className="column-preview-heading">预览</div>
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
        {active}
      </section>
      {preview && (
        <PreviewColumn entry={preview} onOpen={() => onOpen(preview)} />
      )}
    </div>
  );
}
