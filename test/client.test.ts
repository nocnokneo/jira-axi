import { describe, expect, it } from "vitest";

import { AxiError } from "axi-sdk-js";

import { extractErrorMessage, JiraClient, type FetchLike } from "../src/client.js";
import type { ResolvedConfig } from "../src/config.js";

const CONFIG: ResolvedConfig = {
  site: "https://acme.atlassian.net",
  host: "acme.atlassian.net",
  email: "tester@example.com",
  token: "secret-token",
  source: "env",
};

interface StubResponse {
  status: number;
  statusText?: string;
  body?: string;
}

function stubFetch(response: StubResponse | ((url: string, init: unknown) => StubResponse)): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: string } }>;
} {
  const calls: Array<{
    url: string;
    init: { method: string; headers: Record<string, string>; body?: string };
  }> = [];

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: init as never });
    const result = typeof response === "function" ? response(url, init) : response;
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      statusText: result.statusText,
      headers: { get: () => null },
      text: async () => result.body ?? "",
    };
  };

  return { fetchImpl, calls };
}

function client(response: StubResponse): { jira: JiraClient; calls: ReturnType<typeof stubFetch>["calls"] } {
  const { fetchImpl, calls } = stubFetch(response);
  return { jira: new JiraClient(CONFIG, { fetchImpl }), calls };
}

describe("request", () => {
  it("sends basic auth and a JSON accept header", async () => {
    const { jira, calls } = client({ status: 200, body: '{"ok":true}' });
    await jira.request("/rest/api/3/myself");

    const expected = Buffer.from("tester@example.com:secret-token").toString("base64");
    expect(calls[0]?.init.headers.Authorization).toBe(`Basic ${expected}`);
    expect(calls[0]?.init.headers.Accept).toBe("application/json");
    expect(calls[0]?.url).toBe("https://acme.atlassian.net/rest/api/3/myself");
  });

  it("serializes query parameters and drops empty ones", async () => {
    const { jira, calls } = client({ status: 200, body: "{}" });
    await jira.request("/x", {
      query: { a: "1", b: undefined, c: null, d: "", e: ["p", "q"], f: 3, g: false },
    });

    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.has("b")).toBe(false);
    expect(url.searchParams.has("c")).toBe(false);
    expect(url.searchParams.has("d")).toBe(false);
    expect(url.searchParams.get("e")).toBe("p,q");
    expect(url.searchParams.get("f")).toBe("3");
    expect(url.searchParams.get("g")).toBe("false");
  });

  it("sets a content type only when there is a body", async () => {
    const withBody = client({ status: 200, body: "{}" });
    await withBody.jira.request("/x", { method: "POST", body: { a: 1 } });
    expect(withBody.calls[0]?.init.headers["Content-Type"]).toBe("application/json");
    expect(withBody.calls[0]?.init.body).toBe('{"a":1}');

    const withoutBody = client({ status: 200, body: "{}" });
    await withoutBody.jira.request("/x");
    expect(withoutBody.calls[0]?.init.headers["Content-Type"]).toBeUndefined();
  });

  it("returns undefined for 204 and for an empty body", async () => {
    const noContent = client({ status: 204 });
    await expect(noContent.jira.request("/x", { method: "DELETE" })).resolves.toBeUndefined();

    const empty = client({ status: 200, body: "   " });
    await expect(empty.jira.request("/x")).resolves.toBeUndefined();
  });

  it("returns undefined for a 404 when allow404 is set", async () => {
    const { jira } = client({ status: 404, body: '{"errorMessages":["nope"]}' });
    await expect(jira.request("/x", { allow404: true })).resolves.toBeUndefined();
  });
});

