import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  LoaderCircle,
  Sparkles,
  X,
} from "lucide-react";
import type { DiagnosisStatus } from "./StorageDiagnosis";
import { basename } from "./model";
import "./diagnosisActivity.css";

function title(status: DiagnosisStatus) {
  switch (status.phase) {
    case "preparing":
      return "正在收集目录信息";
    case "analyzing":
      return "正在智能诊断";
    case "complete":
      return "诊断已完成";
    case "error":
      return "诊断未完成";
    case "empty":
      return "目录没有可分析的文件";
    case "cancelled":
      return "诊断已停止";
  }
}

export default function DiagnosisActivity({
  status,
  onOpen,
  compact = false,
}: {
  status: DiagnosisStatus | null;
  onOpen: (scope: string) => void;
  compact?: boolean;
}) {
  if (!status || status.phase === "cancelled") return null;
  const running = status.phase === "preparing" || status.phase === "analyzing";
  const Icon = running
    ? LoaderCircle
    : status.phase === "error"
      ? AlertCircle
      : Sparkles;
  return (
    <button
      className={`diagnosis-activity${compact ? " diagnosis-activity-compact" : ""}`}
      onClick={() => onOpen(status.scope)}
      title={`${title(status)} · ${status.scope}`}
      aria-label={`${title(status)}：${basename(status.scope) || status.scope}`}
    >
      <Icon
        size={17}
        className={running ? "spin" : undefined}
        aria-hidden="true"
      />
      <span>
        <strong>{title(status)}</strong>
        <small>{basename(status.scope) || status.scope}</small>
      </span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  );
}

export function DiagnosisCompletion({
  status,
  onOpen,
  onDismiss,
}: {
  status: DiagnosisStatus;
  onOpen: (scope: string) => void;
  onDismiss: () => void;
}) {
  const Icon = status.phase === "error" ? AlertCircle : CheckCircle2;
  return (
    <div className="diagnosis-completion" role="status" aria-live="polite">
      <Icon size={20} aria-hidden="true" />
      <div className="diagnosis-completion-body">
        <strong>{title(status)}</strong>
        <p title={status.scope}>{status.scope}</p>
        {status.phase === "error" && (
          <p>{status.message || "请查看详情后重试。"}</p>
        )}
        <button onClick={() => onOpen(status.scope)}>
          {status.phase === "complete" ? "查看报告" : "查看诊断"}
          <ChevronRight size={14} />
        </button>
      </div>
      <button onClick={onDismiss} aria-label="关闭诊断提示">
        <X size={15} />
      </button>
    </div>
  );
}
