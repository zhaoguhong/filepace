import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TextPreview from "./TextPreview";
import {
  codeTokens,
  formatJson,
  parseDelimited,
  safePreviewLink,
  TABLE_COLUMN_LIMIT,
  TABLE_ROW_LIMIT,
  TEXT_PREVIEW_LIMIT,
  textPreviewKind,
} from "./textPreviewFormat";

describe("read-only rich text previews", () => {
  it("renders Markdown structure while keeping HTML, scripts and remote images inert", () => {
    const markup = renderToStaticMarkup(
      <TextPreview
        name="README.md"
        text={
          "# Project\n\n**Important** and `code`.\n\n- [x] done\n- [ ] pending\n\n<script>alert(1)</script>\n\n![tracking](https://example.com/tracker.png)\n[bad](javascript:alert)\n[reference](https://example.com/docs)\n\n```html\n<img src=x onerror=alert(1)>\n```"
        }
      />,
    );
    expect(markup).toContain("<h1>Project</h1>");
    expect(markup).toContain("<strong>Important</strong>");
    expect(markup).toContain("<code>code</code>");
    expect(markup).toContain('aria-label="已完成"');
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain('href="javascript:');
    expect(markup).toContain('href="https://example.com/docs"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  it("distinguishes loading, an empty file and a native read failure", () => {
    expect(renderToStaticMarkup(<TextPreview name="empty.json" />)).toContain(
      "正在读取",
    );
    const empty = renderToStaticMarkup(
      <TextPreview name="empty.json" text="" />,
    );
    expect(empty).toContain("文件为空");
    expect(empty).not.toContain("正在读取");
    expect(
      renderToStaticMarkup(
        <TextPreview name="bad.md" error="Permission denied: <file>" />,
      ),
    ).toContain("Permission denied: &lt;file&gt;");
  });

  it.each([null, 42, {}, []])(
    "handles unexpected IPC preview data %j without crashing",
    (value) => {
      const markup = renderToStaticMarkup(
        <TextPreview name="native.json" text={value as unknown as string} />,
      );
      expect(markup).toContain("暂时无法生成文本预览");
      expect(markup).not.toContain("正在读取");
    },
  );

  it("formats JSON and preserves invalid JSON as readable source", () => {
    expect(formatJson('{"values":[1,true,null]}').text).toBe(
      '{\n  "values": [\n    1,\n    true,\n    null\n  ]\n}',
    );
    expect(formatJson('\uFEFF{"unicode":"文件"}').error).toBeUndefined();
    const invalid = '{"incomplete":';
    expect(formatJson(invalid)).toMatchObject({
      text: invalid,
      error: expect.any(String),
    });
    const markup = renderToStaticMarkup(
      <TextPreview name="incomplete.json" text={invalid} />,
    );
    expect(markup).toContain("JSON 格式不完整");
    expect(markup).toContain("&quot;incomplete&quot;");
  });

  it("preserves large integer IDs, negative zero, key order and duplicate keys", () => {
    const source =
      '{"id":9007199254740993,"zero":-0,"2":1,"1":2,"id":1e+20,"escaped":"\\u4e2d"}';
    const formatted = formatJson(source);
    expect(formatted.error).toBeUndefined();
    expect(formatted.text).toContain("9007199254740993");
    expect(formatted.text).toContain('"zero": -0');
    expect(formatted.text.indexOf('"2"')).toBeLessThan(
      formatted.text.indexOf('"1"'),
    );
    expect(formatted.text).toContain('"id": 1e+20');
    expect(formatted.text).toContain('"escaped": "\\u4e2d"');
    expect(
      formatJson("[".repeat(101) + "0" + "]".repeat(101)).error,
    ).toBeTruthy();
  });

  it("keeps CSV cells literal, including formulas and markup", () => {
    const text =
      'name,value\n"<img src=x>","=HYPERLINK(""https://example.com"")"';
    const markup = renderToStaticMarkup(
      <TextPreview name="sheet.csv" text={text} />,
    );
    expect(markup).toContain("<table");
    expect(markup).toContain("&lt;img src=x&gt;");
    expect(markup).toContain("=HYPERLINK");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<a ");
  });

  it("bounds large previews with a visible explanation and retains source safely", () => {
    const text = "x".repeat(TEXT_PREVIEW_LIMIT + 10);
    const markup = renderToStaticMarkup(
      <TextPreview name="large.json" text={text} />,
    );
    expect(markup).toContain("仅预览前");
    expect(markup).toContain("大文件显示原文");
    expect(markup).not.toContain("JSON 格式不完整");
    expect(markup.match(/<pre[^>]*>(x+)<\/pre>/)?.[1]).toHaveLength(
      TEXT_PREVIEW_LIMIT,
    );
  });

  it("reconstructs untrusted code exactly after highlighting", () => {
    const source =
      '// comment\nexport const value = "<script>";\nreturn value + 42;\n';
    const tokens = codeTokens(source);
    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(tokens.some((token) => token.kind === "keyword")).toBe(true);
    expect(tokens.some((token) => token.kind === "comment")).toBe(true);
    const hostile = "1 ".repeat(60_000);
    const bounded = codeTokens(hostile);
    expect(bounded.length).toBeLessThanOrEqual(6_001);
    expect(bounded.map((token) => token.text).join("")).toBe(hostile);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/a",
    "../local.md",
    "//example.com",
    "httpsx://example.com",
  ])("rejects non-web preview link %s", (value) => {
    expect(safePreviewLink(value)).toBeUndefined();
  });
  it("recognizes uppercase, typed source extensions and common document formats", () => {
    expect(textPreviewKind("README.MD")).toBe("markdown");
    expect(textPreviewKind("DATA.TSV")).toBe("tsv");
    expect(textPreviewKind("index.mjs")).toBe("code");
    expect(textPreviewKind("index.d.ts")).toBe("code");
    expect(textPreviewKind("photo.png")).toBe("text");
  });
});

describe("delimited text preview", () => {
  it("handles Unicode, a BOM, embedded delimiters/newlines, escaped quotes and trailing cells", () => {
    expect(
      parseDelimited(
        '\uFEFF标题,内容\r\n"报告,一","首行\n末行"\r\n"说""你好""",\r\n',
        ",",
      ),
    ).toEqual({
      rows: [
        ["标题", "内容"],
        ["报告,一", "首行\n末行"],
        ['说"你好"', ""],
      ],
      columns: 2,
      limited: false,
    });
    expect(parseDelimited('a\tb\n"x\ty"\tz\n', "\t").rows).toEqual([
      ["a", "b"],
      ["x\ty", "z"],
    ]);
    expect(parseDelimited("a,b,", ",").rows).toEqual([["a", "b", ""]]);
    expect(parseDelimited("", ",").rows).toEqual([]);
  });

  it.each(['"unterminated', 'a,"x"extra', 'a,b"c'])(
    "falls back for malformed CSV %s",
    (text) => {
      expect(parseDelimited(text, ",").error).toBeTruthy();
    },
  );

  it("bounds row and column rendering rather than constructing unbounded tables", () => {
    const lines = Array.from(
      { length: TABLE_ROW_LIMIT + 4 },
      (_, row) => `${row},value`,
    ).join("\n");
    const parsed = parseDelimited(lines, ",");
    expect(parsed.rows).toHaveLength(TABLE_ROW_LIMIT);
    expect(parsed.rows[TABLE_ROW_LIMIT - 1][0]).toBe(
      String(TABLE_ROW_LIMIT - 1),
    );
    expect(parsed.limited).toBe(true);
    const columns = parseDelimited(
      Array.from(
        { length: TABLE_COLUMN_LIMIT + 5 },
        (_, column) => column,
      ).join(","),
      ",",
    );
    expect(columns.rows[0]).toHaveLength(TABLE_COLUMN_LIMIT);
    expect(columns.columns).toBe(TABLE_COLUMN_LIMIT);
    expect(columns.limited).toBe(true);
  });
});
