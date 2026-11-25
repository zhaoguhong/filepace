import type { Tab } from "./model";
import type { Session } from "./session";

export class ScrollPositions {
  private offsets = new WeakMap<Tab, number>();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  read(tab: Tab) {
    return (
      this.offsets.get(tab) ??
      (Number.isFinite(tab.scroll) ? Math.max(0, tab.scroll) : 0)
    );
  }

  record(tab: Tab, scroll: number) {
    scroll = Math.max(0, scroll);
    if (this.read(tab) === scroll) return;
    this.offsets.set(tab, scroll);
    for (const listener of this.listeners) listener();
  }

  // Materialize the native viewport before replacing or serializing a tab.
  captureTab = (tab: Tab): Tab => {
    const scroll = this.read(tab);
    return scroll === tab.scroll ? tab : { ...tab, scroll };
  };

  captureSession(session: Session): Session {
    return {
      ...session,
      tabs: session.tabs.map(this.captureTab),
      right: session.right && {
        ...session.right,
        tabs: session.right.tabs.map(this.captureTab),
      },
    };
  }
}
