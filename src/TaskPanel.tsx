import {
  ArrowDownToLine,
  ArrowUp,
  ArrowDown,
  Pause,
  Play,
  X,
} from "lucide-react";
import { call, desktop } from "./bridge";
import { basename, formatSize, type Task } from "./model";
import { formatRemaining, taskProgress } from "./taskProgress";
import { activeTask, orderedTasks } from "./taskQueue";
import "./tasks.css";

export { activeTask } from "./taskQueue";

function Progress({ task }: { task: Task }) {
  const progress = taskProgress(task);
  const transferring = ["copy", "move", "zip", "unzip"].includes(task.kind);
  return (
    <>
      <small className="task-progress-label">
        已完成 {task.completed} 项
        {Boolean(task.skipped) && ` · 跳过 ${task.skipped} 项`}
        {task.status === "running" && task.phase && ` · ${task.phase}`}
      </small>
      {transferring && (
        <small className="task-measurement">
          {task.kind === "move" &&
          task.status === "done" &&
          task.bytes === 0 &&
          task.phase === "直接移动项目" ? (
            <>已直接移动，无需复制文件内容</>
          ) : progress.total !== null ? (
            <>
              {progress.overall ? "已传输" : "当前文件"}{" "}
              {formatSize(progress.done)} / {formatSize(progress.total)}
              {progress.fraction !== null &&
                ` · ${Math.floor(progress.fraction * 100)}%`}
              {!progress.overall && ` · 累计传输 ${formatSize(task.bytes)}`}
            </>
          ) : (
            <>
              已传输 {formatSize(task.bytes)}
              {activeTask(task) && " · 总量未知"}
            </>
          )}
          {progress.rate !== null && ` · 平均 ${formatSize(progress.rate)}/秒`}
          {progress.remaining !== null &&
            ` · ${progress.overall ? "传输" : "当前文件"}约剩 ${formatRemaining(progress.remaining)}`}
        </small>
      )}
      {["running", "pausing", "paused", "resuming"].includes(task.status) && (
        <div
          className={`progress${progress.fraction !== null ? " determinate" : ""}${["paused", "resuming"].includes(task.status) ? " paused" : ""}`}
          role="progressbar"
          aria-label={progress.overall ? "文件传输进度" : "当前文件进度"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={
            progress.fraction === null
              ? undefined
              : Math.floor(progress.fraction * 100)
          }
          aria-valuetext={
            task.phase === "正在统计总量" ? "正在统计，总量未知" : undefined
          }
        >
          <i
            style={
              progress.fraction === null
                ? undefined
                : { width: `${progress.fraction * 100}%` }
            }
          />
        </div>
      )}
    </>
  );
}

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
  const ordered = orderedTasks(tasks);
  const pending = ordered.filter((task) => task.queuePosition != null);
  const control = (id: string, decision: string) =>
    void onAction(() => call("task_action", { id, decision, applyAll: false }));
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
        ordered.map((t) => (
          <div className="task" key={t.id} data-task-id={t.id}>
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
                      pausing: "正在暂停",
                      paused: "已暂停",
                      resuming: "等待继续",
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
            {desktop && activeTask(t) && (
              <div className="task-controls task-queue-controls">
                {t.status === "paused" ||
                t.status === "pausing" ||
                t.pauseRequested ? (
                  <button onClick={() => control(t.id, "resume")}>
                    <Play size={13} /> 继续
                  </button>
                ) : (
                  t.canPause !== false &&
                  ["queued", "running"].includes(t.status) && (
                    <button onClick={() => control(t.id, "pause")}>
                      <Pause size={13} /> 暂停
                    </button>
                  )
                )}
                {t.queuePosition != null && pending.length > 1 && (
                  <>
                    <button
                      aria-label="任务上移"
                      title="在等待队列中上移"
                      disabled={pending[0]?.id === t.id}
                      onClick={() =>
                        void onAction(() =>
                          call("reorder_task", { id: t.id, direction: "up" }),
                        )
                      }
                    >
                      <ArrowUp size={13} /> 上移
                    </button>
                    <button
                      aria-label="任务下移"
                      title="在等待队列中下移"
                      disabled={pending.at(-1)?.id === t.id}
                      onClick={() =>
                        void onAction(() =>
                          call("reorder_task", { id: t.id, direction: "down" }),
                        )
                      }
                    >
                      <ArrowDown size={13} /> 下移
                    </button>
                  </>
                )}
                {t.queuePosition != null && (
                  <small>等待顺序 {t.queuePosition + 1}</small>
                )}
              </div>
            )}
            {t.status === "pausing" && (
              <p className="task-control-note">完成当前安全步骤后暂停。</p>
            )}
            <dl className="task-paths">
              {t.sources.length > 0 && (
                <>
                  <dt>来源</dt>
                  <dd>
                    {t.sources.length === 1 ? (
                      t.sources[0]
                    ) : (
                      <details>
                        <summary>
                          {t.sources.length} 个项目 · {basename(t.sources[0])}
                        </summary>
                        {t.sources.map((path) => (
                          <p key={path}>{path}</p>
                        ))}
                      </details>
                    )}
                  </dd>
                </>
              )}
              {t.destination && (
                <>
                  <dt>目标</dt>
                  <dd>{t.destination}</dd>
                </>
              )}
            </dl>
            {t.current && <p title={t.current}>{basename(t.current)}</p>}
            <Progress task={t} />
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
