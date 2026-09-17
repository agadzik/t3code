import { directiveFromMarkdown } from "mdast-util-directive";
import { directive } from "micromark-extension-directive";
import {
  markdownLineEnding,
  unicodePunctuation,
  unicodeWhitespace,
} from "micromark-util-character";
import type { Construct, Extension, Tokenizer } from "micromark-util-types";
import remarkParse from "remark-parse";
import { unified, type Processor } from "unified";

import { fileCitationMarkdown, resolveFileCitationLink } from "./fileCitations.ts";

const COLON = 58;
const DASH = 45;
const UNDERSCORE = 95;
const FILE_CITATION_DIRECTIVE_NAME = "codex-file-citation";
const ARTIFACT_TEMPLATE_DIRECTIVE_NAME = "artifact-template";

export const ARTIFACT_TEMPLATE_HAST_PROPERTIES = [
  "dataArtifactTemplate",
  "dataArtifactKind",
  "dataDisplayName",
  "dataGalleryKind",
  "dataSkillDirectory",
  "dataSkillName",
] as const;

interface MarkdownPosition {
  readonly start: { readonly offset?: number };
  readonly end: { readonly offset?: number };
}

interface MarkdownAstNode {
  type?: string;
  name?: string;
  value?: string;
  url?: string;
  attributes?: Readonly<Record<string, string | null>>;
  position?: MarkdownPosition;
  data?: {
    fileCitationMarkdown?: string;
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
}

interface MarkdownFile {
  readonly value: unknown;
}

function asConstruct(value: Construct | Construct[] | undefined, label: string): Construct {
  const construct = Array.isArray(value) ? value[0] : value;
  if (!construct) throw new Error(`Missing ${label} directive construct`);
  return construct;
}

function directiveNameEnds(code: number | null): boolean {
  return (
    code === null ||
    markdownLineEnding(code) ||
    unicodeWhitespace(code) ||
    (unicodePunctuation(code) && code !== DASH && code !== UNDERSCORE)
  );
}

function directiveNameGate(markerCount: number, name: string): Construct {
  const tokenize: Tokenizer = (effects, ok, nok) => {
    let markerIndex = 0;
    let nameIndex = 0;

    return marker;

    function marker(code: number | null) {
      if (code !== COLON) return nok(code);
      if (markerIndex === 0) effects.enter("data");
      effects.consume(code);
      markerIndex += 1;
      return markerIndex === markerCount ? nameCharacter : marker;
    }

    function nameCharacter(code: number | null) {
      if (code !== name.charCodeAt(nameIndex)) return nok(code);
      effects.consume(code);
      nameIndex += 1;
      return nameIndex === name.length ? afterName : nameCharacter;
    }

    function afterName(code: number | null) {
      effects.exit("data");
      return directiveNameEnds(code) ? ok(code) : nok(code);
    }
  };

  return { partial: true, tokenize };
}

function restrictedDirective(construct: Construct, markerCount: number, name: string): Construct {
  const gate = directiveNameGate(markerCount, name);
  return {
    ...construct,
    tokenize(effects, ok, nok) {
      return effects.check(gate, construct.tokenize.call(this, effects, ok, nok), nok);
    },
  };
}

function fileCitationDirectiveSyntax(): Extension {
  const genericSyntax = directive();
  const textDirective = asConstruct(genericSyntax.text?.[COLON], FILE_CITATION_DIRECTIVE_NAME);
  const flowDirectives = genericSyntax.flow?.[COLON];
  const leafDirective = Array.isArray(flowDirectives)
    ? flowDirectives.find((construct) => construct.concrete !== true)
    : flowDirectives;
  if (!leafDirective)
    throw new Error(`Missing ${ARTIFACT_TEMPLATE_DIRECTIVE_NAME} directive construct`);

  return {
    text: {
      [COLON]: restrictedDirective(textDirective, 1, FILE_CITATION_DIRECTIVE_NAME),
    },
    flow: {
      [COLON]: restrictedDirective(leafDirective, 2, ARTIFACT_TEMPLATE_DIRECTIVE_NAME),
    },
  };
}

const FILE_CITATION_DIRECTIVE_SYNTAX = fileCitationDirectiveSyntax();
const FILE_CITATION_DIRECTIVE_FROM_MARKDOWN = directiveFromMarkdown();

function sourceForNode(node: MarkdownAstNode, source: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? "" : source.slice(start, end);
}

function sourceForDirective(node: MarkdownAstNode, source: string, marker: ":" | "::"): string {
  const prefix = `${marker}${node.name ?? ""}`;
  const slicedSource = sourceForNode(node, source);
  if (slicedSource.startsWith(prefix)) return slicedSource;

  const attributes = Object.entries(node.attributes ?? {}).map(([name, value]) =>
    value === null ? name : `${name}=${JSON.stringify(value)}`,
  );
  return `${prefix}${attributes.length === 0 ? "" : `{${attributes.join(" ")}}`}`;
}

function restoreTextDirective(node: MarkdownAstNode, source: string): void {
  node.type = "text";
  node.value = sourceForDirective(node, source, ":");
  delete node.name;
  delete node.attributes;
  delete node.url;
  delete node.data;
  delete node.children;
}

function renderFileCitation(node: MarkdownAstNode, source: string, insideLink: boolean): void {
  const citation = resolveFileCitationLink(node.attributes);
  if (!citation || insideLink) {
    restoreTextDirective(node, source);
    return;
  }

  node.type = "link";
  node.url = citation.href;
  node.children = [{ type: "text", value: citation.label }];
  node.data = { fileCitationMarkdown: fileCitationMarkdown(citation) };
  delete node.name;
  delete node.attributes;
  delete node.value;
}

function transformFileCitationDirectives(
  node: MarkdownAstNode,
  source: string,
  insideLink = false,
): void {
  if (node.type === "textDirective" && node.name === FILE_CITATION_DIRECTIVE_NAME) {
    renderFileCitation(node, source, insideLink);
    return;
  }

  const childrenInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
  for (const child of node.children ?? []) {
    transformFileCitationDirectives(child, source, childrenInsideLink);
  }
}

/** Adds grammar for historical file-citation directives, then renders them as mdast. */
function attachFileCitationDirectives(this: Processor) {
  const data = this.data();
  const micromarkExtensions = data.micromarkExtensions ?? (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);
  micromarkExtensions.push(FILE_CITATION_DIRECTIVE_SYNTAX);
  fromMarkdownExtensions.push(FILE_CITATION_DIRECTIVE_FROM_MARKDOWN);

  return (tree: unknown, file: MarkdownFile) => {
    transformFileCitationDirectives(tree as MarkdownAstNode, String(file.value));
  };
}

export const remarkFileCitationDirectives = attachFileCitationDirectives;

const directiveParser = unified().use(remarkParse).use(remarkFileCitationDirectives).freeze();

function parseFileCitationMarkdown(markdown: string): MarkdownAstNode {
  return directiveParser.runSync(directiveParser.parse(markdown), {
    value: markdown,
  }) as MarkdownAstNode;
}

interface DirectiveMatch {
  readonly start: number;
  readonly end: number;
  readonly markdown?: string;
}

function collectDirectiveMatches(node: MarkdownAstNode, matches: DirectiveMatch[]): void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start !== undefined && end !== undefined) {
    if (node.data?.fileCitationMarkdown !== undefined) {
      matches.push({ start, end, markdown: node.data.fileCitationMarkdown });
      return;
    }
  }
  for (const child of node.children ?? []) collectDirectiveMatches(child, matches);
}

function renderDirectiveMatches(
  markdown: string,
  replacementFor: (match: DirectiveMatch) => string | undefined,
): string {
  const matches: DirectiveMatch[] = [];
  collectDirectiveMatches(parseFileCitationMarkdown(markdown), matches);
  let rendered = markdown;
  for (const match of matches.sort((left, right) => right.start - left.start)) {
    const replacement = replacementFor(match);
    if (replacement !== undefined) {
      rendered = rendered.slice(0, match.start) + replacement + rendered.slice(match.end);
    }
  }
  return rendered;
}

/** Native Markdown renderers use this adapter because they cannot consume a Remark tree. */
export function renderFileCitationsAsMarkdown(markdown: string): string {
  if (!markdown.includes(`:${FILE_CITATION_DIRECTIVE_NAME}`)) return markdown;

  return renderDirectiveMatches(markdown, (match) => match.markdown);
}

/** Matches the Markdown emitted when users copy rendered file-citation directive UI. */
export function renderFileCitationDirectivesForCopy(markdown: string): string {
  if (!markdown.includes(`:${FILE_CITATION_DIRECTIVE_NAME}`)) {
    return markdown;
  }

  return renderDirectiveMatches(markdown, (match) => match.markdown);
}
