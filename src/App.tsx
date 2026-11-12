import FileIcon from "./FileIcon";
import PaneDivider from "./PaneDivider";
import TaskPanel, { activeTask } from "./TaskPanel";
import BrowseOptions from "./BrowseOptions";
import ListHeader, { listColumnStyle } from "./ListHeader";
import MenuAction from "./MenuAction";
import StorageDashboard from "./StorageDashboard";
import DirectoryAnalysis from "./DirectoryAnalysis";
import type { DiagnosisStatus } from "./StorageDiagnosis";
import DiagnosisActivity, { DiagnosisCompletion } from "./DiagnosisActivity";
import { useDiagnosisNotifications } from "./diagnosisNotifications";
import UpdateNotice from "./UpdateNotice";
import SearchPanel from "./SearchPanel";
import ColumnBrowser from "./ColumnBrowser";
import BatchRename from "./BatchRename";
import ComparePanel from "./ComparePanel";
import ArchivePanel from "./ArchivePanel";
import CommandPalette, { type FileCommand } from "./CommandPalette";
import FileOperationDialog, { type FileOperation } from "./FileOperationDialog";
import type { ResultActionRequest } from "./resultActions";
import type { FileChange } from "./resultMutations";
import TextPreview from "./TextPreview";
import WorkLayouts from "./WorkLayouts";
import DuplicatePanel from "./DuplicatePanel";
import type { DuplicateGuard } from "./duplicateResults";
import {
  readSavedSearches,
  savedSearchesChanged,
  type SavedSearch,
} from "./savedSearches";
import Settings, { type SettingsSection } from "./Settings";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  FolderSearch,
  FileText,
  Image as ImageIcon,
  HardDrive,
  Home,
  Download,
  Monitor,
  Star,
  LayoutGrid,
  List,
  PanelLeft,
  RefreshCw,
  ExternalLink,
  Columns2,
  Columns3,
  Settings as SettingsIcon,
  Check,
  LoaderCircle,
  ArrowDownToLine,
  MoreHorizontal,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { call, desktop } from "./bridge";
import {
  invalidateDirectories,
  useBrowsePane,
  type PaneSession,
  type PaneSide,
} from "./browsePane";
import { isMac, useFileDrag } from "./fileDrag";
import { useMarquee } from "./marquee";
import { revealItem, visibleRange } from "./fileViewport";
import { describeFile } from "./fileTypes";
import { useFilePreview } from "./filePreview";
import { useFileActivity } from "./fileActivity";
import {
  usePreferences,
  type Shortcut,
  type SidebarSection,
} from "./preferences";
import { useUpdates } from "./updates";
import {
  basename,
  columnPaths,
  travelColumns,
  travelTab,
  makeTab,
  navigate,
  formatSize,
  entryGroup,
  type Entry,
  type Tab,
  type Place,
} from "./model";
import { cleanPane, restoreSession, type Session } from "./session";
const PdfPreview = lazy(() => import("./PdfPreview"));
type Menu = {
  x: number;
  y: number;
  entry?: Entry;
  tab?: Tab;
  viewPane?: PaneSide;
  ancestors?: { name: string; path: string }[];
  pane?: PaneSide;
  shortcut?: SidebarSection;
};
type OpenWithApp = { name: string; path: string; default: boolean };
type SearchLocation = { path: string; pane: PaneSide };
const createOptions = {
  folder: {
    title: "新建文件夹",
    label: "文件夹名称",
    name: "新建文件夹",
    command: "make_directory",
  },
  text: {
    title: "新建文本文档",
    label: "文档名称",
    name: "新建文本文档.txt",
    command: "make_text_file",
  },
} as const;
type CreateKind = keyof typeof createOptions;
const iconSize = 17;
const placeIcons: Record<string, LucideIcon> = {
  个人目录: Home,
  桌面: Monitor,
  下载: Download,
  文档: FileText,
  图片: ImageIcon,
};
const commandKey = isMac ? "⌘" : "Ctrl+";

function readRecentDirectories(): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem("filepace-recent-directories") ?? "[]",
    );
    return Array.isArray(value)
      ? value
          .filter((path): path is string => typeof path === "string")
          .slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function readFavorites(): string[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem("filepace-favorites") || "[]",
    );
    if (Array.isArray(stored))
      return stored.filter((path) => typeof path === "string" && path);
  } catch {}
  return [];
}

