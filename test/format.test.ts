import { describe, expect, it } from "vitest";

import {
  countLine,
  formatSeconds,
  issueRow,
  previewField,
  relativeAge,
  resolveFields,
  shortTimestamp,
  simplifyValue,
  truncate,
  userLabel,
} from "../src/format.js";
import { jiraDateTimestamp } from "../src/input.js";
import { issue } from "./helpers/stub-jira.js";
import type { JiraIssue } from "../src/format.js";

const NOW = new Date("2026-08-19T09:00:00.000Z");

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("short", 100)).toEqual({ text: "short", truncated: false, total: 5 });
  });

  it("truncates and reports the full size", () => {
    const result = truncate("x".repeat(500), 100);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(500);
    expect(result.text.endsWith("...")).toBe(true);
  });

  it("prefers a sentence boundary near the limit", () => {
    // Cuts at the sentence break rather than mid-word 100 characters in.
    const text = `${"a".repeat(80)}. ${"b".repeat(80)}`;
    const result = truncate(text, 100);
    expect(result.text).toBe(`${"a".repeat(80)}...`);
    expect(result.total).toBe(162);
  });
});

describe("previewField", () => {
  it("returns undefined for empty content", () => {
    expect(previewField(null, false)).toBeUndefined();
    expect(previewField({ type: "doc", content: [] }, false)).toBeUndefined();
  });

  it("reports the true size so the caller can offer --full", () => {
    const long = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "y".repeat(2000) }] }] };
    expect(previewField(long, false)).toMatchObject({ truncated: true, total: 2000 });
    // --full returns everything, so there is nothing to offer.
    expect(previewField(long, true)).toMatchObject({ truncated: false, total: 2000 });

    const short = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "brief" }] }] };
    expect(previewField(short, false)).toEqual({ value: "brief", truncated: false, total: 5 });
  });
});

describe("relativeAge", () => {
  it("scales the unit with the distance", () => {
    expect(relativeAge("2026-08-19T08:59:30.000Z", NOW)).toBe("30s");
    expect(relativeAge("2026-08-19T08:30:00.000Z", NOW)).toBe("30m");
    expect(relativeAge("2026-08-19T04:00:00.000Z", NOW)).toBe("5h");
    expect(relativeAge("2026-08-16T09:00:00.000Z", NOW)).toBe("3d");
    expect(relativeAge("2026-06-19T09:00:00.000Z", NOW)).toBe("2mo");
    expect(relativeAge("2024-08-19T09:00:00.000Z", NOW)).toBe("2y");
  });

  it("returns undefined for missing or unparseable input", () => {
    expect(relativeAge(undefined, NOW)).toBeUndefined();
    expect(relativeAge("not a date", NOW)).toBeUndefined();
  });
});

describe("shortTimestamp", () => {
  it("trims to minute precision", () => {
    expect(shortTimestamp("2026-08-01T09:12:45.000+0000")).toBe("2026-08-01 09:12");
    expect(shortTimestamp(undefined)).toBeUndefined();
  });
});

describe("formatSeconds", () => {
  it("picks a readable unit and ignores zero", () => {
    expect(formatSeconds(1800)).toBe("30m");
    expect(formatSeconds(7200)).toBe("2h");
    expect(formatSeconds(28_800)).toBe("1d");
    expect(formatSeconds(0)).toBeUndefined();
    expect(formatSeconds(undefined)).toBeUndefined();
  });
});

describe("userLabel", () => {
  it("prefers a display name and calls out an absent user", () => {
    expect(userLabel({ displayName: "Alice Chen" })).toBe("Alice Chen");
    expect(userLabel({ emailAddress: "a@b.com" })).toBe("a@b.com");
    expect(userLabel({ accountId: "acct-1" })).toBe("acct-1");
    expect(userLabel(null)).toBe("unassigned");
    expect(userLabel(undefined)).toBe("unassigned");
  });
});

