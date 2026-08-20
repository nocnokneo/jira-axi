/**
 * Atlassian Document Format conversion.
 *
 * Jira Cloud's v3 API speaks ADF for every rich-text field, but agents read and
 * write plain text. Both directions run through here so command code never has
 * to think about node trees: reads flatten to Markdown-ish text, writes parse a
 * Markdown subset back into ADF.
 */

export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

/* ------------------------------------------------------------------ */
/* ADF -> text                                                         */
/* ------------------------------------------------------------------ */

function applyMarks(text: string, marks: AdfNode["marks"]): string {
  if (!marks || marks.length === 0) {
    return text;
  }

  let result = text;
  // Innermost first so `**`/`_` end up outside the code fence, matching how the
  // Markdown parser below reads them back.
  for (const mark of marks) {
    switch (mark.type) {
      case "code":
        result = `\`${result}\``;
        break;
      case "strong":
        result = `**${result}**`;
        break;
      case "em":
        result = `_${result}_`;
        break;
      case "strike":
        result = `~~${result}~~`;
        break;
      case "link": {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : undefined;
        result = href ? `[${result}](${href})` : result;
        break;
      }
      default:
        break;
    }
  }
  return result;
}

function inlineToText(nodes: AdfNode[] | undefined): string {
  if (!nodes) {
    return "";
  }

  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += applyMarks(node.text ?? "", node.marks);
        break;
      case "hardBreak":
        out += "\n";
        break;
      case "mention": {
        const label = typeof node.attrs?.text === "string" ? node.attrs.text : "unknown";
        out += label.startsWith("@") ? label : `@${label}`;
        break;
      }
      case "emoji": {
        const shortName = typeof node.attrs?.shortName === "string" ? node.attrs.shortName : "";
        const text = typeof node.attrs?.text === "string" ? node.attrs.text : shortName;
        out += text;
        break;
      }
      case "date": {
        const timestamp = node.attrs?.timestamp;
        const ms = typeof timestamp === "string" ? Number(timestamp) : Number(timestamp ?? Number.NaN);
        out += Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
        break;
      }
      case "status": {
        const label = typeof node.attrs?.text === "string" ? node.attrs.text : "";
        out += `[${label}]`;
        break;
      }
      case "inlineCard":
      case "blockCard":
      case "embedCard": {
        const url = typeof node.attrs?.url === "string" ? node.attrs.url : "";
        out += url;
        break;
      }
      case "media": {
        const alt =
          (typeof node.attrs?.alt === "string" && node.attrs.alt) ||
          (typeof node.attrs?.id === "string" && node.attrs.id) ||
          "attachment";
        out += `[media: ${alt}]`;
        break;
      }
      case "inlineExtension":
      case "extension":
        out += `[${String(node.attrs?.extensionKey ?? "extension")}]`;
        break;
      default:
        // Unknown inline node: recurse so its text still surfaces.
        out += inlineToText(node.content);
        break;
    }
  }
  return out;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? line : line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

function listToText(node: AdfNode, ordered: boolean, depth: number): string {
  const pad = "  ".repeat(depth);
  const items: string[] = [];

  (node.content ?? []).forEach((item, index) => {
    const marker = ordered ? `${index + 1}. ` : "- ";
    const body = blocksToText(item.content ?? [], depth + 1).trim();
    items.push(`${pad}${marker}${indent(body, `${pad}${" ".repeat(marker.length)}`)}`);
  });

  return items.join("\n");
}

function blockToText(node: AdfNode, depth: number): string {
  switch (node.type) {
    case "paragraph":
      return inlineToText(node.content);
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      const hashes = "#".repeat(Math.min(Math.max(level, 1), 6));
      return `${hashes} ${inlineToText(node.content)}`;
    }
    case "bulletList":
      return listToText(node, false, depth);
    case "orderedList":
      return listToText(node, true, depth);
    case "taskList": {
      const items = (node.content ?? []).map((item) => {
        const done = item.attrs?.state === "DONE";
        return `- [${done ? "x" : " "}] ${inlineToText(item.content)}`;
      });
      return items.join("\n");
    }
    case "codeBlock": {
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const code = (node.content ?? []).map((child) => child.text ?? "").join("");
      return `\`\`\`${language}\n${code}\n\`\`\``;
    }
    case "blockquote":
      return blocksToText(node.content ?? [], depth)
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
    case "rule":
      return "---";
    case "panel": {
      const kind = typeof node.attrs?.panelType === "string" ? node.attrs.panelType : "info";
      return `[${kind}] ${blocksToText(node.content ?? [], depth)}`;
    }
    case "expand":
    case "nestedExpand": {
      const title = typeof node.attrs?.title === "string" ? node.attrs.title : "details";
      return `${title}:\n${blocksToText(node.content ?? [], depth)}`;
    }
    case "table": {
      const rows = (node.content ?? []).map((row) =>
        (row.content ?? [])
          .map((cell) => blocksToText(cell.content ?? [], depth).replace(/\n+/g, " ").trim())
          .join(" | "),
      );
      return rows.map((row) => `| ${row} |`).join("\n");
    }
    case "mediaSingle":
    case "mediaGroup":
      return inlineToText(node.content);
    default:
      if (node.content) {
        return blocksToText(node.content, depth);
      }
      return node.text ?? "";
  }
}

