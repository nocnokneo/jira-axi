import { describe, expect, it } from "vitest";

import { AxiError } from "axi-sdk-js";

import { bool, list, num, parseArgs, requireStr, str, type FlagSpec } from "../src/flags.js";

const SPEC: FlagSpec = {
  project: { type: "string", short: "-p", placeholder: "<key>", describe: "Project" },
  label: { type: "string", short: "-l", repeatable: true, placeholder: "<label>", describe: "Label" },
  limit: { type: "number", placeholder: "<n>", default: 30, describe: "Limit" },
  full: { type: "boolean", describe: "Full output" },
  state: { type: "string", placeholder: "<state>", describe: "State" },
};

function parse(args: string[]) {
  return parseArgs(args, { command: "issue list", spec: SPEC });
}

describe("parseArgs", () => {
  it("parses long flags in both space and equals form", () => {
    expect(str(parse(["--project", "ACME"]), "project")).toBe("ACME");
    expect(str(parse(["--project=ACME"]), "project")).toBe("ACME");
  });

  it("parses short aliases", () => {
    expect(str(parse(["-p", "ACME"]), "project")).toBe("ACME");
    expect(str(parse(["-p=ACME"]), "project")).toBe("ACME");
  });

  it("collects repeatable flags into an array", () => {
    expect(list(parse(["-l", "bug", "--label", "regression"]), "label")).toEqual(["bug", "regression"]);
  });

  it("coerces numbers and applies caller defaults", () => {
    expect(num(parse(["--limit", "5"]), "limit", 30)).toBe(5);
    expect(num(parse([]), "limit", 30)).toBe(30);
  });

  it("treats boolean flags as switches", () => {
    expect(bool(parse(["--full"]), "full")).toBe(true);
    expect(bool(parse([]), "full")).toBe(false);
  });

  it("collects positionals", () => {
    const parsed = parseArgs(["ACME-1", "--full"], {
      command: "issue view",
      spec: SPEC,
      positionals: { name: "<key>", min: 1, max: 1 },
    });
    expect(parsed.positionals).toEqual(["ACME-1"]);
  });

  it("allows the global --site and --account flags on every command", () => {
    const parsed = parse(["--site", "acme", "--account", "work"]);
    expect(str(parsed, "site")).toBe("acme");
    expect(str(parsed, "account")).toBe("work");
  });

  it("tolerates a stray --help so it never reads as an unknown flag", () => {
    expect(() => parse(["--help"])).not.toThrow();
  });
});

describe("fail-loud validation", () => {
  it("rejects an unknown long flag and names the valid ones", () => {
    let error: AxiError | undefined;
    try {
      parse(["--stat", "closed"]);
    } catch (thrown) {
      error = thrown as AxiError;
    }

    expect(error?.message).toBe("unknown flag --stat for `issue list`");
    expect(error?.code).toBe("VALIDATION_ERROR");
    // Principle 6: the error carries the flag list so the fix takes one turn,
    // not a follow-up `--help` call.
    expect(error?.suggestions[0]).toContain("--project");
    expect(error?.suggestions[0]).toContain("(--help always allowed)");
  });

  it("rejects an unknown short flag", () => {
    expect(() => parse(["-z", "1"])).toThrow(/unknown flag -z for `issue list`/);
  });

  it("points a renamed flag at its replacement instead of the generic list", () => {
    let error: AxiError | undefined;
    try {
      parse(["--status", "Done"]);
    } catch (thrown) {
      error = thrown as AxiError;
    }

    expect(error?.suggestions[0]).toBe("--status was renamed; use --state instead");
  });

  it("refuses a missing flag value rather than consuming the next flag", () => {
    expect(() => parse(["--project", "--full"])).toThrow(/--project requires a value/);
    expect(() => parse(["--project"])).toThrow(/--project requires a value/);
  });

  it("refuses an empty value", () => {
    expect(() => parse(["--project="])).toThrow(/--project was passed an empty value/);
    expect(() => parse(["--label="])).toThrow(/--label was passed an empty value/);
  });

  it("refuses a value on a boolean switch", () => {
    expect(() => parse(["--full=yes"])).toThrow(/--full is a switch and takes no value/);
  });

  it("refuses a repeated single-value flag", () => {
    expect(() => parse(["-p", "A", "-p", "B"])).toThrow(/--project was passed more than once/);
  });

  it("refuses a non-numeric value for a number flag", () => {
    expect(() => parse(["--limit", "many"])).toThrow(/--limit must be a number, got `many`/);
  });

  it("refuses unexpected positionals", () => {
    expect(() => parse(["ACME-1"])).toThrow(/`issue list` takes no positional arguments/);
  });

  it("refuses too many positionals", () => {
    expect(() =>
      parseArgs(["ACME-1", "ACME-2"], {
        command: "issue view",
        spec: SPEC,
        positionals: { name: "<key>", min: 1, max: 1 },
      }),
    ).toThrow(/takes at most 1 positional argument/);
  });

  it("reports a missing required positional", () => {
    expect(() =>
      parseArgs([], { command: "issue view", spec: SPEC, positionals: { name: "<key>", min: 1, max: 1 } }),
    ).toThrow(/<key> is required/);
  });

  it("reports a missing required flag", () => {
    expect(() => requireStr(parse([]), "project", "issue create")).toThrow(/--project is required/);
  });
});