describe("issueRow", () => {
  it("defaults to exactly four columns", () => {
    const row = issueRow(issue("ACME-1") as JiraIssue, [], NOW);
    expect(Object.keys(row)).toEqual(["key", "summary", "status", "assignee"]);
  });

  it("appends requested extras in order", () => {
    const row = issueRow(issue("ACME-1") as JiraIssue, ["type", "priority", "updated"], NOW);
    expect(Object.keys(row)).toEqual([
      "key",
      "summary",
      "status",
      "assignee",
      "type",
      "priority",
      "updated",
    ]);
    expect(row.type).toBe("Task");
    expect(row.updated).toBe("3d");
  });

  it("treats an unrecognized field name as a raw API field id", () => {
    const withCustom = issue("ACME-1", { fields: { customfield_10016: 5 } }) as JiraIssue;
    expect(issueRow(withCustom, ["customfield_10016"], NOW).customfield_10016).toBe(5);
  });

  it("renders an unassigned issue rather than omitting the column", () => {
    const unassigned = issue("ACME-1", { fields: { assignee: null } }) as JiraIssue;
    expect(issueRow(unassigned, [], NOW).assignee).toBe("unassigned");
  });
});

describe("resolveFields", () => {
  it("always requests the default API fields", () => {
    const { api, extras } = resolveFields([]);
    expect(api).toContain("summary");
    expect(api).toContain("status");
    expect(extras).toEqual([]);
  });

  it("adds the API fields a named extra needs", () => {
    const { api, extras } = resolveFields(["labels"]);
    expect(api).toContain("labels");
    expect(extras).toEqual(["labels"]);
  });

  it("splits comma-separated values and de-duplicates", () => {
    const { extras } = resolveFields(["type,priority", "type"]);
    expect(extras).toEqual(["type", "priority"]);
  });

  it("passes an unknown name through as an API field id", () => {
    const { api, extras } = resolveFields(["customfield_10016"]);
    expect(api).toContain("customfield_10016");
    expect(extras).toEqual(["customfield_10016"]);
  });
});

describe("simplifyValue", () => {
  it("collapses objects and arrays to one cell", () => {
    expect(simplifyValue({ name: "High" })).toBe("High");
    expect(simplifyValue({ value: "Team A" })).toBe("Team A");
    expect(simplifyValue([{ name: "a" }, { name: "b" }])).toBe("a b");
    expect(simplifyValue(null)).toBe("none");
    expect(simplifyValue(5)).toBe(5);
  });
});

describe("countLine", () => {
  it("reports the page against the total", () => {
    expect(countLine(12, 340)).toBe("12 of 340 total");
    expect(countLine(5, 5)).toBe("5 of 5 total");
  });

  it("drops a total it cannot trust", () => {
    // Jira's approximate count lags fresh writes, so a total below the page we
    // are showing is wrong; say only what is certain.
    expect(countLine(10, 3)).toBe("showing 10");
    expect(countLine(10, undefined)).toBe("showing 10");
  });
});

describe("jiraDateTimestamp", () => {
  it("anchors a calendar date at midday with the machine's real offset", () => {
    const stamp = jiraDateTimestamp("2026-08-18");

    // The date must survive verbatim: a hardcoded UTC time used to shift the
    // worklog onto the adjacent day for offsets at or below -10.
    expect(stamp.startsWith("2026-08-18T12:00:00.000")).toBe(true);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T12:00:00\.000[+-]\d{4}$/);
  });

  it("resolves to midday local on the requested date in any timezone", () => {
    for (const zone of ["UTC", "Pacific/Honolulu", "Pacific/Kiritimati", "America/New_York", "Asia/Kolkata"]) {
      const previous = process.env.TZ;
      process.env.TZ = zone;
      try {
        const stamp = jiraDateTimestamp("2026-08-18");
        const instant = new Date(stamp);
        expect(Number.isFinite(instant.getTime()), `${zone}: ${stamp}`).toBe(true);
        // Read the instant back in the same zone: it must still be the 18th.
        const local = new Intl.DateTimeFormat("en-CA", {
          timeZone: zone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(instant);
        expect(local, `${zone}: ${stamp}`).toBe("2026-08-18");
      } finally {
        process.env.TZ = previous;
      }
    }
  });

  it("handles a half-hour offset zone", () => {
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      expect(jiraDateTimestamp("2026-08-18")).toBe("2026-08-18T12:00:00.000+0530");
    } finally {
      process.env.TZ = previous;
    }
  });
});
