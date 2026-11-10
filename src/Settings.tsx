import { useState } from "react";
import {
  ArrowLeft,
  Download,
  LayoutList,
  Palette,
  RefreshCw,
  Settings as SettingsIcon,
} from "lucide-react";
import { desktop } from "./bridge";
import { viewLabels, type View } from "./model";
import { modeLabels, themeLabels, type Preferences } from "./preferences";
import type { UpdateStatus } from "./updates";
import "./settings.css";

export type SettingsSection = "browse" | "appearance" | "update";
const sections = [
  { id: "browse", label: "浏览", icon: LayoutList },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "update", label: "更新", icon: Download },
] as const;

export default function Settings({
  section,
  onSection,
  preferences,
  change,
  status,
  busy,
  check,
  install,
  onClose,
}: {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  preferences: Preferences;
  change: (value: Partial<Preferences>) => void;
  status: UpdateStatus;
  busy: boolean;
  check: () => Promise<unknown>;
  install: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const processing = ["checking", "downloading", "installing"].includes(
    status.phase,
  );
  async function update(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (error) {
      setError(String(error));
    }
  }
  return (
    <section className="settings-page" aria-label="设置">
      <header className="settings-heading">
        <span className="settings-mark">
          <SettingsIcon size={22} />
        </span>
        <div>
          <h1>设置</h1>
          <p>浏览、外观与应用更新</p>
        </div>
        <button className="storage-secondary" onClick={onClose}>
          <ArrowLeft size={15} /> 返回文件
        </button>
      </header>
      <div className="settings-layout">
        <nav aria-label="设置分类">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-pressed={section === id}
              onClick={() => onSection(id)}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
        </nav>
        <div className="settings-card">
          {section === "browse" && (
            <>
              <h2>浏览</h2>
              <label className="setting-row">
                <span>
                  <b>默认视图</b>
                  <small>新标签和新窗口打开时使用。</small>
                </span>
                <select
                  aria-label="默认视图"
                  value={preferences.defaultView}
                  onChange={(event) =>
                    change({ defaultView: event.target.value as View })
                  }
                >
                  {Object.entries(viewLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {section === "appearance" && (
            <>
              <h2>外观</h2>
              <label className="setting-row">
                <span>
                  <b>显示模式</b>
                  <small>选择界面的明暗。</small>
                </span>
                <select
                  aria-label="显示模式"
                  value={preferences.mode}
                  onChange={(event) =>
                    change({ mode: event.target.value as Preferences["mode"] })
                  }
                >
                  {Object.entries(modeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setting-row">
                <span>
                  <b>主题</b>
                  <small>选择一套界面配色。</small>
                </span>
                <select
                  aria-label="主题"
                  value={preferences.theme}
                  onChange={(event) =>
                    change({
                      theme: event.target.value as Preferences["theme"],
                    })
                  }
                >
                  {Object.entries(themeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {section === "update" && (
            <>
              <h2>更新</h2>
              <label className="setting-row">
                <span>
                  <b>自动更新</b>
                  <small>在后台检查并下载正式版，安装前提示重启。</small>
                </span>
                <input
                  type="checkbox"
                  aria-label="自动更新"
                  checked={preferences.autoUpdate}
                  onChange={(event) =>
                    change({ autoUpdate: event.target.checked })
                  }
                />
              </label>
              <div className="setting-row">
                <span>
                  <b>当前版本</b>
                  <small>v{status.current}</small>
                </span>
                {status.phase === "ready" ? (
                  <button
                    className="storage-primary"
                    disabled={busy}
                    onClick={() => void update(install)}
                  >
                    重启更新
                  </button>
                ) : (
                  <button
                    className="storage-secondary"
                    disabled={!desktop || processing}
                    onClick={() => void update(check)}
                  >
                    <RefreshCw size={14} /> 检查更新
                  </button>
                )}
              </div>
              <p className="setting-note" role="status">
                {error ||
                  (desktop
                    ? {
                        idle: "更新来自 Filepace 的 GitHub 正式发布。",
                        checking: "正在检查更新…",
                        downloading: `正在下载 v${status.version}…`,
                        current: "已是最新版本。",
                        ready: busy
                          ? "文件任务结束后可以安装更新。"
                          : `v${status.version} 已下载并通过签名校验。`,
                        installing: "正在安装更新…",
                        error:
                          status.message ?? "暂时无法检查更新，请稍后重试。",
                      }[status.phase]
                    : "在桌面应用中检查和安装更新。")}
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
