/**
 * Leaf module: imports node builtins only.
 *
 * `bin/jira-axi.ts` reads `VERSION` from here to answer `--version` before the
 * command graph is dynamically imported (AXI principle 10). Adding any import
 * that reaches into `cli.ts` would pull the whole graph back into that path and
 * silently undo the fast path, so keep this file dependency-free.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  // Walk up to the nearest named package.json. Works from both `src/` (tsx dev
  // runs) and `dist/` (published installs).
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf-8");
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (typeof parsed.name === "string" && parsed.name.length > 0) {
        return parsed.version ?? "0.0.0";
      }
    } catch {
      // Not this directory; keep walking.
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return "0.0.0";
}

export const VERSION = readVersion();
