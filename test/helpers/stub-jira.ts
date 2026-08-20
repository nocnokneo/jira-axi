import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decode } from "@toon-format/toon";

/**
 * A stub Jira Cloud API.
 *
 * The CLI talks to this over real HTTP on loopback, so tests exercise the whole
 * path — argv parsing, credential resolution, the client, error translation, and
 * TOON encoding — rather than mocking the layer under test. `normalizeSite()`
 * permits http only for loopback hosts, which is what makes this possible.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export type Handler = (
  request: RecordedRequest,
) => { status?: number; body?: unknown; text?: string } | undefined;

export class StubJira {
  readonly requests: RecordedRequest[] = [];

  private server: Server | undefined;

  private handlers: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];

  private port = 0;

  /**
   * Register a handler. `path` may be a literal or a regex. Most recently
   * registered wins, so a test can override a `baseStub()` default.
   */
  on(method: string, path: string | RegExp, handler: Handler): this {
    const pattern = typeof path === "string" ? new RegExp(`^${escapeRegex(path)}$`) : path;
    this.handlers.unshift({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });

    await new Promise<void>((resolvePromise) => {
      this.server?.listen(0, "127.0.0.1", () => resolvePromise());
    });

    const address = this.server?.address();
    if (address && typeof address === "object") {
      this.port = address.port;
    }
    return this.url;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    });
    this.server = undefined;
  }

  /** Requests recorded for one path, in order. */
  requestsFor(method: string, pathFragment: string): RecordedRequest[] {
    return this.requests.filter(
      (request) => request.method === method.toUpperCase() && request.path.includes(pathFragment),
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request);
    const url = new URL(request.url ?? "/", this.url);

    let body: unknown;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }

    const recorded: RecordedRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body,
      headers: request.headers,
    };
    this.requests.push(recorded);

    for (const entry of this.handlers) {
      if (entry.method !== recorded.method || !entry.pattern.test(recorded.path)) {
        continue;
      }
      const result = entry.handler(recorded);
      if (result === undefined) {
        continue;
      }
      const status = result.status ?? 200;
      if (result.text !== undefined) {
        response.writeHead(status, { "Content-Type": "text/html" });
        response.end(result.text);
        return;
      }
      if (result.body === undefined) {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result.body));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ errorMessages: [`no stub for ${recorded.method} ${recorded.path}`], errors: {} }),
    );
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/* ------------------------------------------------------------------ */
/* CLI harness                                                         */
/* ------------------------------------------------------------------ */

export interface CliResult {
  stdout: string;
  exitCode: number;
  /**
   * `stdout` decoded back from TOON. Asserting on values rather than substrings
   * keeps tests from depending on how the encoder quotes a particular string —
   * a summary containing a comma is emitted quoted, and that is not the
   * behaviour under test.
   */
  data: Record<string, unknown>;
}

/** Decode TOON stdout, tolerating output a command wrote as a plain string. */
export function parseToon(stdout: string): Record<string, unknown> {
  try {
    const decoded = decode(stdout) as unknown;
    return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : { value: decoded };
  } catch {
    return {};
  }
}

/**
 * Run the CLI in-process against a stub, with an isolated config file so tests
 * never read or write the developer's real credentials.
 */
export async function runCli(
  argv: string[],
  options: { site?: string; env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<CliResult> {
  const { run } = await import("../../src/cli.js");

  const chunks: string[] = [];
  const stdout = { write: (chunk: string) => chunks.push(chunk) };

  const configDir = mkdtempSync(join(tmpdir(), "jira-axi-test-"));
  const previous = { ...process.env };
  const previousExitCode = process.exitCode;
  process.exitCode = 0;

  // Clear anything inherited so a developer's own JIRA_* variables cannot leak
  // into a test run.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("JIRA_")) {
      delete process.env[key];
    }
  }
  process.env.JIRA_AXI_CONFIG = join(configDir, "config.json");
  if (options.site) {
    process.env.JIRA_SITE = options.site;
    process.env.JIRA_EMAIL = "tester@example.com";
    process.env.JIRA_API_TOKEN = "test-token";
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run(argv, { stdout, ...(options.now ? { now: options.now } : {}) });
    const output = chunks.join("");
    return { stdout: output, exitCode: process.exitCode ?? 0, data: parseToon(output) };
  } finally {
    process.env = previous;
    process.exitCode = previousExitCode;
    rmSync(configDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

export const MYSELF = {
  accountId: "acct-tester",
  displayName: "Test User",
  emailAddress: "tester@example.com",
};

export function issue(
  key: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const { fields, ...rest } = overrides as { fields?: Record<string, unknown> };
  return {
    id: `id-${key}`,
    key,
    fields: {
      summary: `Summary for ${key}`,
      status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
      assignee: { accountId: "acct-alice", displayName: "Alice Chen" },
      reporter: { accountId: "acct-bob", displayName: "Bob Ray" },
      issuetype: { name: "Task" },
      priority: { name: "Medium" },
      labels: [],
      created: "2026-08-01T09:00:00.000+0000",
      updated: "2026-08-16T09:00:00.000+0000",
      project: { key: key.split("-")[0], name: "Acme" },
      ...fields,
    },
    ...rest,
  };
}

export function adf(text: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** A stub wired with the endpoints nearly every test needs. */
export async function baseStub(): Promise<StubJira> {
  const stub = new StubJira();
  stub.on("GET", "/rest/api/3/myself", () => ({ body: MYSELF }));
  stub.on("POST", "/rest/api/3/search/approximate-count", () => ({ body: { count: 0 } }));
  stub.on("POST", "/rest/api/3/search/jql", () => ({ body: { issues: [], isLast: true } }));
  await stub.start();
  return stub;
}