function SidebarGroup({
  label,
  collapsed,
  onToggle,
  action,
  children,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section className="sidebar-group" aria-label={label}>
      <div className="section-label sidebar-group-label">
        <button
          className="sidebar-disclosure"
          aria-expanded={!collapsed}
          aria-controls={id}
          onClick={onToggle}
        >
          <Chevron size={13} /> {label}
        </button>
        {action}
      </div>
      <div id={id} hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
function Tool({
  label,
  children,
  onClick,
  disabled = false,
  active,
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
      aria-pressed={active}
      aria-expanded={expanded}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export default function App() {
  const { preferences, change: changePreferences } = usePreferences();
  const updates = useUpdates(preferences.autoUpdate);
  const [session, setSession] = useState<Session>({ tabs: [], active: "" }),
    [places, setPlaces] = useState<Place[]>([]),
    [bootError, setBootError] = useState(""),
    [notice, setNotice] = useState("");
  const [hidden, setHidden] = useState(false),
    [sidebar, setSidebar] = useState(true),
    [editingPath, setEditingPath] = useState<PaneSide | null>(null),
    [address, setAddress] = useState(""),
    [menu, setMenu] = useState<Menu | null>(null),
    [taskPanel, setTaskPanel] = useState(false),
    [preview, setPreview] = useState<Entry | null>(null),
    [properties, setProperties] = useState<Entry | null>(null),
    [openWith, setOpenWith] = useState<{
      entry: Entry;
      apps: OpenWithApp[];
    } | null>(null),
    [storagePage, setStoragePage] = useState<
      "" | "overview" | "analysis" | "duplicates"
    >(""),
    [storageScope, setStorageScope] = useState(""),
    [searchScope, setSearchScope] = useState<SearchLocation | null>(null),
    [settingsSection, setSettingsSection] = useState<SettingsSection | null>(
      null,
    ),
    [rename, setRename] = useState<{ pane: PaneSide; path: string } | null>(
      null,
    ),
    [editName, setEditName] = useState(""),
    [newEntry, setNewEntry] = useState<{
      parent: string;
      kind: CreateKind;
    } | null>(null),
    [creating, setCreating] = useState(false),
    [createError, setCreateError] = useState(""),
    [closePrompt, setClosePrompt] = useState(false),
    [applyAllTask, setApplyAllTask] = useState<string | null>(null);
  const [favorites, setFavorites] = useState(readFavorites);
  const [batchEntries, setBatchEntries] = useState<Entry[] | null>(null);
  const [batchDuplicateGuard, setBatchDuplicateGuard] =
    useState<DuplicateGuard>();
  const [compareOpen, setCompareOpen] = useState(false);
  const [archive, setArchive] = useState<{
    entry: Entry;
    parent: string;
  } | null>(null);
  const [recentDirectories, setRecentDirectories] = useState(
    readRecentDirectories,
  );
  const [pathSuggestions, setPathSuggestions] = useState<string[]>([]);
  const addressSuggestions = useId();
  const [cutPaths, setCutPaths] = useState<string[]>([]);
  const [searchSessions, setSearchSessions] = useState<SearchLocation[]>([]);
  const [analysisReturn, setAnalysisReturn] = useState(false);
  const [diagnosisStatus, setDiagnosisStatus] =
    useState<DiagnosisStatus | null>(null);
  const [diagnosisNotice, setDiagnosisNotice] =
    useState<DiagnosisStatus | null>(null);
  const [diagnosisOpen, setDiagnosisOpen] = useState<{
    scope: string;
    request: number;
  }>();
  const [returnContext, setReturnContext] = useState<
    "search" | "analysis" | "duplicates" | null
  >(null);
  const [commandPalette, setCommandPalette] = useState(false);
  const [fileOperation, setFileOperation] = useState<FileOperation | null>(
    null,
  );
  const [layoutsOpen, setLayoutsOpen] = useState(false);
  const [duplicateScope, setDuplicateScope] = useState("");
  const [duplicateReturn, setDuplicateReturn] = useState(false);
  const [savedSearchList, setSavedSearchList] = useState(readSavedSearches);
  const [restoreSearch, setRestoreSearch] = useState<{
    search: SavedSearch;
    pane: PaneSide;
  } | null>(null);
  const [fileChangeBatches, setFileChangeBatches] = useState<
    { sequence: number; changes: FileChange[] }[]
  >([]);
  const mutationSequence = useRef(0);
  const previewEntries = useRef<Entry[]>([]);
  const closed = useRef<Record<PaneSide, Tab[]>>({ left: [], right: [] }),
    pathRef = useRef<HTMLInputElement>(null),
    menuRef = useRef<HTMLDivElement>(null),
    submittedTasks = useRef(new Set<string>()),
    dragTab = useRef("");
  const storageVisible = storagePage !== "";
  const diagnosisNotifications = useDiagnosisNotifications(openDiagnosis);
  const split = Boolean(session.right);
  const focused = split ? (session.focused ?? "left") : "left";
  const left = useBrowsePane(
    session,
    hidden,
    preferences.density === "compact",
  );
  const right = useBrowsePane(
    session.right,
    hidden,
    preferences.density === "compact",
  );
  const pane = focused === "left" ? left : right;
  const otherFolder = (focused === "left" ? right : left).listing?.path;
  const splitRatio = session.splitRatio ?? 0.5;
  const { tab, listing, entries, listRef } = pane;
  const systemPlaces = places.filter((place) => place.kind === "favorite");
  const commonPlaces = preferences.commonPlaces ?? systemPlaces;
  const { tabs, active } =
    (focused === "right" ? session.right : session) ?? session;
  const stateRef = useRef(session);
  stateRef.current = session;
  const selected = tab?.selected || [];
  const fileDrag = useFileDrag({
    focusedPath: tab?.path,
    transfer: start,
    onStart: () => setMenu(null),
    onError: setNotice,
  });
  const marquee = useMarquee(fileDrag.suppressClick);
  const { tasks, undo, refreshActivity } = useFileActivity();
  const previewPdf = desktop && Boolean(preview?.name.match(/\.pdf$/i));
  const previewOpen = Boolean(preview);
  useEffect(() => {
    if (!previewOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    document
      .querySelector<HTMLButtonElement>('.preview [aria-label="关闭预览"]')
      ?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [previewOpen]);
  const {
    text: previewContent,
    image: imageUrl,
    error: previewError,
  } = useFilePreview(previewPdf ? null : preview) ?? {};
  const running = tasks.filter(activeTask);
  const conflict = tasks.find((t) => t.status === "conflict" && t.conflict);
  const applyAll = conflict?.id === applyAllTask;
  function recordFileChanges(changes: FileChange[]) {
    if (!changes.length) return;
    const sequence = ++mutationSequence.current;
    setFileChangeBatches((batches) => [...batches, { sequence, changes }]);
  }
  useEffect(() => {
    if (!desktop) return;
    const stop = listen<FileChange[]>("files-mutated", ({ payload }) =>
      recordFileChanges(payload),
    );
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, []);
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
        splitRatio: session.splitRatio,
      });
    } else {
      const next = makeTab(tab.path, preferences.defaultView);
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
  function go(
    path: string,
    side = focused,
    selectedPath?: string,
    columns?: string[],
  ) {
    (side === "left" ? left : right).reveal.current = selectedPath ?? null;
    updatePane(side, (group) => ({
      ...group,
      tabs: group.tabs.map((t) =>
        t.id === group.active
          ? {
              ...(t.path === path ? t : navigate(t, path)),
              columns:
                t.view === "columns"
                  ? (columns ?? travelColumns(t, path))
                  : undefined,
              selected: selectedPath ? [selectedPath] : [],
            }
          : t,
      ),
    }));
    setStoragePage("");
    setSearchScope(null);
    setSettingsSection(null);
    setMenu(null);
    setEditingPath(null);
    setRename(null);
  }
  function openStoragePage(
    page: "overview" | "analysis" | "duplicates",
    path?: string,
  ) {
    setMenu(null);
    setTaskPanel(false);
    setSearchScope(null);
    setSettingsSection(null);
    if (page === "analysis") {
      setStorageScope(path || storageScope || listing?.path || tab?.path || "");
    }
    if (page === "duplicates")
      setDuplicateScope(path || listing?.path || tab?.path || "");
    setStoragePage(page);
  }
  function openDiagnosis(scope: string) {
    openStoragePage("analysis", scope);
    setDiagnosisOpen((current) => ({
      scope,
      request: (current?.request ?? 0) + 1,
    }));
    setDiagnosisNotice(null);
  }
  function handleDiagnosisStatus(status: DiagnosisStatus) {
    setDiagnosisStatus(status);
    if (status.phase === "preparing") {
      setDiagnosisNotice(null);
      void diagnosisNotifications.prepare();
    }
  }
  function handleDiagnosisComplete(status: DiagnosisStatus) {
    setDiagnosisNotice(status);
    void diagnosisNotifications.notify(status);
  }
  function openSearch(path = listing?.path ?? tab?.path) {
    if (!path) return;
    setMenu(null);
    setTaskPanel(false);
    setStoragePage("");
    setSettingsSection(null);
    const location = { path, pane: focused };
    setSearchSessions((sessions) =>
      [
        ...sessions.filter(
          (item) => item.path !== path || item.pane !== focused,
        ),
        location,
      ].slice(-6),
    );
    setSearchScope(location);
  }
  function returnToSearch(location: SearchLocation) {
    setStoragePage("");
    setSettingsSection(null);
    setSearchScope(location);
    focusPane(location.pane === "right" && !split ? "left" : location.pane);
  }
  function openSavedSearch(search: SavedSearch) {
    openSearch(search.path);
    setRestoreSearch({ search: { ...search }, pane: focused });
  }
  function openSettings(section: SettingsSection = "browse") {
    setMenu(null);
    setTaskPanel(false);
    setStoragePage("");
    setSearchScope(null);
    setSettingsSection(section);
  }
  function travel(delta: number, side = focused) {
    const target = side === "left" ? left : right;
    const current = target.tab;
    if (!current) return;
    const i = current.index + delta;
    if (i >= 0 && i < current.history.length) {
      patch(travelTab(current, i), side);
      target.listRef.current?.focus({ preventScroll: true });
    }
  }
  function activateTab(id: string, side = focused) {
    updatePane(side, (group) => ({ ...group, active: id }));
    setEditingPath(null);
    setRename(null);
    setMenu(null);
  }
  function newTab(path = tab?.path, side = focused) {
    if (!path) return;
    const next = makeTab(path, preferences.defaultView);
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
    if (tab) invalidateDirectories([listing?.path ?? tab.path]);
  }
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const ps = await call<Place[]>("places");
        const saved = await call<Session | null>("load_session");
        if (disposed) return;
        setPlaces(ps);
        setSession(
          restoreSession(saved, ps[0]?.path || "/", preferences.defaultView),
        );
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
          splitRatio,
        },
      }).catch((e) => setNotice("会话保存失败：" + String(e)));
    }, 300);
    return () => clearTimeout(timer);
  }, [session, focused]);
  async function installUpdate() {
    await call("save_session", {
      value: {
        ...cleanPane(session),
        right: session.right && cleanPane(session.right),
        focused,
        splitRatio,
      },
    });
    await updates.install();
  }
  const recoveryShown = useRef(false);
  useEffect(() => {
    if (
      recoveryShown.current ||
      !tasks.some((task) => task.id.startsWith("recovery-"))
    )
      return;
    recoveryShown.current = true;
    setTaskPanel(true);
    setNotice("上次文件操作中断，请在文件任务中核对保留位置。");
  }, [tasks]);
  useEffect(() => {
    for (const task of tasks) {
      if (activeTask(task)) continue;
      if (
        submittedTasks.current.delete(task.id) &&
        task.status === "error" &&
        !taskPanel
      ) {
        setNotice("文件任务遇到问题，可在「文件任务」查看详情。");
      }
    }
  }, [tasks, taskPanel]);
  useEffect(() => {
    if (!desktop) return;
    const stop = listen("exit-blocked", () => {
      setClosePrompt(true);
      void refreshActivity();
    });
    return () => {
      stop.then((f) => f());
    };
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let changed: Set<string> | null = new Set();
    const unlisten = listen<string[] | null>(
      "directory-changed",
      ({ payload }) => {
        if (!payload) changed = null;
        else if (changed) for (const path of payload) changed.add(path);
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          invalidateDirectories(changed ? [...changed] : null);
          changed = new Set();
        }, 120);
      },
    );
    return () => {
      unlisten.then((f) => f());
      clearTimeout(timer);
    };
  }, []);
  const watchGeneration = useRef(0);
  const watchedPaths = JSON.stringify(
    [left.tab, right.tab].flatMap((tab) =>
      tab ? (tab.view === "columns" ? columnPaths(tab) : [tab.path]) : [],
    ),
  );
  useEffect(() => {
    if (!desktop) return;
    const paths = JSON.parse(watchedPaths) as string[];
    const watch = () =>
      void call("watch_directories", {
        paths,
        generation: ++watchGeneration.current,
      }).catch(() => {});
    watch();
    const recheck = () => {
      watch();
      invalidateDirectories(paths);
    };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [watchedPaths]);
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !menu) return;
    const placeMenu = () => {
      element.style.left = `${Math.max(5, Math.min(menu.x, window.innerWidth - element.offsetWidth - 5))}px`;
      element.style.top = `${Math.max(5, Math.min(menu.y, window.innerHeight - element.offsetHeight - 5))}px`;
    };
    placeMenu();
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const observer = new ResizeObserver(placeMenu);
    observer.observe(element);
    window.addEventListener("resize", placeMenu);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", placeMenu);
    };
  }, [menu]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key === "filepace-favorites") setFavorites(readFavorites());
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    const sync = () => setSavedSearchList(readSavedSearches());
    window.addEventListener(savedSearchesChanged, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(savedSearchesChanged, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  useEffect(() => {
    if (editingPath) {
      pathRef.current?.focus();
      pathRef.current?.select();
    }
  }, [editingPath]);
  useEffect(() => {
    const paths = [left.listing?.path, right.listing?.path].filter(
      (path): path is string => Boolean(path),
    );
    if (!paths.length) return;
    const next = [...new Set([...paths, ...readRecentDirectories()])].slice(
      0,
      20,
    );
    localStorage.setItem("filepace-recent-directories", JSON.stringify(next));
    setRecentDirectories(next);
  }, [left.listing?.path, right.listing?.path]);
  useEffect(() => {
    setPathSuggestions([]);
    if (!desktop || !editingPath || address.length < 2) return;
    let active = true;
    const timer = setTimeout(() => {
      void call<string[]>("suggest_directories", { input: address }).then(
        (paths) => {
          if (active && Array.isArray(paths)) setPathSuggestions(paths);
        },
        () => {},
      );
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [editingPath, address]);
  useEffect(() => {
    for (const side of ["left", "right"] as const) {
      const { tab, listing, loading } = side === "left" ? left : right;
      if (!listing || loading || !tab?.selected.length) continue;
      const present = new Set(listing.entries.map((entry) => entry.path));
      const selected = tab.selected.filter((path) => present.has(path));
      if (selected.length !== tab.selected.length) patch({ selected }, side);
    }
  }, [left.listing, right.listing, left.loading, right.loading]);
  function editPath(side: PaneSide) {
    const target = side === "left" ? left : right;
    if (!target.tab) return;
    setAddress(target.listing?.path ?? target.tab.path);
    setEditingPath(side);
  }
  async function copy(
    cut = false,
    paths = selected,
    duplicateGuard?: DuplicateGuard,
  ) {
    if (!paths.length) return;
    try {
      await call("clipboard_set", {
        paths,
        cut,
        ...(cut && duplicateGuard ? { duplicateGuard } : {}),
      });
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
  function submittedResultTask(id: string) {
    submittedTasks.current.add(id);
    setTaskPanel(true);
    void refreshActivity();
  }
  async function resultAction(request: ResultActionRequest) {
    const { action, entries: items, target, scope, duplicateGuard } = request;
    const entry = target ?? items[0];
    const paths = items.map((item) => item.path);
    const requestedSide = searchScope?.pane ?? focused;
    const side = requestedSide === "right" && !split ? "left" : requestedSide;
    const otherSide = side === "left" ? "right" : "left";
    const other = (otherSide === "left" ? left : right).listing?.path;
    const parent = (path: string) =>
      path.slice(
        0,
        Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
      ) || "/";
    if (
      ["reveal", "other-pane"].includes(action) ||
      (action === "open" && entry?.isDir)
    ) {
      if (searchScope) setReturnContext("search");
      else if (storagePage === "analysis" || storagePage === "duplicates")
        setReturnContext(storagePage);
    }
    if (action === "preview" && entry && !entry.isDir) {
      previewEntries.current = (request.allEntries ?? items).filter(
        (item) => !item.isDir,
      );
      setPreview(entry);
    } else if (action === "open" && entry) {
      if (entry.isDir && storagePage === "analysis") setAnalysisReturn(true);
      if (entry.isDir && storagePage === "duplicates") setDuplicateReturn(true);
      await open(entry, side);
    } else if ((action === "reveal" || action === "other-pane") && entry) {
      if (storagePage === "analysis") setAnalysisReturn(true);
      if (storagePage === "duplicates") setDuplicateReturn(true);
      if (action === "other-pane" && !split) {
        const next = makeTab(parent(entry.path), preferences.defaultView);
        next.selected = [entry.path];
        setSession((current) => ({
          ...current,
          right: { tabs: [next], active: next.id },
          focused: "right",
        }));
        right.reveal.current = entry.path;
        setStoragePage("");
        setSearchScope(null);
      } else {
        const destinationSide = action === "other-pane" ? otherSide : side;
        focusPane(destinationSide);
        go(parent(entry.path), destinationSide, entry.path);
      }
    } else if (action === "copy" || action === "cut") {
      await copy(action === "cut", paths, duplicateGuard);
    } else if (action === "copy-path") {
      await runMenuAction(async () => {
        await call("clipboard_copy_paths", { paths });
        setCutPaths([]);
        setNotice("已复制路径");
      });
    } else if (action === "properties" && entry) {
      await openProperties(entry);
    } else if (action === "open-with" && entry) {
      await chooseOpenWith(entry);
    } else if (action === "rename" && items.length) {
      if (
        items.length > 1 &&
        new Set(items.map((item) => parent(item.path))).size > 1
      )
        setNotice("批量改名需要选择同一个文件夹内的项目，请分组处理。");
      else if (items.length > 1) {
        setBatchDuplicateGuard(duplicateGuard);
        setBatchEntries(items);
      } else
        setFileOperation({
          kind: "rename",
          entries: items,
          destination: "",
          duplicateGuard,
        });
    } else if (action === "trash" && paths.length) {
      await start(
        "trash",
        paths,
        scope || parent(paths[0]),
        undefined,
        duplicateGuard,
      );
    } else if (
      (action === "copy-other" || action === "move-other") &&
      paths.length
    ) {
      if (other)
        await start(
          action === "copy-other" ? "copy" : "move",
          paths,
          other,
          undefined,
          action === "move-other" ? duplicateGuard : undefined,
        );
      else setNotice("请先打开左右分栏并选择目标目录。");
    } else if ((action === "copy-to" || action === "move-to") && paths.length) {
      setFileOperation({
        kind: action === "copy-to" ? "copy" : "move",
        entries: items,
        destination: other ?? scope,
        duplicateGuard: action === "move-to" ? duplicateGuard : undefined,
      });
    } else if (action === "paste") {
      if (target?.isDir) {
        await paste(target.path);
        return;
      }
      try {
        const [sources, cut] = await call<[string[], boolean]>("clipboard_get");
        if (!sources.length) {
          setNotice("剪贴板中没有文件");
          return;
        }
        setFileOperation({
          kind: cut ? "move" : "copy",
          sources,
          entries: [],
          destination: scope,
        });
      } catch (error) {
        setNotice(String(error));
      }
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
    within?: string,
    duplicateGuard?: DuplicateGuard,
  ) {
    if (!paths.length || !destination) return false;
    setMenu(null);
    try {
      const id = await call<string>("start_task", {
        kind,
        sources: paths,
        destination,
        ...(within ? { within } : {}),
        ...(duplicateGuard ? { duplicateGuard } : {}),
      });
      submittedTasks.current.add(id);
      void refreshActivity();
      return true;
    } catch (e) {
      setNotice(String(e));
      return false;
    }
  }
  async function undoLast() {
    if (!undo || running.length || conflict || !desktop) return;
    try {
      const id = await call<string>("undo_last");
      submittedTasks.current.add(id);
      await refreshActivity();
    } catch (error) {
      setNotice(String(error));
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
    const current = anchor.current?.tab === tab.id ? anchor.current : null;
    const anchorIndex = entries.findIndex(
      (item) => item.path === current?.path,
    );
    if (e.shiftKey && current && anchorIndex >= 0) {
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
      anchor.current = { ...current, lead: entry.path };
    } else if (e.metaKey || e.ctrlKey) {
      patch(
        {
          selected: selected.includes(entry.path)
            ? selected.filter((p) => p !== entry.path)
            : [...selected, entry.path],
        },
        side,
      );
      anchor.current = { tab: tab.id, path: entry.path, lead: entry.path };
    } else {
      patch({ selected: [entry.path] }, side);
      anchor.current = { tab: tab.id, path: entry.path, lead: entry.path };
    }
  }
  function setSelection(paths: string[], side = focused) {
    const { tab, anchor } = side === "left" ? left : right;
    if (!tab) return;
    const path = paths.at(-1);
    anchor.current = path ? { tab: tab.id, path, lead: path } : null;
    patch({ selected: paths }, side);
  }
  function renameSelected(
    entry = listing?.entries.find((e) => e.path === selected[0]),
  ) {
    if (!entry) return;
    setRename({ pane: focused, path: entry.path });
    setEditName(entry.name);
    setMenu(null);
  }

  function openBatchRename() {
    if (!desktop || selected.length < 2) return;
    const paths = new Set(selected);
    const items = entries.filter((entry) => paths.has(entry.path));
    if (items.length < 2) return;
    setMenu(null);
    setBatchDuplicateGuard(undefined);
    setBatchEntries(items);
  }
  async function submitRename() {
    if (!rename) return;
    try {
      await call("rename_entry", { path: rename.path, name: editName });
      setRename(null);
      void refreshActivity();
      refresh();
    } catch (e) {
      setNotice(String(e));
    }
  }
  function promptCreate(kind: CreateKind, parent: string) {
    setRename(null);
    setNewEntry({ parent, kind });
    setEditName(createOptions[kind].name);
    setCreateError("");
    setMenu(null);
  }
  async function submitCreate() {
    if (!newEntry || creating) return;
    setCreating(true);
    setCreateError("");
    try {
      await call(createOptions[newEntry.kind].command, {
        parent: newEntry.parent,
        name: editName,
      });
      setNewEntry(null);
      refresh();
    } catch (error) {
      setCreateError(String(error));
    } finally {
      setCreating(false);
    }
  }
  function favorite(path = tab?.path) {
    if (!path) return;
    const current = readFavorites();
    const next = current.includes(path)
      ? current.filter((p) => p !== path)
      : [...current, path];
    setFavorites(next);
    localStorage.setItem("filepace-favorites", JSON.stringify(next));
    setMenu(null);
  }
  function toggleSidebarGroup(section: SidebarSection) {
    changePreferences(({ collapsedSidebar }) => ({
      collapsedSidebar: collapsedSidebar.includes(section)
        ? collapsedSidebar.filter((value) => value !== section)
        : [...collapsedSidebar, section],
    }));
  }
  function addCommonPlace(path: string, name = basename(path)) {
    changePreferences((current) => {
      const places = current.commonPlaces ?? systemPlaces;
      return {
        commonPlaces: places.some((place) => place.path === path)
          ? places
          : [...places, { path, name }],
        collapsedSidebar: current.collapsedSidebar.filter(
          (section) => section !== "common",
        ),
      };
    });
    setMenu(null);
  }
  function editCommonPlaces(edit: (places: Shortcut[]) => Shortcut[]) {
    changePreferences((current) => ({
      commonPlaces: edit(current.commonPlaces ?? systemPlaces),
    }));
    setMenu(null);
  }
  function shiftCommonPlace(path: string, delta: number) {
    editCommonPlaces((places) => {
      const index = places.findIndex((place) => place.path === path);
      if (index < 0 || index + delta < 0 || index + delta >= places.length)
        return places;
      const next = places.slice();
      const [place] = next.splice(index, 1);
      next.splice(index + delta, 0, place);
      return next;
    });
  }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        !tab ||
        fileDrag.preview ||
        marquee.frame
      )
        return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (layoutsOpen) {
        if (key === "escape") {
          e.preventDefault();
          setLayoutsOpen(false);
        }
        return;
      }
      if (fileOperation || commandPalette) return;
      if (menu && key === "escape") {
        e.preventDefault();
        setMenu(null);
        listRef.current?.focus();
        return;
      }
      if (batchEntries) {
        if (key === "escape" && !e.isComposing) setBatchEntries(null);
        return;
      }
      if (compareOpen) {
        if (key === "escape") setCompareOpen(false);
        return;
      }
      if (archive) {
        if (key === "escape") setArchive(null);
        return;
      }
      if (newEntry) {
        if (key === "escape" && !creating && !e.isComposing) {
          e.preventDefault();
          setNewEntry(null);
        }
        return;
      }
      if (conflict || closePrompt) return;
      if (preview) {
        if (key === "escape" || key === " ") {
          e.preventDefault();
          setPreview(null);
        }
        if (
          ["arrowleft", "arrowright"].includes(key) &&
          !(e.target as HTMLElement).closest("input,textarea,select")
        ) {
          e.preventDefault();
          const files = previewEntries.current.some(
            (item) => item.path === preview.path,
          )
            ? previewEntries.current
            : entries.filter((item) => !item.isDir);
          const index = files.findIndex((item) => item.path === preview.path);
          const next = files[index + (key === "arrowleft" ? -1 : 1)];
          if (next) setPreview(next);
        }
        return;
      }
      if (openWith || properties) {
        if (key === "escape") {
          setOpenWith(null);
          setProperties(null);
        }
        return;
      }
      if (mod && (key === "k" || (e.shiftKey && key === "p"))) {
        e.preventDefault();
        setMenu(null);
        setCommandPalette(true);
        return;
      }
      if (
        mod &&
        !e.shiftKey &&
        key === "z" &&
        !(e.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable="true"]',
        )
      ) {
        e.preventDefault();
        void undoLast();
        return;
      }
      if (mod && key === ",") {
        e.preventDefault();
        openSettings();
        return;
      }
      if (settingsSection) {
        if (key === "escape") setSettingsSection(null);
        return;
      }
      if (searchScope) {
        if (key === "escape") {
          e.preventDefault();
          setSearchScope(null);
        }
        return;
      }
      const typing = (e.target as HTMLElement).closest(
        'input,textarea,select,[contenteditable="true"]',
      );
      if (typing) return;
      if (conflict || closePrompt) return;
      if (key === "contextmenu" || (key === "f10" && e.shiftKey)) {
        const list = listRef.current;
        if (!list) return;
        e.preventDefault();
        const entry = entries.find((entry) => entry.path === selected.at(-1));
        const row =
          entry &&
          list.querySelector(`[data-path="${CSS.escape(entry.path)}"]`);
        const bounds = (row || list).getBoundingClientRect();
        setMenu({ x: bounds.left + 16, y: bounds.top + 18, entry });
        return;
      }
      if (
        desktop &&
        split &&
        mod &&
        e.shiftKey &&
        (key === "c" || key === "m")
      ) {
        e.preventDefault();
        const other = focused === "left" ? right : left;
        if (other.listing)
          void start(
            key === "c" ? "copy" : "move",
            selected,
            other.listing.path,
          );
        return;
      }
      if (storageVisible) {
        if (key === "escape") setStoragePage("");
        return;
      }
      if (
        !mod &&
        !e.altKey &&
        ["enter", " "].includes(key) &&
        (e.target as HTMLElement).closest("button, [role=tab]")
      )
        return;
      if (mod && !e.shiftKey && key === "f") {
        e.preventDefault();
        openSearch();
        return;
      }
      if (mod && !e.shiftKey && key === "z" && !closePrompt) {
        e.preventDefault();
        void undoLast();
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
        if (menu) setMenu(null);
        if (key === "n" && e.shiftKey) {
          promptCreate("folder", listing?.path ?? tab.path);
          return;
        }
        if (key === "t") e.shiftKey ? restore() : newTab();
        if (key === "n") windowFor(makeTab(tab.path, preferences.defaultView));
        if (key === "w") closeTab(tab.id);
        if (key === "l") editPath(focused);
        if (key === "a") setSelection(entries.map((x) => x.path));
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
        if (selected.length > 1 && desktop) openBatchRename();
        else renameSelected();
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
      if (key === "arrowup" && (e.altKey || (isMac && e.metaKey))) {
        e.preventDefault();
        if (listing?.parent) go(listing.parent);
        return;
      }
      if (isMac && e.metaKey && key === "arrowdown") {
        e.preventDefault();
        const entry = entries.find((item) => item.path === selected[0]);
        if (entry) void open(entry);
        return;
      }
      if (tab.view === "columns" && !e.altKey && !mod) {
        const columns = columnPaths(tab);
        if (key === "arrowleft" && columns.length > 1) {
          e.preventDefault();
          go(
            columns[columns.length - 2],
            focused,
            undefined,
            columns.slice(0, -1),
          );
          return;
        }
        if (key === "arrowright") {
          const folder = entries.find(
            (entry) => entry.isDir && selected.includes(entry.path),
          );
          if (folder) {
            e.preventDefault();
            go(folder.path, focused, undefined, [...columns, folder.path]);
          }
          return;
        }
      }
      const horizontal = key === "arrowleft" || key === "arrowright";
      if (
        !e.altKey &&
        !mod &&
        (["arrowup", "arrowdown"].includes(key) ||
          (tab.view === "grid" && horizontal))
      ) {
        e.preventDefault();
        const range = pane.anchor.current;
        const lead =
          range?.tab === tab.id && selected.includes(range.lead)
            ? range.lead
            : selected.at(-1);
        const index = entries.findIndex((x) => x.path === lead);
        const gridColumns = pane.layout.columns;
        const step =
          (horizontal ? 1 : gridColumns) *
          (key === "arrowdown" || key === "arrowright" ? 1 : -1);
        const next =
          entries[
            Math.max(
              0,
              Math.min(entries.length - 1, index < 0 ? 0 : index + step),
            )
          ];
        if (next) {
          select(next, {
            shiftKey: e.shiftKey,
            metaKey: false,
            ctrlKey: false,
          });
          const i = entries.indexOf(next);
          if (listRef.current) revealItem(listRef.current, i, pane.layout);
        }
      }
      if (key === "escape") {
        setMenu(null);
        setSelection([]);
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
  const browsingFiles = !storageVisible && !searchScope && !settingsSection;
  const hasFiles = browsingFiles && selected.length > 0;
  const fileCommands: FileCommand[] = [
    {
      id: "search",
      label: "搜索子文件夹",
      detail: listing?.path ?? tab.path,
      shortcut: `${commandKey}F`,
      run: () => openSearch(),
    },
    {
      id: "analysis",
      label: "分析当前目录",
      detail: "查看占用分析和智能诊断",
      run: () => openStoragePage("analysis", listing?.path ?? tab.path),
    },
    {
      id: "duplicates",
      label: "检查重复文件",
      detail: "逐字节核对相同内容，手动选择保留项",
      disabled: !desktop,
      run: () => openStoragePage("duplicates", listing?.path ?? tab.path),
    },
    { id: "tasks", label: "查看文件任务", run: () => setTaskPanel(true) },
    { id: "split", label: split ? "合并分栏" : "左右分栏", run: toggleSplit },
    {
      id: "layouts",
      label: "保存或恢复工作布局",
      detail: "保存左右目录、标签页和视图",
      run: () => setLayoutsOpen(true),
    },
    {
      id: "density",
      label:
        preferences.density === "compact" ? "切换舒适列表" : "切换紧凑列表",
      run: () =>
        changePreferences({
          density:
            preferences.density === "compact" ? "comfortable" : "compact",
        }),
    },
    {
      id: "copy",
      label: "复制所选文件",
      shortcut: `${commandKey}C`,
      disabled: !desktop || !hasFiles,
      run: () => void copy(),
    },
    {
      id: "cut",
      label: "剪切所选文件",
      shortcut: `${commandKey}X`,
      disabled: !desktop || !hasFiles,
      run: () => void copy(true),
    },
    {
      id: "paste",
      label: "粘贴到当前目录",
      detail: listing?.path ?? tab.path,
      shortcut: `${commandKey}V`,
      disabled: !desktop || !browsingFiles,
      run: () => void paste(),
    },
    {
      id: "copy-other",
      label: "复制到另一栏",
      shortcut: isMac ? "⇧⌘C" : "Ctrl+Shift+C",
      disabled: !desktop || !hasFiles || !otherFolder || !split,
      run: () => void start("copy", selected, otherFolder),
    },
    {
      id: "move-other",
      label: "移动到另一栏",
      shortcut: isMac ? "⇧⌘M" : "Ctrl+Shift+M",
      disabled: !desktop || !hasFiles || !otherFolder || !split,
      run: () => void start("move", selected, otherFolder),
    },
    {
      id: "rename",
      label: selected.length > 1 ? "批量重命名" : "重命名",
      disabled: !desktop || !hasFiles,
      run: () => (selected.length > 1 ? openBatchRename() : renameSelected()),
    },
    {
      id: "preview",
      label: "快速预览所选文件",
      shortcut: "Space",
      disabled: !hasFiles || selected.length !== 1,
      run: () => {
        const entry = entries.find(
          (item) => item.path === selected[0] && !item.isDir,
        );
        if (entry) {
          previewEntries.current = [];
          setPreview(entry);
        }
      },
    },
    {
      id: "undo",
      label: undo || "撤销上次移动或改名",
      shortcut: `${commandKey}Z`,
      disabled: !desktop || !undo || running.length > 0,
      run: () => void undoLast(),
    },
    {
      id: "folder",
      label: "新建文件夹",
      shortcut: isMac ? "⇧⌘N" : "Ctrl+Shift+N",
      disabled: !desktop || !browsingFiles,
      run: () => promptCreate("folder", listing?.path ?? tab.path),
    },
    {
      id: "settings",
      label: "打开设置",
      shortcut: `${commandKey},`,
      run: () => openSettings(),
    },
    ...savedSearchList.map((search) => ({
      id: `saved-${search.id}`,
      label: `搜索：${search.name}`,
      detail: search.path,
      run: () => openSavedSearch(search),
    })),
    ...(searchSessions.length
      ? [
          {
            id: "return-search",
            label: "返回搜索结果",
            detail: searchSessions.at(-1)!.path,
            run: () => returnToSearch(searchSessions.at(-1)!),
          },
        ]
      : []),
    ...(duplicateReturn
      ? [
          {
            id: "return-duplicates",
            label: "返回重复检查结果",
            detail: duplicateScope,
            run: () => {
              setSearchScope(null);
              setSettingsSection(null);
              setStoragePage("duplicates");
            },
          },
        ]
      : []),
  ];
  const menuPath = menu?.entry?.path ?? tab.path;
  const commonIndex = commonPlaces.findIndex(
    (place) => place.path === menuPath,
  );
  const currentPath = listing?.path ?? tab.path;
  const createOption = newEntry && createOptions[newEntry.kind];
  const viewPane = menu?.viewPane;
  const viewTab = viewPane === "left" ? left.tab : right.tab;
  const dragPreview = fileDrag.preview;

  function renderShortcut(
    place: Shortcut,
    Icon: LucideIcon,
    shortcut: SidebarSection,
  ) {
    return (
      <button
        key={place.path}
        className={`place ${currentPath === place.path ? "selected" : ""}`}
        title={place.path}
        onClick={() => go(place.path)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({
            x: event.clientX,
            y: event.clientY,
            shortcut,
            entry: {
              ...place,
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
        <span>{place.name}</span>
        {shortcut === "common" && currentPath === place.path && (
          <span className="place-dot" />
        )}
      </button>
    );
  }

  function renderPane(side: PaneSide) {
    const {
      tab,
      listing,
      entries,
      total,
      hiddenCount,
      hiddenMatches,
      restoringScroll,
      loading,
      error,
      attachList,
      element,
      height,
      layout,
      selected: selection,
    } = side === "left" ? left : right;
    const group = side === "left" ? session : session.right;
    if (!tab || !group) return null;
    const { tabs, active } = group;
    const selected = tab.selected;
    const dropHint = fileDrag.hint?.pane === side ? fileDrag.hint : null;
    const patchPane = (value: Partial<Tab>) => patch(value, side);
    const dragSelection = (entry: Entry) => ({
      entry,
      paths: selection.has(entry.path) ? selected : [entry.path],
    });
    const availableScroll = Math.max(
      0,
      Math.ceil(entries.length / layout.columns) * layout.step +
        2 * layout.padding -
        height,
    );
    const range = visibleRange(
      entries.length,
      Math.min(tab.scroll, availableScroll),
      height,
      layout,
    );
    const shown = entries.slice(range.start, range.end);
    const path = tab.path;
    const crumbs = path.split(/[\\/]/).filter(Boolean);
    const isWindows = path.includes("\\");
    const trail = columnPaths(tab);
    function crumbPath(i: number) {
      const parts = crumbs.slice(0, i + 1);
      if (!isWindows) return "/" + parts.join("/");
      const prefix = path.startsWith("\\\\") ? "\\\\" : "";
      const target = prefix + parts.join("\\");
      return (
        trail.find((column) => column.replace(/\\+$/, "") === target) ??
        (i === 0 ? target + "\\" : target)
      );
    }
    const label = side === "left" ? "左栏" : "右栏";
    const onlyHidden = !hidden && hiddenCount > 0 && total === 0;
    function renderFileRow(
      entry: Entry,
      directory: string,
      columns?: string[],
      child?: string,
      index?: number,
    ) {
      if (!tab) return null;
      const type = describeFile(entry);
      const current = !columns || columns.at(-1) === tab.path;
      const frame = marquee.frame;
      const marked =
        frame?.pane === side && frame.directory === directory
          ? frame.paths.has(entry.path)
          : current
            ? selection.has(entry.path)
            : child === entry.path;
      const dragSource =
        dragPreview?.pane === side && dragPreview.paths.has(entry.path);
      const group = tab.view === "list" ? tab.group : undefined;
      const groupLabel =
        group && index !== undefined ? entryGroup(entry, group) : undefined;
      const previous = group && index ? entries[index - 1] : undefined;
      const groupStart =
        group &&
        groupLabel &&
        (!previous || entryGroup(previous, group) !== groupLabel);
      return (
        <div
          key={entry.path}
          id={
            index === undefined
              ? undefined
              : `entry-${tab.id}-${encodeURIComponent(entry.path)}`
          }
          data-path={entry.path}
          data-directory={entry.isDir ? entry.path : undefined}
          onPointerDown={(event) =>
            fileDrag.begin(event, {
              ...(current
                ? dragSelection(entry)
                : { entry, paths: [entry.path] }),
              pane: side,
              directory,
            })
          }
          role="option"
          aria-selected={marked}
          aria-posinset={index === undefined ? undefined : index + 1}
          aria-setsize={index === undefined ? undefined : entries.length}
          className={`file-row ${marked ? "selected" : ""} ${cutPaths.includes(entry.path) ? "cut" : ""}${dragSource ? " drag-source" : ""}${dropHint?.folder === entry.path ? " drop-target" : ""}${groupStart ? " group-start" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            if (
              columns &&
              entry.isDir &&
              !e.shiftKey &&
              !e.metaKey &&
              !e.ctrlKey
            ) {
              go(entry.path, side, undefined, [...columns, entry.path]);
            } else if (!current && columns) {
              go(columns.at(-1)!, side, entry.path, columns);
            } else {
              select(entry, e, side);
            }
          }}
          onDoubleClick={() => {
            if (!columns || !entry.isDir) void open(entry, side);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            focusPane(side);
            if (!current && columns) {
              go(columns.at(-1)!, side, entry.path, columns);
            } else if (!selected.includes(entry.path)) {
              patchPane({ selected: [entry.path] });
            }
            setMenu({ x: e.clientX, y: e.clientY, entry });
          }}
        >
          <div className="file-name">
            {groupStart && (
              <span className="file-group-label" title={groupLabel}>
                {groupLabel}
              </span>
            )}
            <FileIcon entry={entry} type={type} />
            {rename?.pane === side && rename.path === entry.path ? (
              <input
                autoFocus
                aria-label="新文件名"
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
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setRename(null);
                  }
                }}
              />
            ) : (
              <span className="file-label" title={entry.name}>
                {entry.name}
              </span>
            )}
          </div>
          {columns && entry.isDir && (
            <ChevronRight size={14} className="column-chevron" />
          )}
          {tab.view === "list" && (
            <>
              <span className="file-date">
                {new Date(entry.modified * 1000).toLocaleDateString("zh-CN", {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                })}
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
    }
    const fileArea = (
      <div
        className={`file-area ${tab.view === "columns" ? "column-list" : tab.view}${dropHint?.path === listing?.path && dropHint && !dropHint.folder ? " drop-target" : ""}`}
        ref={attachList}
        tabIndex={0}
        role="listbox"
        aria-multiselectable="true"
        aria-activedescendant={
          shown.some((entry) => entry.path === selected.at(-1))
            ? `entry-${tab.id}-${encodeURIComponent(selected.at(-1)!)}`
            : undefined
        }
        aria-label="文件列表"
        data-pane={side}
        data-grid-size={
          tab.view === "grid" ? (tab.gridSize ?? "medium") : undefined
        }
        data-drop-path={listing?.path}
        onPointerDown={(event) => {
          if (listing)
            marquee.begin(event, {
              pane: side,
              directory: listing.path,
              entries,
              rowHeight: tab.view === "grid" ? undefined : layout.height,
              grid: tab.view === "grid" ? layout : undefined,
              selected,
              commit: (paths) => setSelection(paths, side),
            });
        }}
        onScroll={(e) => {
          if (!restoringScroll.current)
            patchPane({ scroll: e.currentTarget.scrollTop });
        }}
        onClick={(e) => {
          if (!(e.target as Element).closest("button, input"))
            setSelection([], side);
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
            {desktop && (
              <button onClick={() => openSettings("errors")}>
                查看错误日志
              </button>
            )}
          </div>
        ) : !entries.length ? (
          <div className="empty">
            <Folder size={45} />
            <h3>
              {tab.query
                ? "没有匹配的项目"
                : onlyHidden
                  ? "这个文件夹只有隐藏项目"
                  : "这个文件夹还是空的"}
            </h3>
            <p>
              {tab.query
                ? !hidden && hiddenMatches
                  ? `另有 ${hiddenMatches} 个匹配项被隐藏，可以显示隐藏文件。`
                  : "试试其他名称，或清除筛选。"
                : onlyHidden
                  ? `有 ${hiddenCount} 个隐藏项目，显示后即可查看。`
                  : "拖入文件，或新建一个文件夹。"}
            </p>
            {tab.query && (
              <button onClick={() => patchPane({ query: "" })}>清除筛选</button>
            )}
            {!hidden && (onlyHidden || (tab.query && hiddenMatches > 0)) && (
              <button onClick={() => setHidden(true)}>显示隐藏文件</button>
            )}
            {!tab.query && !onlyHidden && (
              <button
                onClick={() =>
                  promptCreate("folder", listing?.path ?? tab.path)
                }
              >
                新建文件夹
              </button>
            )}
          </div>
        ) : (
          <>
            <div role="presentation" style={{ height: range.above }} />
            <div
              role="presentation"
              className={tab.view === "grid" ? "grid-items" : undefined}
              style={
                tab.view === "grid"
                  ? {
                      gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
                    }
                  : undefined
              }
            >
              {shown.map((entry, index) =>
                renderFileRow(
                  entry,
                  listing?.path ?? tab.path,
                  tab.view === "columns" ? trail : undefined,
                  undefined,
                  range.start + index,
                ),
              )}
            </div>
            <div role="presentation" style={{ height: range.below }} />
          </>
        )}
      </div>
    );
    return (
      <section
        className={`file-pane${focused === side ? " focused" : ""}`}
        style={listColumnStyle(tab.columnWidths)}
        aria-label={split ? label : "文件浏览"}
        aria-busy={loading}
        onPointerDownCapture={() => focusPane(side)}
        onFocusCapture={() => focusPane(side)}
      >
        <nav className="tabs" aria-label="文件标签">
          {loading && listing && (
            <span className="pane-read-status" title="正在读取文件夹">
              读取中 · {listing.entries.length.toLocaleString()} 项
            </span>
          )}
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
        <div className="pane-controls">
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
                  list={addressSuggestions}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  onBlur={() => setEditingPath(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") go(address, side);
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setEditingPath(null);
                      (side === "left" ? left : right).listRef.current?.focus();
                    }
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
                  {crumbs.length > 1 && (
                    <button
                      className={`ancestor-toggle${crumbs.length <= 2 ? " short-path" : ""}`}
                      aria-label="上级目录"
                      title="选择上级目录"
                      onClick={(event) => {
                        const bounds =
                          event.currentTarget.getBoundingClientRect();
                        setMenu({
                          x: bounds.left,
                          y: bounds.bottom + 5,
                          pane: side,
                          ancestors: crumbs.slice(0, -1).map((name, index) => ({
                            name,
                            path: crumbPath(index),
                          })),
                        });
                      }}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  )}
                  {crumbs.slice(-2).map((c, offset) => {
                    const i = Math.max(0, crumbs.length - 2) + offset;
                    return (
                      <span
                        key={i}
                        className={
                          i === crumbs.length - 1
                            ? "current-crumb"
                            : "parent-crumb"
                        }
                      >
                        <ChevronRight size={13} />
                        <button
                          title={crumbPath(i)}
                          onClick={() => go(crumbPath(i), side)}
                        >
                          {c}
                        </button>
                      </span>
                    );
                  })}
                  <button
                    className="address-edit"
                    aria-label="编辑路径"
                    title={`${isMac ? "⌘" : "Ctrl+"}L 前往文件夹`}
                    onClick={() => editPath(side)}
                  />
                </>
              )}
              <Tool label="刷新" onClick={refresh}>
                <RefreshCw size={14} className={loading ? "spin" : ""} />
              </Tool>
            </div>
          </div>
          <div className={`filter${tab.query ? " active" : ""}`}>
            <Search size={16} />
            <input
              aria-label="筛选当前文件夹"
              placeholder="筛选当前文件夹"
              value={tab.query}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || event.nativeEvent.isComposing)
                  return;
                event.preventDefault();
                if (tab.query) patchPane({ query: "", scroll: 0 });
                else (side === "left" ? left : right).listRef.current?.focus();
              }}
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
          <div className="toolbar">
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
                label="列视图"
                active={tab.view === "columns"}
                onClick={() =>
                  tab.view !== "columns" &&
                  patchPane({ view: "columns", columns: undefined, scroll: 0 })
                }
              >
                <Columns3 size={iconSize} />
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
                label="显示选项"
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
        </div>
        {!desktop && (
          <div className="demo-banner">
            界面预览 · 示例文件只读，使用桌面应用管理真实文件
          </div>
        )}
        {tab.view === "list" && (
          <ListHeader tab={tab} patch={patchPane} list={element} />
        )}
        {tab.view === "columns" ? (
          <ColumnBrowser
            tab={tab}
            side={side}
            hidden={hidden}
            active={fileArea}
            preview={
              selected.length === 1
                ? entries.find(
                    (entry) => !entry.isDir && entry.path === selected[0],
                  )
                : undefined
            }
            dropPath={dropHint && !dropHint.folder ? dropHint.path : undefined}
            renderRow={renderFileRow}
            onChoose={(columns) =>
              go(columns.at(-1)!, side, undefined, columns)
            }
            onContext={(event, columns) => {
              event.preventDefault();
              go(columns.at(-1)!, side, undefined, columns);
              setMenu({ x: event.clientX, y: event.clientY });
            }}
            onMarquee={(event, columns, directory, entries) =>
              marquee.begin(event, {
                pane: side,
                directory,
                entries,
                rowHeight: 34,
                selected: [],
                commit: (paths) => {
                  go(columns.at(-1)!, side, undefined, columns);
                  setSelection(paths, side);
                },
              })
            }
            onOpen={(entry) => open(entry, side)}
          />
        ) : (
          fileArea
        )}
        {dropHint && (
          <div className="drop-hint" role="status" title={dropHint.path}>
            <span>
              {dropHint.kind === "move" ? "移动到" : "复制到"}{" "}
              {basename(dropHint.path)}
            </span>
            {dropHint.kind === "move" && <kbd>{isMac ? "⌥" : "Ctrl"} 复制</kbd>}
          </div>
        )}
      </section>
    );
  }
  return (
    <div
      className={`app${dragPreview ? " dragging-files" : ""}`}
      data-density={preferences.density}
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
        {!desktop && (
          <div className="brand">
            <span className="brand-mark">
              <Folder size={18} />
            </span>
            <b>Filepace</b>
          </div>
        )}
        <span className="window-location">
          {settingsSection
            ? "设置"
            : storageVisible
              ? storagePage === "analysis"
                ? "目录分析"
                : storagePage === "duplicates"
                  ? "重复文件检查"
                  : "存储概览"
              : searchScope
                ? "搜索子文件夹"
                : basename(tab.path)}
        </span>
        <div className="title-actions">
          {!searchScope &&
            !storageVisible &&
            !settingsSection &&
            returnContext === "search" &&
            searchSessions.length > 0 && (
              <button
                className="window-action return-results"
                onClick={() => returnToSearch(searchSessions.at(-1)!)}
                title={searchSessions.at(-1)!.path}
              >
                <ArrowLeft size={15} /> 返回搜索结果
              </button>
            )}
          {!storageVisible &&
            !searchScope &&
            !settingsSection &&
            returnContext === "analysis" &&
            analysisReturn && (
              <button
                className="window-action return-results"
                onClick={() => openStoragePage("analysis")}
              >
                <ArrowLeft size={15} /> 返回分析结果
              </button>
            )}
          {!storageVisible &&
            !searchScope &&
            !settingsSection &&
            returnContext === "duplicates" &&
            duplicateReturn && (
              <button
                className="window-action return-results"
                onClick={() => setStoragePage("duplicates")}
              >
                <ArrowLeft size={15} /> 返回重复检查结果
              </button>
            )}
          <Tool
            label={`命令面板（${commandKey}K）`}
            onClick={() => {
              setMenu(null);
              setCommandPalette(true);
            }}
          >
            <Search size={16} />
          </Tool>
          <button
            className="window-action"
            aria-label="搜索子文件夹"
            aria-pressed={Boolean(searchScope)}
            onClick={() => (searchScope ? setSearchScope(null) : openSearch())}
          >
            <FolderSearch size={16} /> 搜索子文件夹
          </button>
          <button
            className="window-action"
            aria-label="存储概览"
            aria-pressed={storagePage === "overview"}
            onClick={() => {
              if (storagePage === "overview") setStoragePage("");
              else openStoragePage("overview");
            }}
          >
            <BarChart3 size={16} /> 存储概览
          </button>
          <button
            className="window-action"
            aria-label="目录分析"
            aria-pressed={storagePage === "analysis"}
            onClick={() =>
              storagePage === "analysis"
                ? setStoragePage("")
                : openStoragePage("analysis")
            }
          >
            <FolderSearch size={16} /> 目录分析
          </button>
          <button
            className="window-action"
            aria-pressed={split}
            onClick={toggleSplit}
          >
            <Columns2 size={16} />
            {split ? "合并分栏" : "左右分栏"}
          </button>
          {desktop && split && (
            <button
              className="window-action"
              disabled={!left.listing || !right.listing}
              onClick={() => setCompareOpen(true)}
            >
              对比目录
            </button>
          )}
          <Tool label="切换侧边栏" onClick={() => setSidebar(!sidebar)}>
            <PanelLeft size={16} />
          </Tool>
        </div>
      </header>
      <datalist id={addressSuggestions}>
        {[
          ...new Set([
            ...pathSuggestions,
            ...recentDirectories,
            ...commonPlaces.map((place) => place.path),
            ...favorites,
          ]),
        ].map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>
      <div className="workspace">
        {sidebar && (
          <aside className="sidebar" aria-label="位置侧栏">
            <div className="sidebar-locations">
              <SidebarGroup
                label="常用位置"
                collapsed={preferences.collapsedSidebar.includes("common")}
                onToggle={() => toggleSidebarGroup("common")}
                action={
                  <button
                    aria-label="添加当前目录到常用位置"
                    title="添加当前目录到常用位置"
                    disabled={
                      !listing ||
                      commonPlaces.some((place) => place.path === currentPath)
                    }
                    onClick={() => addCommonPlace(currentPath)}
                  >
                    <Plus size={14} />
                  </button>
                }
              >
                {commonPlaces.length ? (
                  commonPlaces.map((place) => {
                    const system = systemPlaces.find(
                      (item) => item.path === place.path,
                    );
                    return renderShortcut(
                      place,
                      placeIcons[system?.name ?? ""] ?? Folder,
                      "common",
                    );
                  })
                ) : (
                  <div className="sidebar-hint">用加号添加当前文件夹</div>
                )}
              </SidebarGroup>
              {savedSearchList.some((search) => search.pinned) && (
                <section className="sidebar-group" aria-label="保存的搜索">
                  <div className="section-label">保存的搜索</div>
                  {savedSearchList
                    .filter((search) => search.pinned)
                    .map((search) => (
                      <button
                        key={search.id}
                        className="place"
                        title={`${search.name}\n${search.path}`}
                        onClick={() => openSavedSearch(search)}
                      >
                        <FolderSearch size={16} />
                        <span>{search.name}</span>
                      </button>
                    ))}
                </section>
              )}
              <SidebarGroup
                label="收藏目录"
                collapsed={preferences.collapsedSidebar.includes("favorites")}
                onToggle={() => toggleSidebarGroup("favorites")}
                action={
                  <button
                    aria-label="收藏当前目录"
                    title="收藏当前目录"
                    disabled={!listing || favorites.includes(currentPath)}
                    onClick={() => favorite(currentPath)}
                  >
                    <Plus size={14} />
                  </button>
                }
              >
                {favorites.length ? (
                  favorites.map((path) =>
                    renderShortcut(
                      { name: basename(path), path },
                      Star,
                      "favorites",
                    ),
                  )
                ) : (
                  <div className="sidebar-hint">把常去的文件夹放在这里</div>
                )}
              </SidebarGroup>
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
            </div>
            <div className="sidebar-bottom">
              <DiagnosisActivity
                status={diagnosisStatus}
                onOpen={openDiagnosis}
              />
              <UpdateNotice
                status={updates.status}
                onClick={() => openSettings("update")}
              />
              <button
                className="place"
                aria-pressed={Boolean(settingsSection)}
                onClick={() => openSettings()}
              >
                <SettingsIcon size={16} />
                <span>设置</span>
              </button>
            </div>
          </aside>
        )}
        <main>
          <div
            className={`pane-stack${split ? " split" : ""}`}
            style={
              split
                ? {
                    gridTemplateColumns: `minmax(0, ${splitRatio}fr) 1px minmax(0, ${1 - splitRatio}fr)`,
                  }
                : undefined
            }
            hidden={
              storageVisible || Boolean(searchScope) || Boolean(settingsSection)
            }
          >
            {renderPane("left")}
            {split && (
              <PaneDivider
                ratio={splitRatio}
                onChange={(splitRatio) =>
                  setSession((current) => ({ ...current, splitRatio }))
                }
              />
            )}
            {split && renderPane("right")}
          </div>
          <StorageDashboard
            visible={storagePage === "overview"}
            onAnalyze={(path) => openStoragePage("analysis", path)}
            onBrowse={(path) => go(path)}
            onClose={() => setStoragePage("")}
          />
          <DirectoryAnalysis
            visible={storagePage === "analysis"}
            onDiagnosisStatus={handleDiagnosisStatus}
            onDiagnosisComplete={handleDiagnosisComplete}
            diagnosisOpen={diagnosisOpen}
            currentPath={listing?.path ?? tab.path}
            scope={storageScope}
            places={[
              ...places.filter((place) => place.kind === "disk"),
              ...commonPlaces.map((place) => ({ ...place, kind: "favorite" })),
              ...favorites.map((path) => ({
                name: basename(path),
                path,
                kind: "favorite",
              })),
            ]}
            onChoose={setStorageScope}
            onBrowse={(path, selectedPath) => {
              setAnalysisReturn(true);
              setReturnContext("analysis");
              go(path, focused, selectedPath);
            }}
            onFileAction={(request) => void resultAction(request)}
            fileChangeBatches={fileChangeBatches}
            onClose={() => setStoragePage("")}
          />
          <DuplicatePanel
            path={duplicateScope || listing?.path || tab.path}
            hidden={hidden}
            visible={storagePage === "duplicates"}
            onBrowse={(path, selectedPath) => {
              setDuplicateReturn(true);
              setReturnContext("duplicates");
              go(path, focused, selectedPath);
            }}
            onClose={() => setStoragePage("")}
            onFileAction={(request) => void resultAction(request)}
            fileChangeBatches={fileChangeBatches}
          />
          {searchSessions.map((location) => (
            <SearchPanel
              key={`${location.pane}:${location.path}`}
              path={location.path}
              visible={
                searchScope?.path === location.path &&
                searchScope.pane === location.pane
              }
              hidden={hidden}
              restoreSearch={
                restoreSearch?.pane === location.pane &&
                restoreSearch.search.path === location.path
                  ? restoreSearch.search
                  : undefined
              }
              onBrowse={(path, selectedPath) => {
                setReturnContext("search");
                go(
                  path,
                  location.pane === "right" && !split ? "left" : location.pane,
                  selectedPath,
                );
              }}
              onFileAction={(request) => void resultAction(request)}
              fileChangeBatches={fileChangeBatches}
              onClose={() => setSearchScope(null)}
            />
          ))}
          {settingsSection && (
            <Settings
              section={settingsSection}
              onSection={setSettingsSection}
              preferences={preferences}
              change={changePreferences}
              status={updates.status}
              busy={running.length > 0}
              check={updates.check}
              install={installUpdate}
              onClose={() => setSettingsSection(null)}
            />
          )}
        </main>
      </div>
      <footer className="statusbar">
        <span>
          {settingsSection ? (
            "应用设置"
          ) : storageVisible ? (
            storagePage === "analysis" ? (
              "目录分析 · 扫描快照"
            ) : storagePage === "duplicates" ? (
              "重复文件检查 · 内容校验"
            ) : (
              "本地存储概览"
            )
          ) : searchScope ? (
            "搜索子文件夹"
          ) : (
            <>
              {split && (
                <span className="status-pane">
                  {focused === "left" ? "左栏" : "右栏"} ·{" "}
                </span>
              )}
              {tab.query
                ? `匹配 ${entries.length} 项，共 ${pane.total} 项`
                : `${entries.length} 个项目`}
              {!hidden && pane.hiddenCount > 0 && (
                <span className="hidden-count">
                  {" "}
                  · 隐藏 {pane.hiddenCount} 项
                </span>
              )}
            </>
          )}
          {!storageVisible &&
            !searchScope &&
            !settingsSection &&
            selected.length > 0 && (
              <>
                {" "}
                <span className="status-dot">·</span> 已选择 {selected.length}{" "}
                项 <span className="status-dot">·</span>{" "}
                {formatSize(pane.selectedBytes)}
              </>
            )}
        </span>
        <div className="status-actions">
          {!sidebar && (
            <DiagnosisActivity
              status={diagnosisStatus}
              onOpen={openDiagnosis}
              compact
            />
          )}
          {!sidebar && (
            <UpdateNotice
              status={updates.status}
              onClick={() => openSettings("update")}
              compact
            />
          )}
          {!sidebar && (
            <button onClick={() => openSettings()}>
              <SettingsIcon size={14} /> 设置
            </button>
          )}
          <button
            aria-label={undo ?? "撤销上一步"}
            title={undo ?? "撤销上一步"}
            disabled={!undo || running.length > 0}
            onClick={() => void undoLast()}
          >
            <Undo2 size={14} /> 撤销
          </button>
          <button
            className={running.length ? "task-active" : ""}
            aria-expanded={taskPanel}
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
        </div>
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
      {marquee.frame && (
        <div
          className="selection-marquee"
          aria-hidden="true"
          style={marquee.frame.style}
        />
      )}
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button onClick={() => setNotice("")} aria-label="关闭提示">
            <X size={14} />
          </button>
        </div>
      )}
      {diagnosisNotice && (
        <DiagnosisCompletion
          status={diagnosisNotice}
          onOpen={openDiagnosis}
          onDismiss={() => setDiagnosisNotice(null)}
        />
      )}
      {menu && (
        <div
          className={`context-menu${viewPane ? " browse-options" : ""}`}
          ref={menuRef}
          aria-label={
            viewPane ? "显示选项" : menu.ancestors ? "选择上级目录" : "文件操作"
          }
          role="group"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(event) => {
            if (
              (event.target as HTMLElement).closest("select, input") ||
              !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            );
            const current = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (current +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      buttons.length) %
                    buttons.length;
            buttons[index]?.focus();
          }}
        >
          {viewPane && viewTab ? (
            <BrowseOptions
              tab={viewTab}
              patch={(value) => patch(value, viewPane)}
              hidden={hidden}
              showHidden={setHidden}
            />
          ) : menu.ancestors ? (
            menu.ancestors.map((ancestor) => (
              <button
                key={ancestor.path}
                title={ancestor.path}
                onClick={() => go(ancestor.path, menu.pane)}
              >
                {ancestor.name}
              </button>
            ))
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
              {menu.shortcut === "common" && (
                <>
                  <button
                    disabled={commonIndex <= 0}
                    onClick={() => shiftCommonPlace(menuPath, -1)}
                  >
                    上移
                  </button>
                  <button
                    disabled={
                      commonIndex < 0 || commonIndex === commonPlaces.length - 1
                    }
                    onClick={() => shiftCommonPlace(menuPath, 1)}
                  >
                    下移
                  </button>
                  <button
                    onClick={() =>
                      editCommonPlaces((places) =>
                        places.filter((place) => place.path !== menuPath),
                      )
                    }
                  >
                    从常用位置移除
                  </button>
                  <hr />
                </>
              )}
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
              {!menu.entry && (
                <>
                  <MenuAction
                    shortcut={isMac ? "⇧⌘N" : "Ctrl+Shift+N"}
                    onClick={() => promptCreate("folder", currentPath)}
                  >
                    {createOptions.folder.title}
                  </MenuAction>
                  <MenuAction onClick={() => promptCreate("text", currentPath)}>
                    {createOptions.text.title}
                  </MenuAction>
                  <MenuAction
                    shortcut={`${commandKey}V`}
                    onClick={() => paste()}
                  >
                    粘贴
                  </MenuAction>
                  <hr />
                </>
              )}
              {menu.entry && !menu.shortcut && (
                <>
                  <hr />
                  <MenuAction
                    shortcut={`${commandKey}C`}
                    onClick={() => {
                      copy();
                      setMenu(null);
                    }}
                  >
                    复制
                  </MenuAction>
                  <MenuAction
                    shortcut={`${commandKey}X`}
                    onClick={() => {
                      copy(true);
                      setMenu(null);
                    }}
                  >
                    剪切
                  </MenuAction>
                  {desktop && split && (
                    <>
                      <MenuAction
                        disabled={!otherFolder}
                        shortcut={isMac ? "⇧⌘C" : "Ctrl+Shift+C"}
                        onClick={() => start("copy", selected, otherFolder)}
                      >
                        复制到另一栏
                      </MenuAction>
                      <MenuAction
                        disabled={!otherFolder}
                        shortcut={isMac ? "⇧⌘M" : "Ctrl+Shift+M"}
                        onClick={() => start("move", selected, otherFolder)}
                      >
                        移动到另一栏
                      </MenuAction>
                    </>
                  )}
                  <MenuAction
                    shortcut={isMac ? "↩" : "F2"}
                    onClick={() => renameSelected(menu.entry)}
                  >
                    重命名
                  </MenuAction>
                  {desktop &&
                    selected.length > 1 &&
                    selected.includes(menu.entry.path) && (
                      <MenuAction onClick={openBatchRename}>
                        批量重命名
                      </MenuAction>
                    )}
                  <hr />
                </>
              )}
              {menu.entry?.isDir && (
                <>
                  <button onClick={() => newTab(menu.entry!.path)}>
                    在新标签打开
                  </button>
                  <button
                    onClick={() =>
                      windowFor(
                        makeTab(menu.entry!.path, preferences.defaultView),
                      )
                    }
                  >
                    在新窗口打开
                  </button>
                  <button onClick={() => favorite(menu.entry!.path)}>
                    {favorites.includes(menu.entry.path)
                      ? "移除收藏"
                      : "添加到收藏"}
                  </button>
                  {commonIndex < 0 && (
                    <button
                      onClick={() => addCommonPlace(menuPath, menu.entry!.name)}
                    >
                      添加到常用位置
                    </button>
                  )}
                </>
              )}
              {menu.entry && !menu.entry.isDir && (
                <>
                  <button onClick={() => chooseOpenWith(menu.entry!)}>
                    打开方式
                  </button>
                  <MenuAction
                    shortcut="Space"
                    onClick={() => {
                      setPreview(menu.entry!);
                      setMenu(null);
                    }}
                  >
                    快速预览
                  </MenuAction>
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
                  <MenuAction
                    shortcut={isMac ? "⌘I" : "Alt+Enter"}
                    onClick={() => openProperties(menu.entry!)}
                  >
                    属性
                  </MenuAction>
                  {!menu.shortcut && !menu.entry.isLink && (
                    <button
                      onClick={() =>
                        start(
                          "zip",
                          selected.includes(menuPath) ? selected : [menuPath],
                        )
                      }
                    >
                      压缩为 ZIP
                    </button>
                  )}
                  {!menu.entry.isDir &&
                    !menu.entry.isLink &&
                    /\.zip$/i.test(menu.entry.name) && (
                      <>
                        {desktop && (
                          <button
                            onClick={() => {
                              setArchive({
                                entry: menu.entry!,
                                parent: menuPath.slice(
                                  0,
                                  Math.max(
                                    menuPath.lastIndexOf("/"),
                                    menuPath.lastIndexOf("\\"),
                                  ) + 1,
                                ),
                              });
                              setMenu(null);
                            }}
                          >
                            浏览压缩包
                          </button>
                        )}
                        <button onClick={() => start("unzip", [menuPath])}>
                          解压到同名文件夹
                        </button>
                      </>
                    )}
                  {menu.entry.isDir && (
                    <>
                      <button onClick={() => openSearch(menuPath)}>
                        在此文件夹内搜索
                      </button>
                      <button
                        onClick={() => {
                          openStoragePage("analysis", menuPath);
                        }}
                      >
                        分析此目录
                      </button>
                    </>
                  )}
                  {!menu.shortcut && (
                    <>
                      <hr />
                      <MenuAction
                        shortcut={isMac ? "⌘⌫" : "Delete"}
                        className="danger-text"
                        onClick={() => start("trash")}
                      >
                        移到回收站
                      </MenuAction>
                    </>
                  )}
                </>
              ) : (
                <>
                  <button onClick={() => openSearch(menuPath)}>
                    在此文件夹内搜索
                  </button>
                  <button onClick={() => openStoragePage("analysis", menuPath)}>
                    分析此目录
                  </button>
                  <button onClick={() => favorite()}>收藏当前目录</button>
                  {commonIndex < 0 && listing && (
                    <button onClick={() => addCommonPlace(currentPath)}>
                      添加当前目录到常用位置
                    </button>
                  )}
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
        <TaskPanel
          tasks={tasks}
          onClose={() => setTaskPanel(false)}
          onBrowse={(path) => {
            setTaskPanel(false);
            go(path, focused);
          }}
          onAction={runMenuAction}
          onSubmitted={(id) => {
            submittedTasks.current.add(id);
            void refreshActivity();
          }}
        />
      )}
      {commandPalette && (
        <CommandPalette
          commands={fileCommands}
          onClose={() => setCommandPalette(false)}
        />
      )}
      {layoutsOpen && (
        <WorkLayouts
          session={session}
          onRestore={(next) => {
            setSession(next);
            setStoragePage("");
            setSearchScope(null);
            setSettingsSection(null);
          }}
          onClose={() => setLayoutsOpen(false)}
        />
      )}
      {fileOperation && (
        <FileOperationDialog
          key={`${fileOperation.kind}:${fileOperation.entries[0]?.path ?? fileOperation.sources?.[0]}`}
          operation={fileOperation}
          locations={[
            ...new Set(
              [
                otherFolder,
                listing?.path,
                ...commonPlaces.map((place) => place.path),
                ...favorites,
                ...recentDirectories,
              ].filter((path): path is string => Boolean(path)),
            ),
          ]}
          onClose={() => setFileOperation(null)}
          onSubmitted={(id) => {
            submittedResultTask(id);
            setCutPaths([]);
          }}
          onRenamed={() => {
            void refreshActivity();
            refresh();
          }}
        />
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
      {batchEntries && (
        <BatchRename
          entries={batchEntries}
          duplicateGuard={batchDuplicateGuard}
          onClose={() => {
            setBatchEntries(null);
            setBatchDuplicateGuard(undefined);
          }}
          onStarted={(id) => {
            submittedTasks.current.add(id);
            setBatchEntries(null);
            setBatchDuplicateGuard(undefined);
            void refreshActivity();
          }}
        />
      )}
      {compareOpen && left.listing && right.listing && (
        <ComparePanel
          left={left.listing.path}
          right={right.listing.path}
          onClose={() => setCompareOpen(false)}
          onCopy={(sources, destination, within) =>
            start("copy", sources, destination, within)
          }
        />
      )}
      {archive && (
        <ArchivePanel
          entry={archive.entry}
          parent={archive.parent}
          onClose={() => setArchive(null)}
          onExtract={(destination) =>
            start("unzip", [archive.entry.path], destination)
          }
        />
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
            role="dialog"
            aria-modal="true"
            aria-label={`预览 ${preview.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-title">
              <h3>{preview.name}</h3>
              <Tool label="关闭预览" onClick={() => setPreview(null)}>
                <X size={19} />
              </Tool>
            </div>
            <div className="preview-body">
              {previewPdf ? (
                <Suspense fallback={<p role="status">正在打开 PDF…</p>}>
                  <PdfPreview
                    key={preview.path}
                    path={preview.path}
                    name={preview.name}
                  />
                </Suspense>
              ) : imageUrl ? (
                <img src={imageUrl} alt={preview.name} />
              ) : (
                <TextPreview
                  key={preview.path}
                  name={preview.name}
                  text={previewContent}
                  error={previewError}
                />
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
      {newEntry && createOption && (
        <div className="overlay">
          <form
            className="modal form-modal"
            role="dialog"
            aria-modal="true"
            aria-label={createOption.title}
            onSubmit={(e) => {
              e.preventDefault();
              void submitCreate();
            }}
          >
            <h3>{createOption.title}</h3>
            <p>创建于 {basename(newEntry.parent)}</p>
            <input
              aria-label={createOption.label}
              autoFocus
              readOnly={creating}
              value={editName}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                setEditName(e.target.value);
                setCreateError("");
              }}
            />
            {createError && <p role="alert">{createError}</p>}
            <div className="modal-buttons">
              <button
                type="button"
                disabled={creating}
                onClick={() => setNewEntry(null)}
              >
                取消
              </button>
              <button className="primary" type="submit" disabled={creating}>
                创建
              </button>
            </div>
          </form>
        </div>
      )}
      {conflict?.conflict && (
        <div className="overlay">
          <section
            className="modal form-modal conflict-modal"
            role="dialog"
            aria-modal="true"
            aria-label="目标位置已有同名项目"
          >
            <h3>目标位置已有同名项目</h3>
            <div className="conflict-comparison">
              {(
                [
                  ["源项目", conflict.conflict.source],
                  ["目标项目", conflict.conflict.destination],
                ] as const
              ).map(([label, item]) => (
                <section
                  className="conflict-item"
                  key={label}
                  aria-label={label}
                >
                  <h4>{label}</h4>
                  {item ? (
                    <>
                      <strong>{basename(item.path)}</strong>
                      <p className="wrap conflict-path" title={item.path}>
                        {item.path}
                      </p>
                      <dl>
                        <dt>大小</dt>
                        <dd
                          title={
                            item.size === null
                              ? undefined
                              : `${item.size.toLocaleString("zh-CN")} 字节`
                          }
                        >
                          {item.size === null
                            ? item.isDir
                              ? "—（文件夹）"
                              : "—"
                            : formatSize(item.size)}
                        </dd>
                        <dt>修改时间</dt>
                        <dd>
                          {item.modified === null
                            ? "—"
                            : new Date(item.modified * 1000).toLocaleString(
                                "zh-CN",
                              )}
                        </dd>
                      </dl>
                    </>
                  ) : (
                    <p>已选择 {conflict.sources.length} 个项目</p>
                  )}
                </section>
              ))}
            </div>
            <p>替换成功后，旧目标会移到回收站。</p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={applyAll}
                onChange={(e) =>
                  setApplyAllTask(e.target.checked ? conflict.id : null)
                }
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
                    call("task_action", {
                      id: conflict.id,
                      conflictId: conflict.conflict?.id,
                      decision,
                      applyAll,
                    })
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
                  setNotice("正在取消任务，完成后可关闭窗口。");
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
