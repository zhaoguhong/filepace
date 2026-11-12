export type SearchFields = {
  query: string;
  category: string;
  date: string;
  size: string;
};
export type SavedSearch = SearchFields & {
  id: string;
  path: string;
  name: string;
  pinned: boolean;
};
const key = "filepace-saved-searches";
export const savedSearchesChanged = "filepace-searches-changed";

function valid(item: unknown, path?: string): SavedSearch | null {
  if (!item || typeof item !== "object") return null;
  const value = item as Partial<SavedSearch>;
  if (
    typeof value.id !== "string" ||
    !value.id ||
    typeof (path ?? value.path) !== "string" ||
    !(path ?? value.path) ||
    [value.query, value.category, value.date, value.size].some(
      (field) => typeof field !== "string",
    )
  )
    return null;
  return {
    id: value.id,
    path: (path ?? value.path)!,
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.slice(0, 100)
        : value.query || "已保存搜索",
    pinned: value.pinned === true,
    query: value.query!,
    category: value.category!,
    date: value.date!,
    size: value.size!,
  };
}

export function readSavedSearches(path?: string): SavedSearch[] {
  try {
    const current = localStorage.getItem(key);
    const values: SavedSearch[] = [];
    if (current !== null) {
      const saved: unknown = JSON.parse(current);
      if (Array.isArray(saved))
        for (const item of saved) {
          const parsed = valid(item);
          if (parsed) values.push(parsed);
        }
    } else {
      // Old releases saved unnamed searches under each directory's own key.
      for (let i = 0; i < localStorage.length; i++) {
        const storedKey = localStorage.key(i);
        if (!storedKey?.startsWith("filepace-searches:")) continue;
        try {
          const saved: unknown = JSON.parse(
            localStorage.getItem(storedKey) ?? "[]",
          );
          if (Array.isArray(saved))
            for (const item of saved) {
              const parsed = valid(
                item,
                storedKey.slice("filepace-searches:".length),
              );
              if (parsed) values.push(parsed);
            }
        } catch {
          /* An invalid scope does not discard other saved conditions. */
        }
      }
    }
    return Array.from(new Map(values.map((item) => [item.id, item])).values())
      .filter((item) => !path || item.path === path)
      .slice(0, 100);
  } catch {
    return [];
  }
}

export function writeSavedSearches(items: SavedSearch[]) {
  localStorage.setItem(key, JSON.stringify(items.slice(0, 100)));
  window.dispatchEvent(new Event(savedSearchesChanged));
}
