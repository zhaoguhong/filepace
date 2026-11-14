import { useState } from "react";
import { basename, formatSize } from "./model";
import { describeFile } from "./fileTypes";
import ResultFiles from "./ResultFiles";
import type { ResultActionProps } from "./resultActions";
import type { StorageReport, StorageTreeNode } from "./storageTypes";
import { storagePathKey } from "./storageBaseline";
import "./storageMap.css";

import { layoutStorageTiles } from "./storageMapLayout";
const colors: Record<string, string> = {
  documents: "#4978cb",
  images: "#288678",
  videos: "#8359b8",
  audio: "#ba618a",
  archives: "#b77b38",
  code: "#6370ac",
  apps: "#416f87",
  other: "#8292a9",
};

export default function StorageTreemap({
  report,
  visible,
  onBrowse,
  onFileAction,
  fileChanges,
  fileChangeBatches,
  changeBaseline,
}: ResultActionProps & {
  report: StorageReport;
  visible: boolean;
  onBrowse: (path: string, selected?: string) => void;
  changeBaseline?: number;
}) {
  const [directory, setDirectory] = useState(report.path);
  const [selected, setSelected] = useState("");
  const tree = report.tree ?? [];
  const directoryNode = tree.find(
    (node) => node.path === directory && node.isDir,
  );
  const current = directoryNode?.path ?? report.path;
  const total = directoryNode?.size ?? report.counts.bytes;
  const children = tree
    .filter((node) => storagePathKey(node.parent) === storagePathKey(current))
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const shown = children.filter((node) => node.size > 0).slice(0, 63);
  const represented = shown.reduce((sum, node) => sum + node.size, 0);
  const remainder = Math.max(0, total - represented);
  const tiles = layoutStorageTiles([
    ...shown.map((node) => ({ node, size: node.size, label: node.name })),
    ...(remainder ? [{ size: remainder, label: "其他 / 未展开项目" }] : []),
  ]);
  const list = selected
    ? children.filter((node) => node.path === selected)
    : children;
  function choose(node: StorageTreeNode) {
    if (node.isDir) {
      setDirectory(node.path);
      setSelected("");
    } else setSelected(node.path);
  }
  return (
    <section className="storage-card storage-treemap" aria-label="目录矩形树图">
      <div className="analysis-card-heading">
        <h3>目录矩形树图</h3>
        <span>面积表示文件逻辑大小</span>
      </div>
      {!report.tree ? (
        <p className="storage-muted">重新扫描以生成目录矩形树图。</p>
      ) : (
        <>
          <div className="storage-map-navigation">
            <button
              className="storage-secondary"
              disabled={current === report.path}
              onClick={() => {
                setDirectory(directoryNode?.parent ?? report.path);
                setSelected("");
              }}
            >
              上一级
            </button>
            <button
              className="storage-secondary"
              disabled={current === report.path}
              onClick={() => {
                setDirectory(report.path);
                setSelected("");
              }}
            >
              扫描根目录
            </button>
            <strong title={current}>
              {basename(current) || current} · {formatSize(total)}
            </strong>
            <button
              className="storage-secondary"
              onClick={() => onBrowse(current)}
            >
              在文件中打开
            </button>
          </div>
          <p className="storage-muted">
            点击目录进入下一层，点击文件在下方列表预览和整理。图块最多展示 63
            项，其余大小合并显示。
          </p>
          <div
            className="storage-map"
            role="group"
            aria-label={`目录占用图 ${current}`}
          >
            {tiles.length ? (
              tiles.map((tile, index) => {
                const style = {
                  left: `${tile.x}%`,
                  top: `${tile.y}%`,
                  width: `${tile.width}%`,
                  height: `${tile.height}%`,
                  background: tile.node
                    ? tile.node.isDir
                      ? "#476d9b"
                      : (colors[
                          describeFile({
                            ...tile.node,
                            isLink: false,
                            hidden: false,
                          }).category
                        ] ?? colors.other)
                    : "#73808b",
                };
                return tile.node ? (
                  <button
                    key={tile.node.path}
                    className="storage-map-tile"
                    style={style}
                    title={`${tile.label} · ${formatSize(tile.size)}`}
                    aria-label={`${tile.node.isDir ? "展开目录" : "查看文件"} ${tile.label} · ${formatSize(tile.size)}`}
                    aria-pressed={selected === tile.node.path}
                    onClick={() => choose(tile.node!)}
                  >
                    <span>{tile.label}</span>
                    <small>{formatSize(tile.size)}</small>
                  </button>
                ) : (
                  <div
                    key={`other-${index}`}
                    className="storage-map-tile storage-map-remainder"
                    style={style}
                    title={`${tile.label} · ${formatSize(tile.size)}`}
                  >
                    <span>{tile.label}</span>
                    <small>{formatSize(tile.size)}</small>
                  </div>
                );
              })
            ) : (
              <p className="storage-map-empty">
                没有可绘制的文件大小。空文件和空目录仍显示在下方列表。
              </p>
            )}
          </div>
          {(report.treeComplete === false ||
            remainder > 0 ||
            report.counts.skipped > 0) && (
            <p className="storage-muted">
              扫描明细最多保留 8192
              项；未展开部分合并为灰色区域，目录大小仍累计所有已读取文件。跳过项目没有计入大小，可选择子目录重新扫描查看完整明细。
            </p>
          )}
          <div className="storage-map-list-heading">
            <h4>图中项目 · {current}</h4>
            {selected && (
              <button
                className="storage-secondary"
                onClick={() => setSelected("")}
              >
                显示全部项目
              </button>
            )}
          </div>
          {list.length ? (
            <ResultFiles
              key={`${current}-${selected}`}
              items={list
                .slice(0, 200)
                .map((node) => ({
                  entry: { ...node, isLink: false, hidden: false },
                  parent: node.parent,
                }))}
              scope={report.path}
              label="图中项目"
              visible={visible}
              onBrowse={onBrowse}
              onFileAction={onFileAction}
              fileChanges={fileChanges}
              fileChangeBatches={fileChangeBatches}
              changeBaseline={changeBaseline}
              extra={(item) =>
                item.entry.isDir ? (
                  <button
                    className="storage-scan-folder"
                    aria-label={`在图中展开 ${item.entry.name}`}
                    onClick={() => {
                      setDirectory(item.entry.path);
                      setSelected("");
                    }}
                  >
                    展开
                  </button>
                ) : undefined
              }
            />
          ) : (
            <p className="storage-muted">没有记录到子项目。</p>
          )}
          {list.length > 200 && (
            <p className="storage-muted">
              列表显示前 200 项；可打开所在目录查看其余项目。
            </p>
          )}
        </>
      )}
    </section>
  );
}