function blocksToText(nodes: AdfNode[], depth = 0): string {
  const blocks: string[] = [];
  for (const node of nodes) {
    const text = blockToText(node, depth);
    blocks.push(text);
  }
  // Blank line between blocks preserves paragraph structure so the Markdown
  // parser can round-trip it.
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Flatten a rich-text field to plain text. Accepts an ADF doc, a bare node
 * array, or the plain string that some endpoints still return.
 */
export function adfToText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return blocksToText(value as AdfNode[]).trim();
  }
  if (typeof value === "object") {
    const node = value as AdfNode;
    if (Array.isArray(node.content)) {
      return blocksToText(node.content).trim();
    }
    if (typeof node.text === "string") {
      return node.text;
    }
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* text -> ADF                                                         */
/* ------------------------------------------------------------------ */

type Mark = { type: string; attrs?: Record<string, unknown> };

function textNode(text: string, marks: Mark[]): AdfNode {
  const node: AdfNode = { type: "text", text };
  if (marks.length > 0) {
    node.marks = marks;
  }
  return node;
}

/**
 * Tokenize inline Markdown into ADF text nodes.
 *
 * Code spans are matched first and consume their contents verbatim, so
 * `` `**not bold**` `` stays literal.
 */
function parseInline(line: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let buffer = "";

  const flush = (marks: Mark[] = []) => {
    if (buffer.length > 0) {
      nodes.push(textNode(buffer, marks));
      buffer = "";
    }
  };

  let index = 0;
  while (index < line.length) {
    const rest = line.slice(index);

    const code = /^`([^`]+)`/.exec(rest);
    if (code?.[1]) {
      flush();
      nodes.push(textNode(code[1], [{ type: "code" }]));
      index += code[0].length;
      continue;
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link?.[1] && link[2]) {
      flush();
      nodes.push(textNode(link[1], [{ type: "link", attrs: { href: link[2] } }]));
      index += link[0].length;
      continue;
    }

    const strong = /^\*\*([^*]+)\*\*/.exec(rest);
    if (strong?.[1]) {
      flush();
      nodes.push(textNode(strong[1], [{ type: "strong" }]));
      index += strong[0].length;
      continue;
    }

    const strike = /^~~([^~]+)~~/.exec(rest);
    if (strike?.[1]) {
      flush();
      nodes.push(textNode(strike[1], [{ type: "strike" }]));
      index += strike[0].length;
      continue;
    }

    // Emphasis needs two guards. A non-space first character keeps `a * b * c`
    // from becoming italics, and for `_` the delimiters must sit on word
    // boundaries so `some_field_name` stays a single identifier.
    const em = /^([*_])([^\s*_][^*_]*)\1/.exec(rest);
    if (em?.[2]) {
      const delimiter = em[1] as string;
      const previous = index > 0 ? (line[index - 1] as string) : "";
      const following = line[index + em[0].length] ?? "";
      const intraword = /[A-Za-z0-9]/.test(previous) || /[A-Za-z0-9]/.test(following);

      if (delimiter === "*" || !intraword) {
        flush();
        nodes.push(textNode(em[2], [{ type: "em" }]));
        index += em[0].length;
        continue;
      }
    }

    buffer += line[index];
    index += 1;
  }

  flush();
  return nodes;
}

function paragraph(lines: string[]): AdfNode {
  const content: AdfNode[] = [];
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      content.push({ type: "hardBreak" });
    }
    content.push(...parseInline(line));
  });
  return { type: "paragraph", content: content.length > 0 ? content : [textNode("", [])] };
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^```(\w*)\s*$/;

/**
 * Parse a Markdown subset into an ADF document: headings, fenced code blocks,
 * bullet and ordered lists, blockquotes, horizontal rules, and paragraphs with
 * inline marks. Anything unrecognized becomes paragraph text rather than being
 * dropped.
 */
export function textToAdf(input: string): AdfDoc {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const content: AdfNode[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const language = fence[1] ?? "";
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] as string)) {
        code.push(lines[index] as string);
        index += 1;
      }
      index += 1; // closing fence (or end of input)
      const node: AdfNode = {
        type: "codeBlock",
        content: code.length > 0 ? [textNode(code.join("\n"), [])] : [],
      };
      if (language) {
        node.attrs = { language };
      }
      content.push(node);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: parseInline(heading[2]),
      });
      index += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      content.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index] as string);
        if (!match) {
          break;
        }
        quoted.push(match[1] ?? "");
        index += 1;
      }
      content.push({ type: "blockquote", content: [paragraph(quoted)] });
      continue;
    }

    const isBullet = BULLET.test(line) && !/^\s*[-*+]{3,}\s*$/.test(line);
    const isOrdered = ORDERED.test(line);
    if (isBullet || isOrdered) {
      const pattern = isBullet ? BULLET : ORDERED;
      const items: AdfNode[] = [];
      while (index < lines.length) {
        const match = pattern.exec(lines[index] as string);
        if (!match) {
          break;
        }
        items.push({
          type: "listItem",
          content: [paragraph([match[1] ?? ""])],
        });
        index += 1;
      }
      content.push({ type: isBullet ? "bulletList" : "orderedList", content: items });
      continue;
    }

    // Plain paragraph: consecutive non-blank lines that start no other block.
    const buffer: string[] = [];
    while (index < lines.length) {
      const current = lines[index] as string;
      if (
        current.trim().length === 0 ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        QUOTE.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current)
      ) {
        break;
      }
      buffer.push(current);
      index += 1;
    }
    content.push(paragraph(buffer));
  }

  return {
    type: "doc",
    version: 1,
    content: content.length > 0 ? content : [paragraph([""])],
  };
}
