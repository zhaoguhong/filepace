import {
  AlertCircle,
  ArrowUpCircle,
  ChevronRight,
  LoaderCircle,
} from "lucide-react";
import type { UpdateStatus } from "./updates";
import "./updateNotice.css";

export default function UpdateNotice({
  status,
  onClick,
  compact = false,
}: {
  status: UpdateStatus;
  onClick: () => void;
  compact?: boolean;
}) {
  const version = status.version ? ` v${status.version}` : "";
  let title: string;
  let detail: string;
  switch (status.phase) {
    case "downloading":
      title = `发现新版本${version}`;
      detail = "正在后台下载…";
      break;
    case "ready":
      title = `可重启更新${version}`;
      detail = status.message ? "安装未完成，点击查看并重试" : "点击查看并安装";
      break;
    case "installing":
      title = `正在安装更新${version}`;
      detail = "完成后将重新打开应用";
      break;
    case "error":
      title = status.version ? `新版本下载失败${version}` : "检查更新失败";
      detail = "点击查看并重试";
      break;
    default:
      return null;
  }
  const processing =
    status.phase === "downloading" || status.phase === "installing";
  const Icon = processing
    ? LoaderCircle
    : status.phase === "error"
      ? AlertCircle
      : ArrowUpCircle;
  return (
    <button
      className={`update-notice${compact ? " update-notice-compact" : ""}`}
      data-phase={status.phase}
      onClick={onClick}
      aria-label={title}
      title={status.message || `${title} · ${detail}`}
    >
      <Icon
        size={18}
        className={processing ? "spin" : undefined}
        aria-hidden="true"
      />
      <span
        className="update-notice-text"
        aria-live="polite"
        aria-atomic="true"
      >
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  );
}
