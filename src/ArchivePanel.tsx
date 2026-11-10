import { useEffect, useState } from "react";
import { call } from "./bridge";
import { formatSize, type Entry } from "./model";

type Contents = {
  total: number;
  entries: { name: string; size: number; directory: boolean }[];
};

export default function ArchivePanel({
  entry,
  parent,
  onClose,
  onExtract,
}: {
  entry: Entry;
  parent: string;
  onClose: () => void;
  onExtract: (destination: string) => Promise<boolean>;
}) {
  const [destination, setDestination] = useState(parent);
  const [contents, setContents] = useState<Contents>();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let active = true;
    void call<Contents>("list_archive", { path: entry.path }).then(
      (result) => {
        if (active) setContents(result);
      },
      (error) => {
        if (active) setError(String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [entry.path]);
  return (
    <div className="overlay">
      <form
        className="modal form-modal batch-rename"
        role="dialog"
        aria-modal="true"
        aria-label="浏览压缩包"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!destination.trim() || working || !contents) return;
          setWorking(true);
          try {
            if (await onExtract(destination.trim())) onClose();
            else setError("无法启动解压，请确认目标文件夹可以访问。");
          } finally {
            setWorking(false);
          }
        }}
      >
        <h3>{entry.name}</h3>
        <p role="status">
          {error ||
            (contents
              ? `${contents.total} 项${contents.total > contents.entries.length ? `，显示前 ${contents.entries.length} 项` : ""}`
              : "正在读取压缩包…")}
        </p>
        <div className="batch-preview">
          {contents?.entries.map((item, index) => (
            <div key={index}>
              <span>{item.name}</span>
              <span>{item.directory ? "文件夹" : formatSize(item.size)}</span>
            </div>
          ))}
        </div>
        <label>
          解压到文件夹
          <input
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
          />
        </label>
        <p>将在指定位置创建一个同名文件夹。</p>
        <div className="modal-buttons">
          <button type="button" onClick={onClose}>
            关闭
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!contents || !destination.trim() || working}
          >
            解压
          </button>
        </div>
      </form>
    </div>
  );
}
