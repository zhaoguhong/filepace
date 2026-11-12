export type TextPreviewKind =
  "markdown" | "json" | "csv" | "tsv" | "code" | "text";

// Keep parsing and DOM size bounded independently of the native 2 MB read limit.
export const TEXT_PREVIEW_LIMIT = 120_000;
export const TABLE_ROW_LIMIT = 200;
export const TABLE_COLUMN_LIMIT = 40;

export function textPreviewKind(name: string): TextPreviewKind {
  if (/\.(md|markdown|mdown)$/i.test(name)) return "markdown";
  if (/\.json$/i.test(name)) return "json";
  if (/\.csv$/i.test(name)) return "csv";
  if (/\.tsv$/i.test(name)) return "tsv";
  if (
    /\.(?:[cm]?[jt]sx?|rs|py|sh|bash|zsh|ps1|go|java|kt|swift|c|cpp|h|hpp|css|scss|html?|xml|ya?ml|toml|sql|rb|php)$/i.test(
      name,
    )
  )
    return "code";
  return "text";
}

export function formatJson(text: string): { text: string; error?: string } {
  try {
    const source = text.replace(/^\uFEFF/, "").trim();
    JSON.parse(source); // Validate grammar, but preserve numbers, duplicate keys and escapes below.
    const parts: string[] = [];
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let previous = "";
    let length = 0;
    const append = (value: string) => {
      parts.push(value);
      length += value.length;
    };
    for (let i = 0; i < source.length; i++) {
      const character = source[i];
      if (quoted) {
        append(character);
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') {
        quoted = true;
        append(character);
      } else if (/\s/.test(character)) continue;
      else if (character === "{" || character === "[") {
        append(character);
        depth++;
        if (depth > 100)
          return { text, error: "JSON 嵌套层级过深，以下显示原文。" };
        let next = i + 1;
        while (next < source.length && /\s/.test(source[next])) next++;
        if (source[next] !== "}" && source[next] !== "]")
          append("\n" + "  ".repeat(depth));
      } else if (character === "}" || character === "]") {
        depth--;
        if (previous !== "{" && previous !== "[")
          append("\n" + "  ".repeat(depth));
        append(character);
      } else if (character === ",") append(",\n" + "  ".repeat(depth));
      else if (character === ":") append(": ");
      else append(character);
      previous = character;
      if (length > TEXT_PREVIEW_LIMIT * 2)
        return { text, error: "JSON 排版后过长，以下显示原文。" };
    }
    return { text: parts.join("") };
  } catch {
    return { text, error: "JSON 格式不完整或无法解析，以下显示原文。" };
  }
}

export type DelimitedPreview = {
  rows: string[][];
  columns: number;
  limited: boolean;
  error?: string;
};

/** RFC-style quoted fields, escaped quotes and embedded newlines, without evaluating cells. */
export function parseDelimited(
  source: string,
  delimiter: "," | "\t",
): DelimitedPreview {
  const text = source.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  let columns = 0;
  let rowColumns = 0;
  let limited = false;
  const finishField = () => {
    rowColumns++;
    if (rowColumns <= TABLE_COLUMN_LIMIT) row.push(field);
    else limited = true;
    field = "";
    closedQuote = false;
  };
  const finishRow = () => {
    finishField();
    columns = Math.max(columns, rowColumns);
    rows.push(row);
    row = [];
    rowColumns = 0;
  };
  const invalid = (): DelimitedPreview => ({
    rows: [],
    columns: 0,
    limited: false,
    error: "表格中的引号不完整或格式不一致，以下显示原文。",
  });
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else field += character;
    } else if (character === delimiter) {
      finishField();
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[i + 1] === "\n") i++;
      finishRow();
      if (rows.length >= TABLE_ROW_LIMIT && i + 1 < text.length) {
        limited = true;
        break;
      }
    } else if (character === '"') {
      if (field || closedQuote) return invalid();
      quoted = true;
    } else {
      if (closedQuote) return invalid();
      field += character;
    }
  }
  if (quoted) return invalid();
  if (field || row.length || rowColumns || closedQuote) finishRow();
  return { rows, columns: Math.min(columns, TABLE_COLUMN_LIMIT), limited };
}

export type CodeToken = {
  text: string;
  kind?: "comment" | "string" | "keyword" | "number";
};

const keywords = new Set(
  "true false null undefined None True False const let var function return if else for while do switch case break continue try catch finally throw new class extends export import from default async await public private static void int bool string struct enum impl fn pub use mod match mut self def lambda with as in and or not select insert update delete create where join values interface type typeof instanceof yield this super print echo".split(
    " ",
  ),
);

// This is deliberately a small lexical highlighter; it never interprets file content.
export function codeTokens(text: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const pattern =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\b[A-Za-z_]\w*\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (tokens.length >= 5_999) break;
    const index = match.index!;
    if (index > cursor) tokens.push({ text: text.slice(cursor, index) });
    const value = match[0];
    const kind = /^(?:\/\/|\/\*|#)/.test(value)
      ? "comment"
      : /^["'`]/.test(value)
        ? "string"
        : /^\d/.test(value)
          ? "number"
          : keywords.has(value)
            ? "keyword"
            : undefined;
    // Merge plain spans to avoid a DOM node per identifier.
    if (!kind && tokens.length && !tokens[tokens.length - 1].kind)
      tokens[tokens.length - 1].text += value;
    else tokens.push({ text: value, kind });
    cursor = index + value.length;
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor) });
  return tokens;
}

export function safePreviewLink(value: string): string | undefined {
  // Relative paths, scripts, data URLs and automatic resource loading stay inert.
  if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
