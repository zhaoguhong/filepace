import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { call } from "./bridge";

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({
  path,
  name,
}: {
  path: string;
  name: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    void call<ArrayBuffer>("read_image", { path })
      .then(async (bytes) => {
        if (!active) return;
        task = getDocument({
          data: new Uint8Array(bytes),
          useWasm: false,
        });
        const document = await task.promise;
        if (active) setDocument(document);
      })
      .catch((error) => {
        if (active) setError("无法预览这个 PDF：" + String(error));
      });
    return () => {
      active = false;
      if (task) void task.destroy().catch(() => {});
    };
  }, [path]);

  useEffect(() => {
    if (!document || !canvas.current) return;
    const element = canvas.current;
    let active = true;
    let drawing: RenderTask | undefined;
    void document
      .getPage(page)
      .then(async (pdfPage) => {
        if (!active) return;
        const original = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(900 / original.width, 1300 / original.height);
        const viewport = pdfPage.getViewport({
          scale: scale * Math.min(2, devicePixelRatio),
        });
        element.width = Math.ceil(viewport.width);
        element.height = Math.ceil(viewport.height);
        drawing = pdfPage.render({ canvas: element, viewport });
        await drawing.promise;
      })
      .catch((error) => {
        if (active) setError("无法绘制 PDF 页面：" + String(error));
      });
    return () => {
      active = false;
      drawing?.cancel();
    };
  }, [document, page]);

  if (error) return <pre role="alert">{error}</pre>;
  if (!document) return <p role="status">正在读取 PDF…</p>;
  return (
    <div className="pdf-preview">
      <div className="pdf-pages">
        <button disabled={page === 1} onClick={() => setPage(page - 1)}>
          上一页
        </button>
        <span aria-live="polite">
          第 {page} / {document.numPages} 页
        </span>
        <button
          disabled={page === document.numPages}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </button>
      </div>
      <canvas ref={canvas} role="img" aria-label={`${name} 第 ${page} 页`} />
    </div>
  );
}
