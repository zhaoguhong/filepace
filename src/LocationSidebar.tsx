import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  MoreHorizontal,
  Folder,
  Home,
  Monitor,
  Download,
  FileText,
  Image,
  FolderPlus,
  Pencil,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  FolderInput,
  Minus,
  Check,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { call, desktop } from "./bridge";
import { basename } from "./model";
import {
  pathKey,
  uniquePlaces,
  type SidebarLocations,
} from "./sidebarLocations";
import "./locationSidebar.css";
import "./sidebarDialogs.css";
import {
  locationDropAt,
  sameLocationDrop,
  scrollLocations,
  type LocationDrop,
} from "./locationDrop";

const icons = {
  个人目录: Home,
  桌面: Monitor,
  下载: Download,
  文档: FileText,
  图片: Image,
};
type Drag = { group: string; path?: string };
export default function LocationSidebar({
  locations,
  currentPath,
  onBrowse,
  onError,
  externalDrop,
}: {
  locations: SidebarLocations;
  currentPath: string;
  onBrowse: (path: string) => void;
  onError: (error: string) => void;
  externalDrop: LocationDrop | null;
}) {
  const { groups, change, add } = locations;
  const fieldId = useId();
  const [menu, setMenu] = useState<{
    group: string;
    path?: string;
    point?: { x: number; y: number };
  } | null>(null);
  const [choosingGroup, setChoosingGroup] = useState(false);
  const moveGroupButton = useRef<HTMLButtonElement>(null);
  const [form, setForm] = useState<{
    kind: "create" | "rename" | "add" | "delete";
    group?: string;
    value: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const drag = useRef<Drag | null>(null);
  const pointer = useRef<{
    group: string;
    path: string;
    id: number;
    row: HTMLButtonElement;
    x: number;
    y: number;
    originX: number;
    originY: number;
    started: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [localDrop, setLocalDrop] = useState<LocationDrop | null>(null);
  const [moving, setMoving] = useState<{
    group: string;
    path: string;
    x: number;
    y: number;
  } | null>(null);
  const latest = useRef(locations);
  latest.current = locations;
  const dropHint = localDrop ?? externalDrop;
  const menuElement = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const group = groups.find((item) => item.id === menu?.group);
  const place = group?.places.find((item) => item.path === menu?.path);
  const groupIndex = groups.findIndex((item) => item.id === menu?.group);
  const placeIndex =
    group?.places.findIndex((item) => item.path === menu?.path) ?? -1;
  useEffect(() => {
    let animation = 0;
    let lastFrame = 0;
    function hint() {
      const active = pointer.current;
      const target = active ? locationDropAt(active) : null;
      setLocalDrop((previous) =>
        sameLocationDrop(previous, target) ? previous : target,
      );
    }
    function frame(now: number) {
      animation = 0;
      const active = pointer.current;
      if (!active?.started) return;
      const elapsed = lastFrame ? Math.min(32, now - lastFrame) : 16;
      if (scrollLocations(active, elapsed)) {
        hint();
        lastFrame = now;
        animation = requestAnimationFrame(frame);
      } else lastFrame = 0;
    }
    function clear() {
      const active = pointer.current;
      pointer.current = null;
      cancelAnimationFrame(animation);
      animation = 0;
      lastFrame = 0;
      if (active?.row.hasPointerCapture(active.id))
        active.row.releasePointerCapture(active.id);
      setLocalDrop(null);
      setMoving(null);
    }
    function move(event: PointerEvent) {
      const active = pointer.current;
      if (!active || active.id !== event.pointerId) return;
      active.x = event.clientX;
      active.y = event.clientY;
      if (
        !active.started &&
        Math.hypot(active.x - active.originX, active.y - active.originY) < 5
      )
        return;
      active.started = true;
      suppressClick.current = true;
      event.preventDefault();
      setMoving({
        group: active.group,
        path: active.path,
        x: active.x,
        y: active.y,
      });
      hint();
      if (!animation) animation = requestAnimationFrame(frame);
    }
    function end(event: PointerEvent) {
      const active = pointer.current;
      if (!active || active.id !== event.pointerId) return;
      const target = active.started
        ? locationDropAt({ x: event.clientX, y: event.clientY })
        : null;
      const place = latest.current.groups
        .find((group) => group.id === active.group)
        ?.places.find((place) => place.path === active.path);
      clear();
      if (target && place)
        latest.current.insert([place], target, {
          group: active.group,
          path: active.path,
        });
    }
    function cancel(event: PointerEvent) {
      if (pointer.current?.id === event.pointerId) clear();
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape" && pointer.current?.started) {
        event.preventDefault();
        event.stopPropagation();
        clear();
      }
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", key, true);
    return () => {
      clear();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", key, true);
    };
  }, []);
  useLayoutEffect(() => {
    if (!menu || !menuElement.current) return;
    const element = menuElement.current;
    const activeMenu = menu;
    function position() {
      const anchor = menuTrigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const x =
        activeMenu.point?.x ??
        (activeMenu.path ? anchor.right : anchor.right - element.offsetWidth);
      const y = activeMenu.point?.y ?? anchor.bottom + 6;
      element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - element.offsetWidth - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - element.offsetHeight - 8))}px`;
    }
    position();
    const focusTarget =
      (menu.path && !choosingGroup ? moveGroupButton.current : null) ??
      element.querySelector<HTMLButtonElement>("button:not(:disabled)");
    focusTarget?.focus({ preventScroll: true });
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [menu, choosingGroup]);
  function closeMenu() {
    setMenu(null);
    menuTrigger.current?.focus({ preventScroll: true });
  }
  function prompt(
    kind: NonNullable<typeof form>["kind"],
    group?: string,
    value = "",
  ) {
    setMenu(null);
    setError("");
    setForm({ kind, group, value });
  }
  function shift(delta: number) {
    if (!menu) return;
    change((groups) => {
      if (!menu.path) {
        const next = [...groups];
        const index = next.findIndex((group) => group.id === menu.group);
        if (index + delta >= 0 && index + delta < next.length)
          [next[index], next[index + delta]] = [
            next[index + delta],
            next[index],
          ];
        return next;
      }
      return groups.map((group) => {
        if (group.id !== menu.group) return group;
        const places = [...group.places];
        const index = places.findIndex((place) => place.path === menu.path);
        if (index + delta >= 0 && index + delta < places.length)
          [places[index], places[index + delta]] = [
            places[index + delta],
            places[index],
          ];
        return { ...group, places };
      });
    });
    closeMenu();
  }
  function drop(target: Drag) {
    const source = drag.current;
    drag.current = null;
    if (!source) return;
    change((groups) => {
      if (!source.path) {
        const next = [...groups];
        const index = next.findIndex((group) => group.id === source.group);
        const to = next.findIndex((group) => group.id === target.group);
        if (index < 0 || to < 0) return groups;
        next.splice(to, 0, next.splice(index, 1)[0]);
        return next;
      }
      const place = groups
        .find((group) => group.id === source.group)
        ?.places.find((place) => place.path === source.path);
      if (
        !place ||
        (source.group === target.group && source.path === target.path)
      )
        return groups;
      return groups.map((group) => {
        let places =
          group.id === source.group
            ? group.places.filter((place) => place.path !== source.path)
            : [...group.places];
        if (group.id === target.group) {
          const index = target.path
            ? places.findIndex((place) => place.path === target.path)
            : places.length;
          places.splice(Math.max(0, index), 0, place);
          places = uniquePlaces(places);
        }
        return {
          ...group,
          places,
          collapsed: group.id === target.group ? false : group.collapsed,
        };
      });
    });
  }
  return (
    <>
      {groups.map((group) => (
        <section
          className={`sidebar-group location-group${dropHint?.group === group.id ? ` location-drop-active${dropHint.path ? "" : " location-drop-append"}` : ""}`}
          aria-label={group.name}
          data-location-group={group.id}
          key={group.id}
          onDragOver={(event) => {
            if (drag.current) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            drop({ group: group.id });
          }}
        >
          <div
            className="section-label sidebar-group-label"
            draggable
            onDragStart={(event) => {
              drag.current = { group: group.id };
              event.dataTransfer.setData(
                "application/x-filepace-location",
                group.id,
              );
            }}
            onDragEnd={() => {
              drag.current = null;
            }}
          >
            <button
              className="sidebar-disclosure"
              aria-expanded={!group.collapsed}
              aria-controls={`locations-${group.id}`}
              onClick={() =>
                change((groups) =>
                  groups.map((item) =>
                    item.id === group.id
                      ? { ...item, collapsed: !item.collapsed }
                      : item,
                  ),
                )
              }
            >
              {group.collapsed ? (
                <ChevronRight size={13} />
              ) : (
                <ChevronDown size={13} />
              )}{" "}
              {group.name}
            </button>
            <button
              title={`管理分组 ${group.name}`}
              aria-label={`管理分组 ${group.name}`}
              aria-haspopup="menu"
              aria-expanded={menu?.group === group.id && !menu.path}
              onClick={(event) => {
                menuTrigger.current = event.currentTarget;
                setChoosingGroup(false);
                setMenu({ group: group.id });
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
          <div id={`locations-${group.id}`} hidden={group.collapsed}>
            {group.places.map((place) => {
              const Icon = icons[place.name as keyof typeof icons] ?? Folder;
              return (
                <button
                  className={`place ${pathKey(currentPath) === pathKey(place.path) ? "selected" : ""}${dropHint?.group === group.id && dropHint.path === place.path ? (dropHint.after ? " location-drop-after" : " location-drop-before") : ""}${moving?.group === group.id && moving.path === place.path ? " location-drag-source" : ""}`}
                  key={place.path}
                  title={place.path}
                  data-location-path={place.path}
                  aria-haspopup="menu"
                  aria-expanded={
                    menu?.group === group.id && menu.path === place.path
                  }
                  onPointerDown={(event) => {
                    if (
                      event.button !== 0 ||
                      !event.isPrimary ||
                      event.pointerType === "touch"
                    )
                      return;
                    suppressClick.current = false;
                    pointer.current = {
                      group: group.id,
                      path: place.path,
                      id: event.pointerId,
                      row: event.currentTarget,
                      x: event.clientX,
                      y: event.clientY,
                      originX: event.clientX,
                      originY: event.clientY,
                      started: false,
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onClick={() => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    onBrowse(place.path);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    menuTrigger.current = event.currentTarget;
                    setChoosingGroup(false);
                    setMenu({
                      group: group.id,
                      path: place.path,
                      point:
                        event.clientX || event.clientY
                          ? { x: event.clientX, y: event.clientY }
                          : undefined,
                    });
                  }}
                >
                  <Icon size={17} />
                  <span>{place.name}</span>
                </button>
              );
            })}
            {!group.places.length && (
              <div className="sidebar-hint">拖入文件夹，添加快捷入口</div>
            )}
          </div>
        </section>
      ))}
      {!groups.length && (
        <div
          className={`location-sidebar-empty${dropHint ? " location-drop-active" : ""}`}
          data-location-group="common"
        >
          <button onClick={() => prompt("create")}>
            <Plus size={14} />
            新建分组
          </button>
        </div>
      )}
      {menu && group && (
        <div
          className="location-menu-backdrop"
          onClick={closeMenu}
          onContextMenu={(event) => {
            event.preventDefault();
            closeMenu();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (choosingGroup && ["Escape", "ArrowLeft"].includes(event.key)) {
              event.preventDefault();
              setChoosingGroup(false);
              return;
            }
            if (["Escape", "Tab"].includes(event.key)) {
              event.preventDefault();
              closeMenu();
            }
            if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const buttons = [
                ...(menuElement.current?.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ) ?? []),
              ];
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (index +
                        (event.key === "ArrowUp" ? -1 : 1) +
                        buttons.length) %
                      buttons.length;
              buttons[next]?.focus();
            }
          }}
        >
          <div
            ref={menuElement}
            className="location-popover"
            role="menu"
            aria-label={
              place
                ? choosingGroup
                  ? "移动到分组"
                  : "管理常用位置"
                : "分组操作"
            }
            onClick={(event) => event.stopPropagation()}
          >
            {place && choosingGroup ? (
              <>
                <button role="menuitem" onClick={() => setChoosingGroup(false)}>
                  <ArrowLeft size={14} />
                  返回
                </button>
                <hr role="separator" />
                <div className="location-popover-title">移动到分组</div>
                {groups.map((item) => (
                  <button
                    role="menuitemradio"
                    aria-checked={item.id === group.id}
                    disabled={item.id === group.id}
                    key={item.id}
                    title={item.name}
                    onClick={() => {
                      drag.current = { group: group.id, path: place.path };
                      drop({ group: item.id });
                      closeMenu();
                    }}
                  >
                    <Folder size={14} />
                    <span>{item.name}</span>
                    {item.id === group.id && (
                      <Check size={14} className="location-menu-trailing" />
                    )}
                  </button>
                ))}
              </>
            ) : place ? (
              <>
                <div className="location-popover-title" title={place.path}>
                  {place.name}
                </div>
                <button
                  role="menuitem"
                  disabled={placeIndex <= 0}
                  onClick={() => shift(-1)}
                >
                  <ArrowUp size={14} />
                  上移
                </button>
                <button
                  role="menuitem"
                  disabled={placeIndex === group.places.length - 1}
                  onClick={() => shift(1)}
                >
                  <ArrowDown size={14} />
                  下移
                </button>
                <hr role="separator" />
                <button
                  ref={moveGroupButton}
                  role="menuitem"
                  onClick={() => setChoosingGroup(true)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight") {
                      event.preventDefault();
                      setChoosingGroup(true);
                    }
                  }}
                >
                  <FolderInput size={14} />
                  移动到分组
                  <ChevronRight size={14} className="location-menu-trailing" />
                </button>
                <hr role="separator" />
                <button
                  role="menuitem"
                  onClick={() => {
                    change((groups) =>
                      groups.map((item) =>
                        item.id === group.id
                          ? {
                              ...item,
                              places: item.places.filter(
                                (item) => item.path !== place.path,
                              ),
                            }
                          : item,
                      ),
                    );
                    closeMenu();
                  }}
                >
                  <Minus size={14} />
                  从常用位置移除
                </button>
              </>
            ) : (
              <>
                <div className="location-popover-title">{group.name}</div>
                <button role="menuitem" onClick={() => prompt("create")}>
                  <FolderPlus size={14} />
                  新建分组
                </button>
                <button
                  role="menuitem"
                  onClick={() =>
                    prompt(
                      "add",
                      group.id,
                      currentPath.startsWith("filepace:") ? "" : currentPath,
                    )
                  }
                >
                  <Folder size={14} />
                  添加文件夹…
                </button>
                <hr role="separator" />
                <button
                  role="menuitem"
                  onClick={() => prompt("rename", group.id, group.name)}
                >
                  <Pencil size={14} />
                  重命名分组
                </button>
                <button
                  role="menuitem"
                  disabled={groupIndex <= 0}
                  onClick={() => shift(-1)}
                >
                  <ArrowUp size={14} />
                  上移
                </button>
                <button
                  role="menuitem"
                  disabled={groupIndex < 0 || groupIndex === groups.length - 1}
                  onClick={() => shift(1)}
                >
                  <ArrowDown size={14} />
                  下移
                </button>
                <button
                  role="menuitem"
                  className="danger-text"
                  onClick={() => prompt("delete", group.id)}
                >
                  <Trash2 size={14} />
                  移除分组
                </button>
                <hr role="separator" />
                <button
                  role="menuitem"
                  onClick={() => {
                    locations.restoreDefaults();
                    closeMenu();
                  }}
                >
                  <RotateCcw size={14} />
                  恢复默认位置
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {form && (
        <div
          className="overlay sidebar-dialog-overlay"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape" && !busy) setForm(null);
          }}
        >
          <form
            className="modal form-modal sidebar-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={
              {
                create: "新建分组",
                rename: "重命名分组",
                add: "添加常用位置",
                delete: "移除分组",
              }[form.kind]
            }
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError("");
              try {
                if (form.kind === "delete")
                  change((groups) =>
                    groups.filter((group) => group.id !== form.group),
                  );
                else if (form.kind === "add") {
                  if (!form.value.trim()) throw new Error("请选择文件夹");
                  const path = desktop
                    ? await call<string>("validate_location", {
                        path: form.value.trim(),
                      })
                    : form.value.trim();
                  add({ path, name: basename(path) }, form.group);
                } else {
                  const name = form.value.trim();
                  if (!name) throw new Error("请输入分组名称");
                  if (name.length > 40) throw new Error("分组名称最多 40 个字");
                  change((groups) =>
                    form.kind === "create"
                      ? [
                          ...groups,
                          {
                            id: crypto.randomUUID(),
                            name,
                            collapsed: false,
                            places: [],
                          },
                        ]
                      : groups.map((group) =>
                          group.id === form.group ? { ...group, name } : group,
                        ),
                  );
                }
                setForm(null);
              } catch (error) {
                setError(String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            <h3>
              <span
                className={`sidebar-dialog-icon${form.kind === "delete" ? " is-danger" : ""}`}
                aria-hidden="true"
              >
                {form.kind === "delete" ? (
                  <Minus size={18} />
                ) : form.kind === "rename" ? (
                  <Pencil size={18} />
                ) : (
                  <FolderPlus size={18} />
                )}
              </span>
              {
                {
                  create: "新建分组",
                  rename: "重命名分组",
                  add: "添加常用位置",
                  delete: "移除分组",
                }[form.kind]
              }
            </h3>
            {form.kind === "add" && (
              <p className="sidebar-dialog-description">
                添加到「
                {groups.find((group) => group.id === form.group)?.name ??
                  "常用位置"}
                」，方便从侧栏快速打开。
              </p>
            )}
            {form.kind === "delete" ? (
              <p className="sidebar-dialog-description">
                将移除「{groups.find((group) => group.id === form.group)?.name}
                」及其中的侧栏快捷入口，磁盘上的文件和文件夹不会删除。
              </p>
            ) : (
              <div className="sidebar-dialog-field">
                <label htmlFor={fieldId}>
                  {form.kind === "add" ? "文件夹路径" : "分组名称"}
                </label>
                <div className="sidebar-dialog-input-row">
                  <input
                    id={fieldId}
                    autoFocus
                    disabled={busy}
                    aria-label={form.kind === "add" ? "文件夹路径" : "分组名称"}
                    placeholder={
                      form.kind === "add"
                        ? "输入或选择文件夹路径"
                        : "例如：工作、个人、归档"
                    }
                    value={form.value}
                    title={form.kind === "add" ? form.value : undefined}
                    maxLength={form.kind === "add" ? undefined : 40}
                    onChange={(event) => {
                      setForm({ ...form, value: event.target.value });
                      setError("");
                    }}
                  />
                  {form.kind === "add" && desktop && (
                    <button
                      className="sidebar-dialog-browse"
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        try {
                          const path = await call<string | null>(
                            "choose_location",
                          );
                          if (path) {
                            setForm({ ...form, value: path });
                            setError("");
                          }
                        } catch (error) {
                          setError(String(error));
                          onError(String(error));
                        }
                      }}
                    >
                      <Folder size={14} />
                      选择文件夹…
                    </button>
                  )}
                </div>
              </div>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                autoFocus={form.kind === "delete"}
                disabled={busy}
                onClick={() => setForm(null)}
              >
                取消
              </button>
              <button
                className={
                  form.kind === "delete" ? "sidebar-dialog-danger" : "primary"
                }
                disabled={busy}
                type="submit"
              >
                {form.kind === "delete" ? "移除分组" : "保存"}
              </button>
            </div>
          </form>
        </div>
      )}
      {moving && (
        <div
          className="location-drag-preview"
          style={{
            transform: `translate3d(${moving.x + 14}px, ${moving.y + 14}px, 0)`,
          }}
          aria-hidden="true"
        >
          <Folder size={15} />
          <span>
            {
              groups
                .find((group) => group.id === moving.group)
                ?.places.find((place) => place.path === moving.path)?.name
            }
          </span>
        </div>
      )}
    </>
  );
}
