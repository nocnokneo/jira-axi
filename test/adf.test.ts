import { describe, expect, it } from "vitest";

import { adfToText, textToAdf, type AdfNode } from "../src/adf.js";

describe("adfToText", () => {
  it("flattens paragraphs with a blank line between them", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First." }] },
        { type: "paragraph", content: [{ type: "text", text: "Second." }] },
      ],
    };
    expect(adfToText(doc)).toBe("First.\n\nSecond.");
  });

  it("renders inline marks as Markdown", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "text", text: " and " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
            { type: "text", text: " and " },
            { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://x.test" } }] },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("**bold** and `code` and [link](https://x.test)");
  });

  it("renders hard breaks inside a paragraph", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "one" }, { type: "hardBreak" }, { type: "text", text: "two" }],
        },
      ],
    };
    expect(adfToText(doc)).toBe("one\ntwo");
  });

  it("renders headings, lists, code blocks, quotes, and rules", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] },
          ],
        },
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "step" }] }] },
          ],
        },
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = 1;" }] },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }],
        },
        { type: "rule" },
      ],
    };

    expect(adfToText(doc)).toBe(
      ["## Steps", "", "- first", "- second", "", "1. step", "", "```ts", "const a = 1;", "```", "", "> quoted", "", "---"].join(
        "\n",
      ),
    );
  });

  it("renders mentions, status, dates, and media placeholders", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { text: "Alice" } },
            { type: "text", text: " " },
            { type: "status", attrs: { text: "BLOCKED" } },
            { type: "text", text: " " },
            { type: "inlineCard", attrs: { url: "https://x.test/1" } },
          ],
        },
        { type: "mediaSingle", content: [{ type: "media", attrs: { alt: "screenshot.png" } }] },
      ],
    };
    expect(adfToText(doc)).toBe("@Alice [BLOCKED] https://x.test/1\n\n[media: screenshot.png]");
  });

  it("renders table rows", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("| a | b |");
  });

  it("surfaces text from unknown node types instead of dropping it", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        { type: "someFutureBlock", content: [{ type: "paragraph", content: [{ type: "text", text: "kept" }] }] },
      ],
    };
    expect(adfToText(doc)).toBe("kept");
  });

  it("passes through plain strings and empty values", () => {
    expect(adfToText("already text")).toBe("already text");
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
  });
});

describe("textToAdf", () => {
  it("splits blank-line-separated paragraphs", () => {
    const doc = textToAdf("First.\n\nSecond.");
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0]?.type).toBe("paragraph");
  });

  it("keeps consecutive lines in one paragraph as hard breaks", () => {
    const doc = textToAdf("one\ntwo");
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]?.content?.map((node) => node.type)).toEqual(["text", "hardBreak", "text"]);
  });

  it("parses inline marks", () => {
    const [paragraph] = textToAdf("**bold** _em_ `code` [t](https://x.test)").content;
    const marks = (paragraph?.content ?? [])
      .filter((node) => node.marks)
      .map((node) => node.marks?.[0]?.type);
    expect(marks).toEqual(["strong", "em", "code", "link"]);
  });

  it("does not treat snake_case or spaced asterisks as emphasis", () => {
    const [paragraph] = textToAdf("some_field_name and a * b").content;
    expect(paragraph?.content?.every((node) => !node.marks)).toBe(true);
    expect(paragraph?.content?.map((node) => node.text).join("")).toBe("some_field_name and a * b");
  });

  it("keeps Markdown inside a code span literal", () => {
    const [paragraph] = textToAdf("`**not bold**`").content;
    expect(paragraph?.content?.[0]?.text).toBe("**not bold**");
    expect(paragraph?.content?.[0]?.marks?.[0]?.type).toBe("code");
  });

  it("parses fenced code blocks with a language", () => {
    const [block] = textToAdf("```ts\nconst a = 1;\nconst b = 2;\n```").content;
    expect(block?.type).toBe("codeBlock");
    expect(block?.attrs?.language).toBe("ts");
    expect(block?.content?.[0]?.text).toBe("const a = 1;\nconst b = 2;");
  });

  it("parses headings, lists, quotes, and rules", () => {
    const doc = textToAdf("# Title\n\n- one\n- two\n\n1. first\n\n> quoted\n\n---");
    expect(doc.content.map((node) => node.type)).toEqual([
      "heading",
      "bulletList",
      "orderedList",
      "blockquote",
      "rule",
    ]);
    expect(doc.content[0]?.attrs?.level).toBe(1);
    expect(doc.content[1]?.content).toHaveLength(2);
  });

  it("always produces a valid doc, even for empty input", () => {
    const doc = textToAdf("");
    expect(doc.type).toBe("doc");
    expect(doc.version).toBe(1);
    expect(doc.content.length).toBeGreaterThan(0);
  });

  it("round-trips text through ADF and back", () => {
    const original = ["# Title", "", "Body with **bold** and `code`.", "", "- one", "- two"].join("\n");
    expect(adfToText(textToAdf(original) as unknown as AdfNode)).toBe(original);
  });
});
