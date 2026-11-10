import FileIcon from "./FileIcon";
import StorageDashboard from "./StorageDashboard";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  Search,
  Folder,
  FolderPlus,
  FileText,
  Image as ImageIcon,
  HardDrive,
  Home,
  Download,
  Monitor,
  Star,
  LayoutGrid,
  List,
  Eye,
  EyeOff,
  ArrowDownUp,
  Copy,
  Scissors,
  Clipboard,
  Trash2,
  PanelLeft,
  RefreshCw,
  ExternalLink,
  Columns2,
  Check,
  LoaderCircle,
  ArrowDownToLine,
  MoreHorizontal,
  Command,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { call, desktop } from "./bridge";
import { useBrowsePane, type PaneSession, type PaneSide } from "./browsePane";
import { isMac, useFileDrag } from "./fileDrag";
import { describeFile } from "./fileTypes";
import {
  basename,
  makeTab,
  navigate,
  formatSize,
  type Entry,
  type GridSize,
  type Tab,
  type Task,
  type Place,
} from "./model";
type Session = PaneSession & { right?: PaneSession; focused?: PaneSide };
type Menu = {
  x: number;
  y: number;
  entry?: Entry;
  tab?: Tab;
  viewPane?: PaneSide;
};
type OpenWithApp = { name: string; path: string; default: boolean };
const iconSize = 17;
const gridSizes: { value: GridSize; label: string }[] = [
  { value: "small", label: "小图标" },
  { value: "medium", label: "中图标" },
  { value: "large", label: "大图标" },
  { value: "extra-large", label: "超大图标" },
];

