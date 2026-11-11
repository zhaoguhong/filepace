import { ArrowDownToLine, X } from "lucide-react";
import { call, desktop } from "./bridge";
import { basename, formatSize, type Task } from "./model";

export const activeTask = (task: { status: string }) =>
  ["queued", "running", "conflict"].includes(task.status);

export default function TaskPanel({
  tasks,
  onClose,
  onBrowse,
  onAction,
  onSubmitted,
}: {
  tasks: Task[];
  onClose: () => void;
  onBrowse: (path: string) => void;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
  onSubmitted: (id: string) => void;
}) {
  return (
    <section className="task-panel" aria-label="文件任务">
      <div className="panel-title">
        <h3>
          文件任务 <small>{tasks.length}</small>
        </h3>
        {desktop && tasks.some((task) => !activeTask(task)) && (
          <button
            onClick={() => void onAction(() => call("clear_task_history"))}
          >
            清理已结束任务
          </button>
        )}
        <button
          title="关闭任务面板"
          aria-label="关闭任务面板"
          onClick={onClose}
        >
          <X size={17} />
        </button>
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
                      zip: "压缩",
                      unzip: "解压",
                      undo: "撤销",
                      rename: "批量重命名",
                    } as Record<string, string>
                  )[t.kind]
                }
              </b>
              <span>
                {
                  (
                    {
                      queued: "排队中",
                      running: "进行中",
                      conflict: "等待处理",
                      done: "已完成",
                      error: t.kind === "undo" ? "未能撤销" : "部分失败",
                      cancelled: "已取消",
                    } as Record<string, string>
                  )[t.status]
                }
              </span>
              {activeTask(t) && (
                <button
                  onClick={() =>
                    void onAction(() =>
                      call("task_action", {
                        id: t.id,
                        decision: "cancel",
                        applyAll: false,
                      }),
                    )
                  }
                >
                  取消
                </button>
              )}
            </div>
            <p title={t.current}>{basename(t.current)}</p>
            <small>
              已完成 {t.completed} 项 · {formatSize(t.bytes)}
              {Boolean(t.skipped) && ` · 跳过 ${t.skipped} 项`}
              {t.status === "running" && t.phase && ` · ${t.phase}`}
            </small>
            {t.status === "running" && (
              <div className="progress">
                <i />
              </div>
            )}
            {t.errors.length > 0 && (
              <details open={t.kind === "undo" || undefined}>
                <summary>{t.errors.length} 个问题</summary>
                {t.errors.map((e, i) => (
                  <p className="task-error" key={i}>
                    {e}
                  </p>
                ))}
              </details>
            )}
            {!activeTask(t) &&
              (t.destination || Boolean(t.failedSources?.length)) && (
                <div className="task-controls">
                  {t.destination && (
                    <button
                      onClick={() => {
                        onBrowse(t.destination);
                      }}
                    >
                      打开目标位置
                    </button>
                  )}
                  {!!t.failedSources?.length && t.status === "error" && (
                    <button
                      onClick={() =>
                        void onAction(async () => {
                          const id = await call<string>("retry_task", {
                            id: t.id,
                          });
                          onSubmitted(id);
                        })
                      }
                    >
                      重试失败项目
                    </button>
                  )}
                </div>
              )}
          </div>
        ))
      )}
    </section>
  );
}
