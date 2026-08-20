import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMMANDS } from "../src/guidance.js";

const ROOT = join(import.meta.dirname, "..");
const SKILL_PATH = join(ROOT, "skills", "jira-axi", "SKILL.md");

describe("generated skill", () => {
  const skill = readFileSync(SKILL_PATH, "utf-8");

  it("is not stale relative to the guidance module", () => {
    // Principle 7: the skill is generated from the same content the CLI prints,
    // so a change to one has to regenerate the other.
    const output = execFileSync("npx", ["tsx", join(ROOT, "scripts", "build-skill.ts"), "--check"], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(output).toContain("skill is up to date");
  });

  it("carries trigger-shaped frontmatter", () => {
    expect(skill.startsWith("---\nname: jira-axi\n")).toBe(true);
    expect(skill).toMatch(/description: >/);
    // The description has to fire on the intents an agent will actually see.
    expect(skill).toContain("Jira");
    expect(skill).toMatch(/issue key like ACME-123/);
  });

  it("documents every command the CLI exposes", () => {
    for (const [name] of COMMANDS) {
      expect(skill, `missing ${name}`).toContain(`| \`${name}\` |`);
    }
  });

  it("uses npx so the examples run without a global install", () => {
    const commandLines = skill.split("\n").filter((line) => line.includes("jira-axi ") && line.includes("`"));
    expect(commandLines.length).toBeGreaterThan(5);
    for (const line of commandLines) {
      // Every runnable example must be prefixed; a bare `jira-axi ...` would
      // fail for a user who installed only the skill.
      expect(line, line).not.toMatch(/`jira-axi /);
    }
  });

  it("omits live state, since a skill is static", () => {
    expect(skill).not.toMatch(/ACME-1,/);
    expect(skill).not.toContain("count:");
  });
});