function cleanPane({ tabs, active }: PaneSession): PaneSession {
  return { tabs: tabs.map((tab) => ({ ...tab, selected: [] })), active };
}
function Tool({
  label,
  children,
  onClick,
  disabled = false,
  active = false,
  expanded,
}: {
  label: string;
  children: React.ReactNode;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  active?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      className={`tool ${active ? "active" : ""}`}
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export default function App() {
  const [session, setSession] = useState<Session>({ tabs: [], active: "" }),
    [places, setPlaces] = useState<Place[]>([]),
    [bootError, setBootError] = useState(""),
    [notice, setNotice] = useState("");
  const [hidden, setHidden] = useState(false),
    [sidebar, setSidebar] = useState(true),
    [editingPath, setEditingPath] = useState<PaneSide | null>(null),
    [address, setAddress] = useState(""),
    [menu, setMenu] = useState<Menu | null>(null),
    [tasks, setTasks] = useState<Task[]>([]),
    [taskPanel, setTaskPanel] = useState(false),
    [preview, setPreview] = useState<Entry | null>(null),
    [properties, setProperties] = useState<Entry | null>(null),
    [openWith, setOpenWith] = useState<{
      entry: Entry;
      apps: OpenWithApp[];
    } | null>(null),
    [storageVisible, setStorageVisible] = useState(false),
    [storageScope, setStorageScope] = useState(""),
    [previewContent, setPreviewContent] = useState(""),
    [imageUrl, setImageUrl] = useState(""),
    [rename, setRename] = useState<{ pane: PaneSide; path: string } | null>(
      null,
    ),
    [editName, setEditName] = useState(""),
    [newFolder, setNewFolder] = useState<string | null>(null),
    [revision, setRevision] = useState(0),
    [closePrompt, setClosePrompt] = useState(false),
    [applyAll, setApplyAll] = useState(false);
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("filepace-favorites") || "[]");
    } catch {
      return [];
    }
  });
  const [cutPaths, setCutPaths] = useState<string[]>([]);
  const closed = useRef<Record<PaneSide, Tab[]>>({ left: [], right: [] }),
    pathRef = useRef<HTMLInputElement>(null),
    menuRef = useRef<HTMLDivElement>(null),
    dragTab = useRef("");
  const split = Boolean(session.right);
  const focused = split ? (session.focused ?? "left") : "left";
  const left = useBrowsePane(session, hidden, revision);
  const right = useBrowsePane(session.right, hidden, revision);
  const pane = focused === "left" ? left : right;
  const { tab, listing, entries, listRef } = pane;
  const { tabs, active } =
    (focused === "right" ? session.right : session) ?? session;
  const stateRef = useRef(session);
  stateRef.current = session;
  const selected = tab?.selected || [];
  const fileDrag = useFileDrag({
    split,
    focusedPath: tab?.path,
    transfer: start,
    onStart: () => setMenu(null),
    onError: setNotice,
  });
  const running = tasks.filter((t) =>
    ["running", "conflict"].includes(t.status),
  );
  const conflict = tasks.find((t) => t.status === "conflict" && t.conflict);
  function updatePane(
    side: PaneSide,
    update: (pane: PaneSession) => PaneSession,
  ) {
    setSession((current) => {
      if (side === "left") return { ...current, ...update(current) };
      return current.right
        ? { ...current, right: update(current.right) }
        : current;
    });
  }
  function focusPane(side: PaneSide) {
    if (focused === side) return;
    setSession((current) => ({ ...current, focused: side }));
    setMenu(null);
    setRename(null);
  }
  function toggleSplit() {
    if (!tab) return;
    setMenu(null);
    setRename(null);
    setEditingPath(null);
    if (session.right) {
      closed.current.left.push(...closed.current.right);
      closed.current.right = [];
      setSession({
        tabs: [...session.tabs, ...session.right.tabs],
        active: tab.id,
      });
    } else {
      const next = makeTab(tab.path);
      setSession({
        ...session,
        right: { tabs: [next], active: next.id },
        focused: "left",
      });
    }
  }
  function patch(value: Partial<Tab>, side = focused) {
    updatePane(side, (group) => ({
      ...group,
      tabs: group.tabs.map((t) =>
        t.id === group.active ? { ...t, ...value } : t,
      ),
    }));
  }
  function go(path: string, side = focused, selectedPath?: string) {
    updatePane(side, (group) => ({
      ...group,
      tabs: group.tabs.map((t) =>
        t.id === group.active
          ? {
              ...navigate(t, path),
              selected: selectedPath ? [selectedPath] : [],
            }
          : t,
      ),
    }));
    setStorageVisible(false);
    setMenu(null);
    setEditingPath(null);
    setRename(null);
  }
  function travel(delta: number, side = focused) {
    const current = (side === "left" ? left : right).tab;
    if (!current) return;
    const i = current.index + delta;
    if (i >= 0 && i < current.history.length)
      patch(
        {
          index: i,
          path: current.history[i],
          selected: [],
          query: "",
          scroll: 0,
        },
        side,
      );
  }
  function activateTab(id: string, side = focused) {
    updatePane(side, (group) => ({ ...group, active: id }));
    setEditingPath(null);
    setRename(null);
    setMenu(null);
  }
  function newTab(path = tab?.path, side = focused) {
    if (!path) return;
    const next = makeTab(path);
    updatePane(side, (group) => ({
      tabs: [...group.tabs, next],
      active: next.id,
    }));
    setMenu(null);
  }
  async function windowFor(t: Tab, move = false, side = focused) {
    try {
      await call("new_window", { value: { tabs: [t], active: t.id } });
      if (move) await closeTab(t.id, side);
      setMenu(null);
    } catch (e) {
      setNotice(String(e));
    }
  }
  async function closeTab(id: string, side = focused) {
    const current = stateRef.current;
    const group = side === "left" ? current : current.right;
    const t = group?.tabs.find((t) => t.id === id);
    if (!group || !t) return;
    if (group.tabs.length === 1 && !current.right) {
      if (desktop)
        await getCurrentWindow()
          .close()
          .catch((error) => setNotice(String(error)));
      else setNotice("桌面应用中会关闭窗口");
      return;
    }
    closed.current[side].push(t);
    if (group.tabs.length === 1 && current.right) {
      const remaining = side === "left" ? current.right : current;
      closed.current.left.push(...closed.current.right);
      closed.current.right = [];
      setSession({ tabs: remaining.tabs, active: remaining.active });
    } else {
      updatePane(side, (group) => {
        const index = group.tabs.findIndex((item) => item.id === id);
        const tabs = group.tabs.filter((item) => item.id !== id);
        return {
          tabs,
          active:
            group.active === id
              ? (tabs[index] ?? tabs[index - 1]).id
              : group.active,
        };
      });
    }
    setMenu(null);
    setEditingPath(null);
    setRename(null);
  }
  function restore() {
    const t = closed.current[focused].pop();
    if (t) {
      updatePane(focused, (group) => ({
        tabs: [...group.tabs, t],
        active: t.id,
      }));
    }
  }
  function refresh() {
    setRevision((r) => r + 1);
  }
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const ps = await call<Place[]>("places");
        const saved = await call<Session | null>("load_session");
        if (disposed) return;
        setPlaces(ps);
        const restored = saved?.tabs?.length
          ? saved.tabs
          : [makeTab(ps[0]?.path || "/")];
        setSession({
          tabs: restored,
          active:
            restored.find((tab) => tab.id === saved?.active)?.id ??
            restored[0].id,
          right: saved?.right?.tabs?.length
            ? {
                tabs: saved.right.tabs,
                active:
                  saved.right.tabs.find((tab) => tab.id === saved.right?.active)
                    ?.id ?? saved.right.tabs[0].id,
              }
            : undefined,
          focused: saved?.focused === "right" ? "right" : "left",
        });
      } catch (e) {
        if (!disposed) setBootError(String(e));
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (!session.tabs.length) return;
    const timer = setTimeout(() => {
      call("save_session", {
        value: {
          ...cleanPane(session),
          right: session.right && cleanPane(session.right),
          focused,
        },
      }).catch((e) => setNotice("会话保存失败：" + String(e)));
    }, 300);
    return () => clearTimeout(timer);
  }, [session, focused]);
  useEffect(() => {
    const poll = () =>
      call<Task[]>("tasks")
        .then(setTasks)
        .catch(() => {});
    poll();
    const timer = setInterval(poll, 650);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!desktop) return;
    const stop = listen("exit-blocked", () => {
      setClosePrompt(true);
      call<Task[]>("tasks")
        .then(setTasks)
        .catch(() => {});
    });
    return () => {
      stop.then((f) => f());
    };
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let timer: ReturnType<typeof setTimeout>;
    const unlisten = listen("directory-changed", () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((r) => r + 1), 200);
    });
    return () => {
      unlisten.then((f) => f());
      clearTimeout(timer);
    };
  }, []);
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !menu) return;
    const placeMenu = () => {
      element.style.left = `${Math.max(5, Math.min(menu.x, window.innerWidth - element.offsetWidth - 5))}px`;
      element.style.top = `${Math.max(5, Math.min(menu.y, window.innerHeight - element.offsetHeight - 5))}px`;
    };
    placeMenu();
    window.addEventListener("resize", placeMenu);
    return () => window.removeEventListener("resize", placeMenu);
  }, [menu]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    function sync() {
      try {
        setFavorites(
          JSON.parse(localStorage.getItem("filepace-favorites") || "[]"),
        );
      } catch {}
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    if (editingPath) {
      pathRef.current?.focus();
      pathRef.current?.select();
    }
  }, [editingPath]);
  useEffect(() => {
    let cancelled = false;
    let url = "";
    setPreviewContent("");
    setImageUrl("");
    if (preview) {
      if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(preview.name) && desktop) {
        call<number[]>("read_image", { path: preview.path })
          .then((bytes) => {
            if (cancelled) return;
            url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
            setImageUrl(url);
          })
          .catch((e) => setPreviewContent(String(e)));
      } else {
        call<string>("read_preview", { path: preview.path })
          .then((text) => {
            if (!cancelled) setPreviewContent(text);
          })
          .catch((e) => setPreviewContent(String(e)));
      }
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [preview?.path]);
  function editPath(side: PaneSide) {
    const target = side === "left" ? left : right;
    if (!target.tab) return;
    setAddress(target.listing?.path ?? target.tab.path);
    setEditingPath(side);
  }
  async function copy(cut = false, paths = selected) {
    if (!paths.length) return;
    try {
      await call("clipboard_set", { paths, cut });
      setCutPaths(cut ? paths : []);
      setNotice(
        cut ? "已剪切，前往目标文件夹粘贴" : "已复制，前往目标文件夹粘贴",
      );
    } catch (e) {
      setNotice(String(e));
    }
  }
  async function runMenuAction(action: () => Promise<unknown>) {
    setMenu(null);
    try {
      await action();
    } catch (e) {
      setNotice(String(e));
    }
  }
  async function openProperties(entry: Entry) {
    setMenu(null);
    if (desktop) {
      try {
        await call("open_properties", { path: entry.path });
        return;
      } catch {
        // Display the available metadata if the system dialog cannot open.
      }
    }
    setProperties(entry);
  }
  async function chooseOpenWith(entry: Entry) {
    await runMenuAction(async () => {
      const apps = await call<OpenWithApp[]>("open_with", { path: entry.path });
      if (apps.length) setOpenWith({ entry, apps });
      else if (isMac) setNotice("系统没有为此文件找到可用的应用。");
    });
  }
  async function paste(destination = tab?.path) {
    try {
      const [paths, cut] = await call<[string[], boolean]>("clipboard_get");
      if (!paths.length) {
        setNotice("剪贴板中没有文件");
        return;
      }
      await start(cut ? "move" : "copy", paths, destination);
      setCutPaths([]);
    } catch (e) {
      setNotice(String(e));
    }
  }
  async function start(
    kind: string,
    paths = selected,
    destination = tab?.path,
    showTasks = true,
  ) {
    if (!paths.length || !destination) return;
    setMenu(null);
    try {
      await call("start_task", { kind, sources: paths, destination });
      if (showTasks) setTaskPanel(true);
    } catch (e) {
      setNotice(String(e));
    }
  }
  async function open(entry: Entry, side = focused) {
    if (entry.isDir) go(entry.path, side);
    else if (desktop)
      try {
        await call("open_entry", { path: entry.path });
      } catch (e) {
        setNotice(String(e));
      }
    else setPreview(entry);
  }
  function select(
    entry: Entry,
    e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
    side = focused,
  ) {
    const { tab, entries, anchor } = side === "left" ? left : right;
    if (!tab) return;
    const selected = tab.selected;
    const anchorIndex =
      anchor.current?.tab === tab.id
        ? entries.findIndex((x) => x.path === anchor.current?.path)
        : -1;
    if (e.shiftKey && anchorIndex >= 0) {
      const index = entries.findIndex((x) => x.path === entry.path);
      patch(
        {
          selected: entries
            .slice(
              Math.min(anchorIndex, index),
              Math.max(anchorIndex, index) + 1,
            )
            .map((x) => x.path),
        },
        side,
      );
    } else if (e.metaKey || e.ctrlKey) {
      patch(
        {
          selected: selected.includes(entry.path)
            ? selected.filter((p) => p !== entry.path)
            : [...selected, entry.path],
        },
        side,
      );
      anchor.current = { tab: tab.id, path: entry.path };
    } else {
      patch({ selected: [entry.path] }, side);
      anchor.current = { tab: tab.id, path: entry.path };
    }
  }
  function renameSelected(
    entry = listing?.entries.find((e) => e.path === selected[0]),
  ) {
    if (!entry) return;
    setRename({ pane: focused, path: entry.path });
    setEditName(entry.name);
    setMenu(null);
  }
  async function submitRename() {
    try {
      if (newFolder) {
        await call("make_directory", { parent: newFolder, name: editName });
        setNewFolder(null);
      } else if (rename) {
        await call("rename_entry", { path: rename.path, name: editName });
        setRename(null);
      }
      refresh();
    } catch (e) {
      setNotice(String(e));
    }
  }
  function favorite(path = tab?.path) {
    if (!path) return;
    const next = favorites.includes(path)
      ? favorites.filter((p) => p !== path)
      : [...favorites, path];
    setFavorites(next);
    localStorage.setItem("filepace-favorites", JSON.stringify(next));
    setMenu(null);
  }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!tab || fileDrag.preview) return;
      const typing = (e.target as HTMLElement).closest(
        'input,textarea,select,[contenteditable="true"]',
      );
      if (typing) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (openWith) {
        if (key === "escape") setOpenWith(null);
        return;
      }
      if (properties) {
        if (key === "escape") setProperties(null);
        return;
      }
      if (preview) {
        if (key === "escape") setPreview(null);
        if (["arrowleft", "arrowright"].includes(key)) {
          const files = entries.filter((x) => !x.isDir);
          const i = files.findIndex((x) => x.path === preview.path);
          const next = files[i + (key === "arrowleft" ? -1 : 1)];
          if (next) setPreview(next);
        }
        return;
      }
      if (storageVisible) {
        if (key === "escape") setStorageVisible(false);
        return;
      }
      if (
        (isMac && e.metaKey && key === "i") ||
        (!isMac && e.altKey && key === "enter")
      ) {
        const entry = entries.find((item) => item.path === selected[0]);
        if (entry) {
          e.preventDefault();
          void openProperties(entry);
        }
        return;
      }
      if (mod && ["t", "n", "w", "l", "a", "c", "x", "v"].includes(key)) {
        e.preventDefault();
        if (key === "t") e.shiftKey ? restore() : newTab();
        if (key === "n") windowFor(makeTab(tab.path));
        if (key === "w") closeTab(tab.id);
        if (key === "l") editPath(focused);
        if (key === "a") patch({ selected: entries.map((x) => x.path) });
        if (key === "c") copy();
        if (key === "x") copy(true);
        if (key === "v") paste();
        return;
      }
      if (e.ctrlKey && key === "tab") {
        e.preventDefault();
        activateTab(
          tabs[
            (tabs.findIndex((t) => t.id === active) +
              (e.shiftKey ? -1 : 1) +
              tabs.length) %
              tabs.length
          ].id,
        );
      }
      if (key === "f2" || (key === "enter" && isMac)) {
        e.preventDefault();
        renameSelected();
      } else if (key === "enter") {
        const entry = entries.find((x) => x.path === selected[0]);
        if (entry) open(entry);
      }
      if (key === " ") {
        e.preventDefault();
        const entry = entries.find((x) => x.path === selected[0] && !x.isDir);
        if (entry) setPreview(entry);
      }
      if (key === "delete" || (e.metaKey && key === "backspace")) {
        e.preventDefault();
        start("trash");
      }
      if (e.altKey && key === "arrowleft") {
        e.preventDefault();
        travel(-1);
      }
      if (e.altKey && key === "arrowright") {
        e.preventDefault();
        travel(1);
      }
      if (!e.altKey && ["arrowup", "arrowdown"].includes(key)) {
        e.preventDefault();
        const index = entries.findIndex(
          (x) => x.path === selected[selected.length - 1],
        );
        const next =
          entries[
            Math.max(
              0,
              Math.min(
                entries.length - 1,
                index + (key === "arrowdown" ? 1 : -1),
              ),
            )
          ];
        if (next) {
          select(next, {
            shiftKey: e.shiftKey,
            metaKey: false,
            ctrlKey: false,
          });
          const i = entries.indexOf(next);
          if (tab.view === "list")
            listRef.current?.scrollTo({ top: Math.max(0, i * 44 - 150) });
        }
      }
      if (key === "escape") {
        setMenu(null);
        patch({ selected: [] });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!tab)
    return (
      <div className="boot">
        <Folder size={44} />
        <h2>Filepace</h2>
        <p>{bootError || "正在打开你的工作空间…"}</p>
      </div>
    );
  const menuPath = menu?.entry?.path ?? tab.path;
  const viewPane = menu?.viewPane;
  const viewTab = viewPane === "left" ? left.tab : right.tab;
  const dragPreview = fileDrag.preview;

  function renderPane(side: PaneSide) {
    const { tab, listing, entries, loading, error, listRef } =
      side === "left" ? left : right;
    const group = side === "left" ? session : session.right;
    if (!tab || !group) return null;
    const { tabs, active } = group;
    const selected = tab.selected;
    const dropHint = fileDrag.hint?.pane === side ? fileDrag.hint : null;
    const patchPane = (value: Partial<Tab>) => patch(value, side);
    const dragSelection = (entry: Entry) => ({
      entry,
      paths: selected.includes(entry.path) ? selected : [entry.path],
    });
    const startIndex =
      tab.view === "list"
        ? Math.max(
            0,
            Math.min(entries.length - 1, Math.floor(tab.scroll / 44) - 8),
          )
        : 0;
    const shown =
      tab.view === "list"
        ? entries.slice(startIndex, startIndex + 55)
        : entries;
    const path = tab.path;
    const crumbs = path.split(/[\\/]/).filter(Boolean);
    const isWindows = path.includes("\\");
    function crumbPath(i: number) {
      return isWindows
        ? (path.startsWith("\\\\") ? "\\\\" : "") +
            crumbs.slice(0, i + 1).join("\\") +
            "\\"
        : "/" + crumbs.slice(0, i + 1).join("/");
    }
    const label = side === "left" ? "左栏" : "右栏";
    return (
      <section
        className={`file-pane${focused === side ? " focused" : ""}`}
        aria-label={split ? label : "文件浏览"}
        onPointerDownCapture={() => focusPane(side)}
        onFocusCapture={() => focusPane(side)}
      >
        <nav className="tabs" aria-label="文件标签">
          {tabs.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === active}
              tabIndex={0}
              className={`tab ${t.id === active ? "current" : ""}`}
              onPointerDown={(event) => {
                if (
                  event.button !== 0 ||
                  (event.target as HTMLElement).closest("button")
                )
                  return;
                dragTab.current = t.id;
              }}
              onPointerUp={(e) => {
                e.preventDefault();
                const from = tabs.findIndex((x) => x.id === dragTab.current),
                  to = tabs.findIndex((x) => x.id === t.id);
                dragTab.current = "";
                if (from < 0 || from === to) return;
                const next = [...tabs];
                next.splice(to, 0, next.splice(from, 1)[0]);
                updatePane(side, (group) => ({ ...group, tabs: next }));
              }}
              onClick={() => activateTab(t.id, side)}
              onKeyDown={(e) => {
                if (e.key === "Enter") activateTab(t.id, side);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                focusPane(side);
                setMenu({ x: e.clientX, y: e.clientY, tab: t });
              }}
              title={t.path}
            >
              <Folder size={15} />
              <span>
                {basename(t.path)}
                {tabs.some(
                  (other) =>
                    other.id !== t.id &&
                    basename(other.path) === basename(t.path) &&
                    other.path !== t.path,
                )
                  ? ` · ${basename(t.path.replace(/[\\/][^\\/]+[\\/]?$/, ""))}`
                  : ""}
              </span>
              <button
                aria-label={`关闭标签 ${basename(t.path)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id, side);
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <Tool label="新建标签" onClick={() => newTab(tab.path, side)}>
            <Plus size={17} />
          </Tool>
          <div className="tabs-space" />
          <select
            className="tab-picker"
            aria-label="所有标签"
            value={active}
            onChange={(e) => activateTab(e.target.value, side)}
          >
            {tabs.map((t) => (
              <option key={t.id} value={t.id}>
                {basename(t.path)} — {t.path}
              </option>
            ))}
          </select>
        </nav>
        <div className="navigation">
          <div className="nav-buttons">
            <Tool
              label="后退"
              disabled={tab.index === 0}
              onClick={() => travel(-1, side)}
            >
              <ArrowLeft size={iconSize} />
            </Tool>
            <Tool
              label="前进"
              disabled={tab.index === tab.history.length - 1}
              onClick={() => travel(1, side)}
            >
              <ArrowRight size={iconSize} />
            </Tool>
            <Tool
              label="上一级"
              disabled={!listing?.parent}
              onClick={() => listing?.parent && go(listing.parent, side)}
            >
              <ArrowUp size={iconSize} />
            </Tool>
          </div>
          <div className="address" onDoubleClick={() => editPath(side)}>
            {editingPath === side ? (
              <input
                ref={pathRef}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onBlur={() => setEditingPath(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") go(address, side);
                  if (e.key === "Escape") setEditingPath(null);
                }}
                aria-label="完整路径"
              />
            ) : (
              <>
                <button
                  onClick={() => go(isWindows ? crumbPath(0) : "/", side)}
                  aria-label="根目录"
                >
                  <HardDrive size={15} />
                </button>
                {crumbs.map((c, i) => (
                  <span key={i}>
                    <ChevronRight size={13} />
                    <button onClick={() => go(crumbPath(i), side)}>{c}</button>
                  </span>
                ))}
                <button
                  className="address-edit"
                  aria-label="编辑路径"
                  onClick={() => editPath(side)}
                />
              </>
            )}
            <Tool label="刷新" onClick={refresh}>
              <RefreshCw size={14} className={loading ? "spin" : ""} />
            </Tool>
          </div>
          <div className="filter">
            <Search size={16} />
            <input
              aria-label="筛选当前文件夹"
              placeholder="筛选当前文件夹"
              value={tab.query}
              onChange={(e) =>
                patchPane({ query: e.target.value, selected: [], scroll: 0 })
              }
            />
            {tab.query && (
              <button
                aria-label="清除筛选"
                onClick={() => patchPane({ query: "" })}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
        <div className="toolbar">
          <button
            className="text-tool"
            aria-label="新建文件夹"
            title="新建文件夹"
            onClick={() => {
              setNewFolder(tab.path);
              setEditName("新建文件夹");
            }}
          >
            <FolderPlus size={17} />
            <span>新建文件夹</span>
          </button>
          <span className="separator" />
          <Tool
            label="复制"
            disabled={!selected.length}
            onClick={() => copy(false, selected)}
          >
            <Copy size={16} />
          </Tool>
          <Tool
            label="剪切"
            disabled={!selected.length}
            onClick={() => copy(true, selected)}
          >
            <Scissors size={16} />
          </Tool>
          <Tool label="粘贴" onClick={() => paste(tab.path)}>
            <Clipboard size={16} />
          </Tool>
          <Tool
            label="移到回收站"
            disabled={!selected.length}
            onClick={() => start("trash", selected, tab.path)}
          >
            <Trash2 size={16} />
          </Tool>
          <div className="toolbar-spacer" />
          <Tool
            label="切换排序方向"
            onClick={() => patchPane({ descending: !tab.descending })}
          >
            <ArrowDownUp size={16} />
          </Tool>
          <Tool
            label={hidden ? "隐藏隐藏文件" : "显示隐藏文件"}
            active={hidden}
            onClick={() => setHidden(!hidden)}
          >
            {hidden ? <Eye size={16} /> : <EyeOff size={16} />}
          </Tool>
          <div className="view-switch">
            <Tool
              label="列表视图"
              active={tab.view === "list"}
              onClick={() =>
                tab.view !== "list" && patchPane({ view: "list", scroll: 0 })
              }
            >
              <List size={16} />
            </Tool>
            <Tool
              label="图标视图"
              active={tab.view === "grid"}
              onClick={() =>
                tab.view !== "grid" && patchPane({ view: "grid", scroll: 0 })
              }
            >
              <LayoutGrid size={16} />
            </Tool>
            <Tool
              label="图标大小"
              expanded={viewPane === side}
              onClick={(event) => {
                event.stopPropagation();
                const bounds = event.currentTarget.getBoundingClientRect();
                setMenu(
                  viewPane === side
                    ? null
                    : {
                        x: bounds.right - 140,
                        y: bounds.bottom + 6,
                        viewPane: side,
                      },
                );
              }}
            >
              <ChevronDown size={13} />
            </Tool>
          </div>
          <Tool
            label="更多操作"
            onClick={(event) => {
              focusPane(side);
              setMenu({
                x: event.clientX || window.innerWidth - 230,
                y: event.clientY || 180,
              });
            }}
          >
            <MoreHorizontal size={18} />
          </Tool>
        </div>
        {!desktop && (
          <div className="demo-banner">
            界面预览 · 示例文件只读，使用桌面应用管理真实文件
          </div>
        )}
        {tab.view === "list" && (
          <div className="column-head">
            <button
              onClick={() =>
                patchPane({
                  sort: "name",
                  descending: tab.sort === "name" ? !tab.descending : false,
                })
              }
            >
              名称 {tab.sort === "name" && (tab.descending ? "↓" : "↑")}
            </button>
            <button
              onClick={() =>
                patchPane({ sort: "modified", descending: !tab.descending })
              }
            >
              修改日期
            </button>
            <span>类型</span>
            <button
              onClick={() =>
                patchPane({ sort: "size", descending: !tab.descending })
              }
            >
              大小
            </button>
          </div>
        )}
        <div
          className={`file-area ${tab.view}${dropHint && !dropHint.folder ? " drop-target" : ""}`}
          ref={listRef}
          tabIndex={0}
          aria-label="文件列表"
          data-pane={side}
          data-grid-size={
            tab.view === "grid" ? (tab.gridSize ?? "medium") : undefined
          }
          data-drop-path={listing?.path}
          onScroll={(e) => patchPane({ scroll: e.currentTarget.scrollTop })}
          onClick={(e) => {
            if (!(e.target as Element).closest("button, input"))
              patchPane({ selected: [] });
          }}
          onContextMenu={(e) => {
            if ((e.target as Element).closest("button, input")) return;
            e.preventDefault();
            focusPane(side);
            setMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          {loading && !listing && !error ? (
            <div className="empty">
              <LoaderCircle className="spin" size={28} />
              <p>正在读取文件夹…</p>
            </div>
          ) : error ? (
            <div className="empty">
              <Folder size={42} />
              <h3>暂时无法打开这个位置</h3>
              <p>{error}</p>
              <button className="primary" onClick={refresh}>
                重新尝试
              </button>
            </div>
          ) : !entries.length ? (
            <div className="empty">
              <Folder size={45} />
              <h3>{tab.query ? "没有匹配的项目" : "这个文件夹还是空的"}</h3>
              <p>
                {tab.query
                  ? "试试其他名称，或清除筛选。"
                  : "拖入文件，或新建一个文件夹。"}
              </p>
              {tab.query && (
                <button onClick={() => patchPane({ query: "" })}>
                  清除筛选
                </button>
              )}
            </div>
          ) : (
            <>
              {tab.view === "list" && (
                <div style={{ height: startIndex * 44 }} />
              )}
              {shown.map((entry) => {
                const type = describeFile(entry);
                const dragSource =
                  dragPreview?.pane === side &&
                  dragPreview.paths.has(entry.path);
                return (
                  <div
                    key={entry.path}
                    data-path={entry.path}
                    data-directory={entry.isDir ? entry.path : undefined}
                    onPointerDown={(event) =>
                      fileDrag.begin(event, {
                        ...dragSelection(entry),
                        pane: side,
                        directory: listing?.path ?? tab.path,
                      })
                    }
                    role="option"
                    aria-selected={selected.includes(entry.path)}
                    className={`file-row ${selected.includes(entry.path) ? "selected" : ""} ${cutPaths.includes(entry.path) ? "cut" : ""}${dragSource ? " drag-source" : ""}${dropHint?.folder === entry.path ? " drop-target" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      select(entry, e, side);
                    }}
                    onDoubleClick={() => open(entry, side)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      focusPane(side);
                      if (!selected.includes(entry.path))
                        patchPane({ selected: [entry.path] });
                      setMenu({ x: e.clientX, y: e.clientY, entry });
                    }}
                  >
                    <div className="file-name">
                      <FileIcon entry={entry} type={type} />
                      {rename?.pane === side && rename.path === entry.path ? (
                        <input
                          autoFocus
                          value={editName}
                          onFocus={(e) =>
                            e.target.setSelectionRange(
                              0,
                              entry.isDir
                                ? entry.name.length
                                : Math.max(0, entry.name.lastIndexOf(".")) ||
                                    entry.name.length,
                            )
                          }
                          onChange={(e) => setEditName(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") submitRename();
                            if (e.key === "Escape") setRename(null);
                          }}
                        />
                      ) : (
                        <span className="file-label">{entry.name}</span>
                      )}
                    </div>
                    {tab.view === "list" && (
                      <>
                        <span className="file-date">
                          {new Date(entry.modified * 1000).toLocaleDateString(
                            "zh-CN",
                            {
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                            },
                          )}
                        </span>
                        <span className="file-type" title={type.label}>
                          {type.label}
                        </span>
                        <span className="file-size">
                          {entry.isDir ? "—" : formatSize(entry.size)}
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
              {tab.view === "list" && (
                <div
                  style={{
                    height:
                      Math.max(0, entries.length - startIndex - shown.length) *
                      44,
                  }}
                />
              )}
            </>
          )}
        </div>
        <div className="location-footer">
          <Folder size={13} />
          <span title={tab.path}>{tab.path}</span>
          {dropHint ? (
            <span className="drop-hint" role="status" title={dropHint.path}>
              {dropHint.kind === "move" ? "移动到" : "复制到"}{" "}
              {basename(dropHint.path)}
              {dropHint.kind === "move" && (
                <kbd>{isMac ? "⌥" : "Ctrl"} 复制</kbd>
              )}
            </span>
          ) : (
            <span className="keyboard-tip">
              <Command size={12} /> L 前往文件夹
            </span>
          )}
        </div>
      </section>
    );
  }
  return (
    <div
      className={`app${dragPreview ? " dragging-files" : ""}`}
      onPointerDownCapture={() => {
        fileDrag.suppressClick.current = false;
      }}
      onClickCapture={(event) => {
        if (!fileDrag.suppressClick.current) return;
        fileDrag.suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={() => menu && setMenu(null)}
    >
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">
            <Folder size={18} />
          </span>
          <b>Filepace</b>
          <span className="version">PREVIEW</span>
        </div>
        <span className="window-location">
          {storageVisible ? "存储概览" : basename(tab.path)}
        </span>
        <div className="title-actions">
          <button
            className="window-action"
            aria-label="存储概览"
            aria-pressed={storageVisible}
            onClick={() => {
              setMenu(null);
              setTaskPanel(false);
              setStorageVisible(!storageVisible);
            }}
          >
            <BarChart3 size={16} /> 存储概览
          </button>
          <button
            className="window-action"
            aria-pressed={split}
            onClick={toggleSplit}
          >
            <Columns2 size={16} />
            {split ? "合并分栏" : "左右分栏"}
          </button>
          <button
            className="window-action"
            onClick={() => windowFor(makeTab(tab.path))}
          >
            <ExternalLink size={15} />
            新建窗口
          </button>
          <Tool label="切换侧边栏" onClick={() => setSidebar(!sidebar)}>
            <PanelLeft size={16} />
          </Tool>
        </div>
      </header>
      <div className="workspace">
        {sidebar && (
          <aside className="sidebar">
            <div className="section-label">常用位置</div>
            {places
              .filter((p) => p.kind === "favorite")
              .map((p, i) => {
                const Icon =
                  [Home, Monitor, Download, FileText, ImageIcon][i] || Folder;
                return (
                  <button
                    key={p.path}
                    className={`place ${tab.path === p.path ? "selected" : ""}`}
                    onClick={() => go(p.path)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        entry: {
                          name: p.name,
                          path: p.path,
                          isDir: true,
                          isLink: false,
                          modified: 0,
                          size: 0,
                          hidden: false,
                        },
                      });
                    }}
                  >
                    <Icon size={17} />
                    <span>{p.name}</span>
                    {tab.path === p.path && <span className="place-dot" />}
                  </button>
                );
              })}
            <div className="section-label section-spaced">
              收藏目录{" "}
              <button
                aria-label="收藏当前目录"
                title="收藏当前目录"
                onClick={() => favorite()}
              >
                <Plus size={14} />
              </button>
            </div>
            {favorites.length ? (
              favorites.map((path) => (
                <button
                  key={path}
                  className={`place ${path === tab.path ? "selected" : ""}`}
                  onClick={() => go(path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      entry: {
                        name: basename(path),
                        path,
                        isDir: true,
                        isLink: false,
                        modified: 0,
                        size: 0,
                        hidden: false,
                      },
                    });
                  }}
                >
                  <Star size={16} />
                  <span>{basename(path)}</span>
                </button>
              ))
            ) : (
              <div className="sidebar-hint">把常去的文件夹放在这里</div>
            )}
            <div className="section-label section-spaced">磁盘与位置</div>
            {places
              .filter((p) => p.kind === "disk")
              .map((p) => (
                <button
                  className={`place ${p.path === tab.path ? "selected" : ""}`}
                  key={p.path}
                  onClick={() => go(p.path)}
                >
                  <HardDrive size={17} />
                  <span>{p.name}</span>
                </button>
              ))}
            <div className="sidebar-bottom">
              <span className="green-dot" />
              本地工作空间<small>文件始终保存在你的设备上</small>
            </div>
          </aside>
        )}
        <main>
          <div
            className={`pane-stack${split ? " split" : ""}`}
            hidden={storageVisible}
          >
            {renderPane("left")}
            {split && renderPane("right")}
          </div>
          <StorageDashboard
            visible={storageVisible}
            currentPath={listing?.path ?? tab.path}
            scope={storageScope}
            places={[
              ...places,
              ...favorites.map((path) => ({
                name: basename(path),
                path,
                kind: "favorite",
              })),
            ]}
            onChoose={setStorageScope}
            onBrowse={(path, selectedPath) => go(path, focused, selectedPath)}
            onClose={() => setStorageVisible(false)}
          />
        </main>
      </div>
      <footer className="statusbar">
        <span>
          {storageVisible ? "本地存储概览" : `${entries.length} 个项目`}
          {!storageVisible && selected.length > 0 && (
            <>
              {" "}
              <span className="status-dot">·</span> 已选择 {selected.length} 项{" "}
              <span className="status-dot">·</span>{" "}
              {formatSize(
                entries
                  .filter((e) => selected.includes(e.path) && !e.isDir)
                  .reduce((s, e) => s + e.size, 0),
              )}
            </>
          )}
        </span>
        <button
          className={running.length ? "task-active" : ""}
          onClick={() => setTaskPanel(!taskPanel)}
        >
          {running.length ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <Check size={14} />
          )}{" "}
          {running.length ? `${running.length} 个文件任务` : "文件任务"}
          <ChevronRight size={13} />
        </button>
      </footer>
      {dragPreview && (
        <div
          className="drag-preview"
          ref={fileDrag.previewRef}
          aria-hidden="true"
        >
          <FileIcon entry={dragPreview.entry} showThumbnail={false} />
          <span className="drag-preview-name">{dragPreview.entry.name}</span>
          {dragPreview.paths.size > 1 && (
            <span className="drag-preview-count">
              {dragPreview.paths.size} 项
            </span>
          )}
          {fileDrag.hint && (
            <span className="drag-preview-operation">
              {fileDrag.hint.kind === "copy" ? "复制" : "移动"}
            </span>
          )}
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button onClick={() => setNotice("")} aria-label="关闭提示">
            <X size={14} />
          </button>
        </div>
      )}
      {menu && (
        <div
          className={`context-menu${viewPane ? " size-menu" : ""}`}
          ref={menuRef}
          aria-label={viewPane ? "选择图标大小" : undefined}
          role={viewPane ? "group" : undefined}
          onClick={(e) => e.stopPropagation()}
        >
          {viewPane ? (
            gridSizes.map(({ value, label }) => {
              const current =
                viewTab?.view === "grid" &&
                (viewTab.gridSize ?? "medium") === value;
              return (
                <button
                  key={value}
                  aria-pressed={current}
                  onClick={() => {
                    if (!current)
                      patch(
                        { view: "grid", gridSize: value, scroll: 0 },
                        viewPane,
                      );
                    setMenu(null);
                  }}
                >
                  <Check
                    size={15}
                    className={current ? "" : "size-menu-placeholder"}
                  />
                  {label}
                </button>
              );
            })
          ) : menu.tab ? (
            <>
              <button onClick={() => newTab(menu.tab!.path)}>新建标签</button>
              <button onClick={() => windowFor(menu.tab!, true)}>
                移到新窗口
              </button>
              <hr />
              <button onClick={() => closeTab(menu.tab!.id)}>关闭标签</button>
              <button
                onClick={() => {
                  closed.current[focused].push(
                    ...tabs.filter((t) => t.id !== menu.tab!.id),
                  );
                  updatePane(focused, () => ({
                    tabs: [menu.tab!],
                    active: menu.tab!.id,
                  }));
                  setMenu(null);
                }}
              >
                关闭其他标签
              </button>
              <button
                disabled={!closed.current[focused].length}
                onClick={() => {
                  restore();
                  setMenu(null);
                }}
              >
                恢复关闭的标签
              </button>
            </>
          ) : (
            <>
              {menu.entry && (
                <button
                  onClick={() => {
                    open(menu.entry!);
                    setMenu(null);
                  }}
                >
                  打开
                </button>
              )}
              {menu.entry?.isDir && (
                <>
                  <button onClick={() => newTab(menu.entry!.path)}>
                    在新标签打开
                  </button>
                  <button onClick={() => windowFor(makeTab(menu.entry!.path))}>
                    在新窗口打开
                  </button>
                  <button onClick={() => favorite(menu.entry!.path)}>
                    {favorites.includes(menu.entry.path)
                      ? "移除收藏"
                      : "添加到收藏"}
                  </button>
                </>
              )}
              {menu.entry && !menu.entry.isDir && (
                <>
                  <button onClick={() => chooseOpenWith(menu.entry!)}>
                    打开方式
                  </button>
                  <button
                    onClick={() => {
                      setPreview(menu.entry!);
                      setMenu(null);
                    }}
                  >
                    快速预览
                  </button>
                </>
              )}
              <hr />
              <button
                onClick={() =>
                  runMenuAction(async () => {
                    const paths =
                      menu.entry && selected.includes(menuPath)
                        ? selected
                        : [menuPath];
                    await call("clipboard_copy_paths", { paths });
                    setCutPaths([]);
                    setNotice("已复制路径");
                  })
                }
              >
                复制路径
              </button>
              {menu.entry && (
                <button
                  onClick={() =>
                    runMenuAction(async () => {
                      const paths = selected.includes(menuPath)
                        ? selected
                        : [menuPath];
                      await call("clipboard_copy_paths", {
                        paths,
                        namesOnly: true,
                      });
                      setCutPaths([]);
                      setNotice("已复制名称");
                    })
                  }
                >
                  复制名称
                </button>
              )}
              <button
                onClick={() =>
                  runMenuAction(() =>
                    desktop && menu.entry
                      ? revealItemInDir(menuPath)
                      : call("open_entry", { path: menuPath }),
                  )
                }
              >
                {isMac ? "在 Finder 中显示" : "在资源管理器中显示"}
              </button>
              <button
                onClick={() =>
                  runMenuAction(() =>
                    call("open_terminal", {
                      path: menuPath,
                      inParent: menu.entry?.isDir === false,
                    }),
                  )
                }
              >
                在命令行中打开
              </button>
              <hr />
              {menu.entry ? (
                <>
                  <button
                    onClick={() => {
                      copy();
                      setMenu(null);
                    }}
                  >
                    复制
                  </button>
                  <button
                    onClick={() => {
                      copy(true);
                      setMenu(null);
                    }}
                  >
                    剪切
                  </button>
                  <button onClick={() => renameSelected(menu.entry)}>
                    重命名
                  </button>
                  <button onClick={() => openProperties(menu.entry!)}>
                    属性
                  </button>
                  {menu.entry.isDir && (
                    <button
                      onClick={() => {
                        setStorageScope(menuPath);
                        setMenu(null);
                        setStorageVisible(true);
                      }}
                    >
                      分析占用空间
                    </button>
                  )}
                  <hr />
                  <button
                    className="danger-text"
                    onClick={() => start("trash")}
                  >
                    移到回收站
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      setNewFolder(tab.path);
                      setEditName("新建文件夹");
                      setMenu(null);
                    }}
                  >
                    新建文件夹
                  </button>
                  <button onClick={() => paste()}>粘贴</button>
                  <button onClick={() => favorite()}>收藏当前目录</button>
                  <button
                    onClick={() => {
                      restore();
                      setMenu(null);
                    }}
                  >
                    恢复关闭的标签
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {taskPanel && (
        <section className="task-panel">
          <div className="panel-title">
            <h3>
              文件任务 <small>{tasks.length}</small>
            </h3>
            <Tool label="关闭任务面板" onClick={() => setTaskPanel(false)}>
              <X size={17} />
            </Tool>
          </div>
          {tasks.length === 0 ? (
            <div className="task-empty">
              <ArrowDownToLine size={30} />
              <p>所有文件都已就绪</p>
              <span>复制与移动的进度会显示在这里</span>
            </div>
          ) : (
            tasks.map((t) => (
              <div className="task" key={t.id}>
                <div className="task-top">
                  <b>
                    {
                      (
                        {
                          copy: "复制",
                          move: "移动",
                          trash: "移到回收站",
                        } as Record<string, string>
                      )[t.kind]
                    }
                  </b>
                  <span>
                    {
                      (
                        {
                          running: "进行中",
                          conflict: "等待处理",
                          done: "已完成",
                          error: "部分失败",
                          cancelled: "已取消",
                        } as Record<string, string>
                      )[t.status]
                    }
                  </span>
                  {["running", "conflict"].includes(t.status) && (
                    <button
                      onClick={() =>
                        call("task_action", {
                          id: t.id,
                          decision: "cancel",
                          applyAll: false,
                        })
                      }
                    >
                      取消
                    </button>
                  )}
                </div>
                <p title={t.current}>{basename(t.current)}</p>
                <small>
                  已完成 {t.completed} 个文件 · {formatSize(t.bytes)}
                </small>
                {t.status === "running" && (
                  <div className="progress">
                    <i />
                  </div>
                )}
                {t.errors.length > 0 && (
                  <details>
                    <summary>{t.errors.length} 个问题</summary>
                    {t.errors.map((e, i) => (
                      <p className="task-error" key={i}>
                        {e}
                      </p>
                    ))}
                  </details>
                )}
              </div>
            ))
          )}
        </section>
      )}
      {openWith && (
        <div className="overlay" onClick={() => setOpenWith(null)}>
          <section
            className="modal properties-modal"
            role="dialog"
            aria-modal="true"
            aria-label="打开方式"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-title">
              <h3>
                <FileIcon entry={openWith.entry} showThumbnail={false} />{" "}
                打开方式
              </h3>
              <Tool label="关闭打开方式" onClick={() => setOpenWith(null)}>
                <X size={19} />
              </Tool>
            </div>
            <div className="open-with-options">
              <p>{openWith.entry.name}</p>
              {openWith.apps.map((app) => (
                <button
                  key={app.path}
                  title={app.path}
                  onClick={() => {
                    void runMenuAction(async () => {
                      await call("open_with", {
                        path: openWith.entry.path,
                        application: app.path,
                      });
                      setOpenWith(null);
                    });
                  }}
                >
                  {app.name}
                  {app.default && <small>默认</small>}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      {properties && (
        <div className="overlay" onClick={() => setProperties(null)}>
          <section
            className="modal properties-modal"
            role="dialog"
            aria-modal="true"
            aria-label="属性"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-title">
              <h3>
                <FileIcon entry={properties} showThumbnail={false} />
                属性
              </h3>
              <Tool label="关闭属性" onClick={() => setProperties(null)}>
                <X size={19} />
              </Tool>
            </div>
            <dl>
              <dt>名称</dt>
              <dd>{properties.name}</dd>
              <dt>类型</dt>
              <dd>{describeFile(properties).label}</dd>
              {!properties.isDir && (
                <>
                  <dt>大小</dt>
                  <dd>{formatSize(properties.size)}</dd>
                </>
              )}
              <dt>修改日期</dt>
              <dd>
                {new Date(properties.modified * 1000).toLocaleString("zh-CN")}
              </dd>
              <dt>路径</dt>
              <dd>{properties.path}</dd>
            </dl>
          </section>
        </div>
      )}
      {preview && (
        <div className="overlay" onClick={() => setPreview(null)}>
          <section
            className="preview modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-title">
              <h3>{preview.name}</h3>
              <Tool label="关闭预览" onClick={() => setPreview(null)}>
                <X size={19} />
              </Tool>
            </div>
            <div className="preview-body">
              {imageUrl ? (
                <img src={imageUrl} alt={preview.name} />
              ) : (
                <pre>{previewContent || "正在读取…"}</pre>
              )}
            </div>
            <div className="preview-footer">
              <span>← → 切换文件 · Esc 关闭</span>
              <button onClick={() => open(preview)}>
                <ExternalLink size={14} />
                默认应用打开
              </button>
            </div>
          </section>
        </div>
      )}
      {newFolder && (
        <div className="overlay">
          <form
            className="modal form-modal"
            onSubmit={(e) => {
              e.preventDefault();
              submitRename();
            }}
          >
            <h3>新建文件夹</h3>
            <p>创建于 {basename(newFolder)}</p>
            <input
              aria-label="文件夹名称"
              autoFocus
              value={editName}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setEditName(e.target.value)}
            />
            <div className="modal-buttons">
              <button type="button" onClick={() => setNewFolder(null)}>
                取消
              </button>
              <button className="primary" type="submit">
                创建
              </button>
            </div>
          </form>
        </div>
      )}
      {conflict && (
        <div className="overlay">
          <section className="modal form-modal">
            <h3>目标位置已有同名项目</h3>
            <p className="wrap">{conflict.conflict}</p>
            <p>替换会先将目标项目移到回收站。</p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={applyAll}
                onChange={(e) => setApplyAll(e.target.checked)}
              />
              应用到本次任务的后续冲突
            </label>
            <div className="modal-buttons">
              {[
                ["cancel", "取消任务"],
                ["skip", "跳过"],
                ["replace", "替换"],
                ["keep", "保留两者"],
              ].map(([decision, label]) => (
                <button
                  key={decision}
                  className={decision === "keep" ? "primary" : ""}
                  onClick={() =>
                    call("task_action", { id: conflict.id, decision, applyAll })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      {closePrompt && (
        <div className="overlay">
          <section className="modal form-modal">
            <h3>文件任务尚未完成</h3>
            <p>保持窗口打开，让文件任务继续。</p>
            <div className="modal-buttons">
              <button
                onClick={async () => {
                  await Promise.all(
                    running.map((t) =>
                      call("task_action", {
                        id: t.id,
                        decision: "cancel",
                        applyAll: false,
                      }),
                    ),
                  );
                  setClosePrompt(false);
                  setTaskPanel(true);
                  setNotice("正在取消任务；完成后可关闭窗口。");
                }}
              >
                取消任务
              </button>
              <button className="primary" onClick={() => setClosePrompt(false)}>
                继续任务
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
