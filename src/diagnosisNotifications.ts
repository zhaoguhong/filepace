import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  onAction,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { desktop } from "./bridge";
import { basename } from "./model";
import type { DiagnosisStatus } from "./StorageDiagnosis";

let permissionRequested = false;

export function useDiagnosisNotifications(onOpen: (scope: string) => void) {
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const listener = useRef<ReturnType<typeof onAction> | null>(null);
  useEffect(() => {
    if (!desktop) return;
    const window = getCurrentWindow();
    let disposed = false;
    const subscription = onAction((event) => {
      const extra = event.notification?.extra;
      if (
        disposed ||
        extra?.filepaceWindow !== window.label ||
        typeof extra.scope !== "string"
      )
        return;
      openRef.current(extra.scope);
      void window
        .show()
        .then(() => window.unminimize())
        .then(() => window.setFocus())
        .catch(() => {});
    });
    listener.current = subscription;
    void subscription.catch(() => {});
    return () => {
      disposed = true;
      if (listener.current === subscription) listener.current = null;
      void subscription.then((value) => value.unregister()).catch(() => {});
    };
  }, []);

  return {
    async prepare() {
      if (!desktop || permissionRequested) return;
      permissionRequested = true;
      try {
        if (!(await isPermissionGranted())) await requestPermission();
      } catch {
        /* The in-app report and completion notice remain available. */
      }
    },
    async notify(status: DiagnosisStatus) {
      if (!desktop || !["complete", "error", "empty"].includes(status.phase))
        return;
      try {
        const window = getCurrentWindow();
        if ((await window.isFocused()) && document.visibilityState !== "hidden")
          return;
        if (!(await isPermissionGranted())) return;
        await listener.current?.catch(() => {});
        const name = basename(status.scope) || status.scope;
        const title =
          status.phase === "complete"
            ? "目录诊断完成"
            : status.phase === "error"
              ? "目录诊断未完成"
              : "目录没有可分析的文件";
        sendNotification({
          id: crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff,
          title,
          body: `${name} · ${status.phase === "complete" ? "点击查看诊断报告" : "点击查看详情"}`,
          extra: {
            filepaceWindow: window.label,
            scope: status.scope,
            runId: status.id,
          },
        });
      } catch {
        /* System notification permissions do not affect report delivery in Filepace. */
      }
    },
  };
}
