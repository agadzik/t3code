import { describe, expect, it } from "vite-plus/test";

import { fileCitationMarkdown, resolveFileCitationLink } from "./fileCitations.js";

describe("resolveFileCitationLink", () => {
  it("resolves file-citation directive attributes", () => {
    expect(
      resolveFileCitationLink({
        path: "/workspace/outputs/issue-2387-sparse-diagonal.xlsx",
        purpose: "output",
      }),
    ).toEqual({
      path: "/workspace/outputs/issue-2387-sparse-diagonal.xlsx",
      href: "/workspace/outputs/issue-2387-sparse-diagonal.xlsx",
      label: "issue-2387-sparse-diagonal.xlsx",
    });
  });

  it("carries the first cited line into the file href", () => {
    expect(
      resolveFileCitationLink({
        path: "src/main.ts",
        line_range_start: "42",
        line_range_end: "48",
        git_url: "https://example.com/main.ts",
      }),
    ).toEqual({
      path: "src/main.ts",
      href: "src/main.ts#L42",
      label: "main.ts",
      lineRangeStart: 42,
    });
  });

  it("rejects missing paths and invalid line numbers", () => {
    expect(resolveFileCitationLink({ purpose: "output" })).toBeNull();
    expect(
      resolveFileCitationLink({ path: "src/main.ts", line_range_start: "not-a-line" }),
    ).toEqual({
      path: "src/main.ts",
      href: "src/main.ts",
      label: "main.ts",
    });
  });

  it("preserves URL syntax characters in file paths", () => {
    expect(
      resolveFileCitationLink({
        path: "reports/100% #1? draft.md",
        line_range_start: "7",
      }),
    ).toEqual({
      path: "reports/100% #1? draft.md",
      href: "reports/100%25 %231%3F draft.md#L7",
      label: "100% #1? draft.md",
      lineRangeStart: 7,
    });
  });
});

describe("fileCitationMarkdown", () => {
  it("produces a portable Markdown link", () => {
    const citation = resolveFileCitationLink({ path: "reports/profit and loss.xlsx" });
    expect(citation && fileCitationMarkdown(citation)).toBe(
      "[profit and loss.xlsx](<reports/profit and loss.xlsx>)",
    );
  });

  it("escapes Markdown syntax in the visible filename", () => {
    const citation = resolveFileCitationLink({
      path: "reports/*draft*_[copy]`<&.txt",
    });
    expect(citation && fileCitationMarkdown(citation)).toBe(
      "[\\*draft\\*\\_\\[copy\\]\\`\\<\\&.txt](<reports/*draft*_[copy]`%3C&.txt>)",
    );
  });
});