describe("error translation", () => {
  async function failure(response: StubResponse, options = {}): Promise<AxiError> {
    const { jira } = client(response);
    try {
      await jira.request("/x", options);
    } catch (error) {
      return error as AxiError;
    }
    throw new Error("expected the request to fail");
  }

  it("maps 401 to an auth error naming the login command", async () => {
    const error = await failure({ status: 401, body: "{}" });
    expect(error.code).toBe("AUTH_ERROR");
    expect(error.message).toContain("authentication failed for acme.atlassian.net");
    expect(error.suggestions.some((line) => line.includes("auth login"))).toBe(true);
  });

  it("maps 403 to a permission error naming the account", async () => {
    const error = await failure({ status: 403, body: '{"errorMessages":["You do not have permission"]}' });
    expect(error.code).toBe("PERMISSION_ERROR");
    expect(error.message).toContain("You do not have permission");
    expect(error.suggestions[0]).toContain("tester@example.com");
  });

  it("uses the caller's message for a 404", async () => {
    const error = await failure({ status: 404, body: "{}" }, { notFound: "issue ACME-9 not found" });
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("issue ACME-9 not found");
  });

  it("maps 429 to a rate-limit error", async () => {
    const error = await failure({ status: 429, body: "{}" });
    expect(error.code).toBe("RATE_LIMITED");
  });

  it("maps 5xx to a retryable API error", async () => {
    const error = await failure({ status: 503, statusText: "Service Unavailable", body: "" });
    expect(error.code).toBe("API_ERROR");
    expect(error.message).toContain("server error");
  });

  it("extracts a per-field errors map from a 400", async () => {
    const error = await failure({
      status: 400,
      body: '{"errorMessages":[],"errors":{"summary":"Summary is required"}}',
    });
    expect(error.message).toBe("summary: Summary is required");
    expect(error.code).toBe("API_ERROR");
  });

  it("never leaks an HTML error page into the message", async () => {
    const error = await failure({
      status: 502,
      statusText: "Bad Gateway",
      body: "<html><head><title>502</title></head><body>nginx</body></html>",
    });
    expect(error.message).not.toContain("<html>");
    expect(error.message).toContain("HTTP 502 Bad Gateway");
  });

  it("reports a non-JSON success body as a configuration problem", async () => {
    const error = await failure({ status: 200, body: "<html>login page</html>" });
    expect(error.message).toContain("non-JSON response");
    expect(error.message).not.toContain("<html>");
  });

  it("translates a network failure into a reachability error", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND acme.atlassian.net");
    };
    const jira = new JiraClient(CONFIG, { fetchImpl });

    try {
      await jira.request("/x");
      throw new Error("expected the request to fail");
    } catch (error) {
      expect((error as AxiError).code).toBe("API_ERROR");
      expect((error as AxiError).message).toContain("cannot reach acme.atlassian.net");
    }
  });

  it("reports a timeout distinctly from other network failures", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolvePromise, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const jira = new JiraClient(CONFIG, { fetchImpl, timeoutMs: 20 });

    try {
      await jira.request("/x");
      throw new Error("expected the request to fail");
    } catch (error) {
      expect((error as AxiError).message).toContain("timed out after 20ms");
    }
  });

  it("appends caller suggestions to a translated error", async () => {
    const error = await failure({ status: 400, body: '{"errorMessages":["bad jql"]}' }, {
      suggestions: ["The query was: project = NOPE"],
    });
    expect(error.suggestions).toContain("The query was: project = NOPE");
  });
});

describe("extractErrorMessage", () => {
  it("joins errorMessages and the errors map", () => {
    const raw = '{"errorMessages":["first"],"errors":{"field":"second"}}';
    expect(extractErrorMessage(raw, 400)).toBe("first; field: second");
  });

  it("falls back to a bare message field", () => {
    expect(extractErrorMessage('{"message":"nope"}', 400)).toBe("nope");
  });

  it("falls back to the status line for an unparseable body", () => {
    expect(extractErrorMessage("not json", 500, "Server Error")).toBe("HTTP 500 Server Error");
    expect(extractErrorMessage("", 500)).toBe("HTTP 500");
  });

  it("handles an array-shaped error payload", () => {
    expect(extractErrorMessage('[{"errorMessages":["boom"]}]', 400)).toBe("boom");
  });
});
