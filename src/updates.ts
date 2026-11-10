import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { version } from "../package.json";
import { call, desktop } from "./bridge";

export type UpdateStatus = {
  current: string;
  phase:
    | "idle"
    | "checking"
    | "downloading"
    | "current"
    | "ready"
    | "installing"
    | "error";
  version?: string;
  message?: string;
};

export function useUpdates(autoUpdate: boolean) {
  const [status, setStatus] = useState<UpdateStatus>({
    current: version,
    phase: "idle",
  });
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const stop = listen<UpdateStatus>("filepace-update", ({ payload }) =>
      setStatus(payload),
    );
    void stop
      .then(() => call<UpdateStatus>("update_status"))
      .then((snapshot) => {
        if (!disposed && snapshot) setStatus(snapshot);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!desktop || !autoUpdate) return;
    const check = () =>
      void call("check_update", { automatic: true }).catch(() => {});
    const initial = setTimeout(check, 4500);
    const timer = setInterval(check, 6 * 60 * 60 * 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [autoUpdate]);
  return {
    status,
    check: () => call("check_update", { automatic: false }),
    install: () => call("install_update"),
  };
}
