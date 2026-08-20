import { AxiError } from "axi-sdk-js";

import { BIN } from "./bin-name.js";
import type { ResolvedConfig } from "./config.js";

/**
 * Thin Jira Cloud REST client.
 *
 * Its main job beyond transport is AXI principle 6: never let raw Atlassian
 * payloads reach stdout. Jira reports failures three different ways
 * (`errorMessages`, a per-field `errors` map, and bare HTML from the edge), so
 * every response funnels through one translation step that extracts the
 * actionable sentence and discards the rest.
 */

export type QueryValue = string | number | boolean | undefined | null | Array<string | number>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Message used when Jira answers 404, e.g. "issue ABC-1 does not exist". */
  notFound?: string;
  /** Extra suggestions appended to a translated error. */
  suggestions?: string[];
  /** Treat 404 as an empty result instead of an error. */
  allow404?: boolean;
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
}>;

export interface JiraClientOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        continue;
      }
      params.set(key, value.join(","));
      continue;
    }
    params.set(key, String(value));
  }

  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

interface JiraErrorBody {
  errorMessages?: string[];
  errors?: Record<string, string>;
  message?: string;
  warningMessages?: string[];
}

/** Pull the useful sentence out of whatever shape Jira returned. */
export function extractErrorMessage(raw: string, status: number, statusText?: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      const parsed = JSON.parse(trimmed) as JiraErrorBody | JiraErrorBody[];
      const body = Array.isArray(parsed) ? parsed[0] : parsed;
      if (body) {
        const parts: string[] = [];
        for (const message of body.errorMessages ?? []) {
          if (message.trim().length > 0) {
            parts.push(message.trim());
          }
        }
        for (const [field, message] of Object.entries(body.errors ?? {})) {
          parts.push(`${field}: ${message}`);
        }
        if (parts.length === 0 && typeof body.message === "string" && body.message.trim().length > 0) {
          parts.push(body.message.trim());
        }
        if (parts.length > 0) {
          return parts.join("; ");
        }
      }
    } catch {
      // Fall through to the status-based message.
    }
  }

  // HTML error pages and empty bodies carry no agent-usable signal; the status
  // line is strictly more informative than a wall of markup.
  return statusText && statusText.length > 0 ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
}

export class JiraClient {
  readonly config: ResolvedConfig;

  private readonly fetchImpl: FetchLike;

  private readonly timeoutMs: number;

  private readonly authHeader: string;

  constructor(config: ResolvedConfig, options: JiraClientOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.token}`, "utf-8").toString("base64")}`;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const url = `${this.config.site}${path}${buildQuery(options.query)}`;

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
      "User-Agent": `${BIN}`,
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AxiError(
          `request to ${this.config.host} timed out after ${this.timeoutMs}ms`,
          "API_ERROR",
          ["Retry the command, or narrow the query with --limit"],
        );
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new AxiError(`cannot reach ${this.config.host}: ${detail}`, "API_ERROR", [
        `Check that ${this.config.host} is the right Jira site and that the network allows it`,
        `${BIN} auth status`,
      ]);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const raw = await response.text();

    if (!response.ok) {
      if (response.status === 404 && options.allow404) {
        return undefined as T;
      }
      throw this.translate(response.status, response.statusText, raw, options);
    }

    if (raw.trim().length === 0) {
      return undefined as T;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new AxiError(`${this.config.host} returned a non-JSON response`, "API_ERROR", [
        "This usually means the site URL points at something other than a Jira Cloud REST API",
        `${BIN} auth status`,
      ]);
    }
  }

  private translate(
    status: number,
    statusText: string | undefined,
    raw: string,
    options: RequestOptions,
  ): AxiError {
    const detail = extractErrorMessage(raw, status, statusText);
    const extra = options.suggestions ?? [];

    if (status === 401) {
      return new AxiError(`authentication failed for ${this.config.host}`, "AUTH_ERROR", [
        "The email or API token is wrong, or the token was revoked",
        `${BIN} auth login --site ${this.config.host} --email <email> --token <api-token>`,
        ...extra,
      ]);
    }

    if (status === 403) {
      return new AxiError(`not permitted: ${detail}`, "PERMISSION_ERROR", [
        `The account ${this.config.email} lacks permission for this operation on ${this.config.host}`,
        ...extra,
      ]);
    }

    if (status === 404) {
      return new AxiError(options.notFound ?? `not found: ${detail}`, "NOT_FOUND", extra);
    }

    if (status === 429) {
      return new AxiError(`rate limited by ${this.config.host}`, "RATE_LIMITED", [
        "Wait and retry; Jira Cloud throttles bursts of requests",
        ...extra,
      ]);
    }

    if (status >= 500) {
      return new AxiError(`${this.config.host} returned a server error: ${detail}`, "API_ERROR", [
        "This is a Jira-side failure; retry shortly",
        ...extra,
      ]);
    }

    return new AxiError(detail, "API_ERROR", extra);
  }
}
