import { describe, expect, it } from "vite-plus/test";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  remarkFileCitationDirectives,
  renderFileCitationDirectivesForCopy,
  renderFileCitationsAsMarkdown,
} from "./fileCitationMarkdownDirectives.js";

interface TestNode {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
  readonly data?: {
    readonly hName?: string;
    readonly hProperties?: Readonly<Record<string, unknown>>;
  };
  readonly children?: readonly TestNode[];
}

const FILE_CITATION = ':codex-file-citation{path="outputs/report.xlsx" purpose="output"}';

function parse(markdown: string): TestNode {
  const processor = unified().use(remarkParse).use(remarkFileCitationDirectives);
  return processor.runSync(processor.parse(markdown), { value: markdown }) as TestNode;
}

function parseOrdinaryMarkdown(markdown: string): TestNode {
  return unified().use(remarkParse).parse(markdown) as TestNode;
}

describe("remarkFileCitationDirectives", () => {
  it("renders a file citation as a link without changing its source position", () => {
    const markdown = `Created ${FILE_CITATION}.`;
    const link = parse(markdown).children?.[0]?.children?.[1];

    expect(link).toMatchObject({
      type: "link",
      url: "outputs/report.xlsx",
      children: [{ type: "text", value: "report.xlsx" }],
      position: {
        start: { offset: markdown.indexOf(FILE_CITATION) },
        end: { offset: markdown.indexOf(FILE_CITATION) + FILE_CITATION.length },
      },
    });
  });

  it.each([
    "Meeting at 10:30",
    "Open src/main.ts:42",
    "Use :hover and :tada:",
    "::note",
    ":::note\ncontent\n:::",
    ':codex-file-citation-extra{path="outputs/report.xlsx"}',
    "::artifact-template-extra",
  ])("does not change unrelated colon syntax: %s", (markdown) => {
    expect(parse(markdown)).toEqual(parseOrdinaryMarkdown(markdown));
  });

  it.each([':codex-file-citation{purpose="output"}'])(
    "keeps malformed supported directives literal: %s",
    (markdown) => {
      expect(parse(markdown)).toEqual(parseOrdinaryMarkdown(markdown));
    },
  );
});

describe("native Markdown adapters", () => {
  it("uses the same parser to render file citations as portable links", () => {
    expect(renderFileCitationsAsMarkdown(`Created ${FILE_CITATION}.`)).toBe(
      "Created [report.xlsx](<outputs/report.xlsx>).",
    );
  });

  it.each([
    `\\${FILE_CITATION}`,
    `\`${FILE_CITATION}\``,
    `\`\`\`text\n${FILE_CITATION}\n\`\`\``,
    `[See ${FILE_CITATION}](https://example.com)`,
  ])("does not render excluded citation syntax: %s", (markdown) => {
    expect(renderFileCitationsAsMarkdown(markdown)).toBe(markdown);
  });
});

describe("directive copy adapter", () => {
  it("copies the Markdown representations shown by citation chips", () => {
    expect(renderFileCitationDirectivesForCopy(`Created ${FILE_CITATION}.`)).toBe(
      "Created [report.xlsx](<outputs/report.xlsx>).",
    );
  });

  it("leaves excluded and malformed directive source unchanged", () => {
    const markdown = [
      `\`${FILE_CITATION}\``,
      '::artifact-template{display_name="Hello World"}',
    ].join("\n\n");

    expect(renderFileCitationDirectivesForCopy(markdown)).toBe(markdown);
  });
});
