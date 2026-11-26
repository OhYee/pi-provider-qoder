import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const patEnvNames = [
  "QODER_API_KEY",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODERCN_API_KEY",
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODERCN_PAT",
] as const;
const originalPats = Object.fromEntries(patEnvNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of patEnvNames) {
    const value = originalPats[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
  vi.doUnmock("@earendil-works/pi-ai/compat");
  vi.doUnmock("../protocol/stream.js");
  vi.resetModules();
});

/**
 * Keep the startup catalog refresh off the real network. With stored
 * credentials on disk and a stale cache, registerProviders fetches Qoder's
 * catalog; in a sandbox without direct egress that fetch hangs until the
 * test times out, and the late completion then pollutes the next test's
 * registration counts. A failing response makes the refresh return early
 * (registerProviders already tolerates refresh failures).
 */
function stubNetworkFailure(): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
}

// Registration imports the full pi-ai compat layer; under parallel workers
// that can push these tests past vitest's 5s default, and a timeout here
// also lets the late registration pollute the next test's registry counts.
// Give this file room.
vi.setConfig({ testTimeout: 30_000 });

function liteModel(provider: "qoder" | "qoder-cn") {
  return {
    id: "Lite",
    name: "Lite",
    api: "qoder-api",
    provider,
    baseUrl: provider === "qoder-cn" ? "https://gateway.qoder.com.cn/" : "https://api3.qoder.sh/",
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 131072,
  };
}

describe("provider region binding", () => {
  it("binds qoder to global and qoder-cn to CN", async () => {
    for (const name of patEnvNames) delete process.env[name];
    stubNetworkFailure();
    const providers = new Map<string, Record<string, unknown>>();
    const pi = {
      registerProvider(providerID: string, config: Record<string, unknown>) {
        providers.set(providerID, config);
      },
      on: vi.fn(),
    };

    const { default: registerProviders } = await import("../index.js");
    await registerProviders(pi as never);

    expect(providers.get("qoder")?.baseUrl).toBe("https://api3.qoder.sh/");
    expect(providers.get("qoder-cn")?.baseUrl).toBe("https://gateway.qoder.com.cn/");

    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            userQuota: { total: 100, used: 1, remaining: 99, percentage: 1, unit: "requests" },
            orgResourcePackage: { total: 0, used: 0, remaining: 0, percentage: 0, unit: "requests" },
            totalUsagePercentage: 1,
            isQuotaExceeded: false,
            expiresAt: Date.now() + 3600_000,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const credentials: OAuthCredentials = { access: "test-token", refresh: "", expires: Date.now() + 3600_000 };
    const globalOAuth = providers.get("qoder")?.oauth as {
      fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
    };
    const cnOAuth = providers.get("qoder-cn")?.oauth as {
      fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
    };

    await globalOAuth.fetchUsage(credentials);
    expect(fetchMock).toHaveBeenLastCalledWith("https://openapi.qoder.sh/api/v2/quota/usage", expect.any(Object));

    await cnOAuth.fetchUsage(credentials);
    expect(fetchMock).toHaveBeenLastCalledWith("https://openapi.qoder.com.cn/api/v2/quota/usage", expect.any(Object));
  });
});

describe("qoder-api registry", () => {
  it("registers qoder-api so global streamSimple works for both regions", async () => {
    for (const name of patEnvNames) delete process.env[name];
    stubNetworkFailure();

    const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/compat")>("@earendil-works/pi-ai/compat");
    const registerSpy = vi.fn((...args: Parameters<typeof actual.registerApiProvider>) => {
      return actual.registerApiProvider(...args);
    });
    vi.doMock("@earendil-works/pi-ai/compat", () => ({
      ...actual,
      registerApiProvider: registerSpy,
    }));

    const { getApiProvider, streamSimple, unregisterApiProviders } = await import("@earendil-works/pi-ai/compat");
    const { default: registerProviders } = await import("../index.js");
    // Node caches node_modules ESM, so a prior test in this file may already
    // have registered qoder-api. Drop that entry before asserting the empty state.
    unregisterApiProviders("provider:qoder");
    const emptyContext = { systemPrompt: "", messages: [] };

    expect(getApiProvider("qoder-api")).toBeUndefined();
    expect(() => streamSimple(liteModel("qoder") as never, emptyContext)).toThrow(
      /No API provider registered for api: qoder-api/,
    );

    const providers = new Map<string, Record<string, unknown>>();
    const registerProvider = vi.fn((providerID: string, config: Record<string, unknown>) => {
      providers.set(providerID, config);
    });
    const pi = {
      registerProvider,
      on: vi.fn(),
    };

    await registerProviders(pi as never);

    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledTimes(2);
    expect(providers.has("qoder")).toBe(true);
    expect(providers.has("qoder-cn")).toBe(true);
    expect(providers.get("qoder")?.api).toBe("qoder-api");
    expect(providers.get("qoder-cn")?.api).toBe("qoder-api");
    expect(typeof providers.get("qoder")?.streamSimple).toBe("function");
    expect(typeof providers.get("qoder-cn")?.streamSimple).toBe("function");
    // OMP's API registry is shared by both provider registrations.
    expect(providers.get("qoder")?.streamSimple).toBe(providers.get("qoder-cn")?.streamSimple);
    expect(registerSpy.mock.calls[0][0].streamSimple).toBe(providers.get("qoder")?.streamSimple);

    expect(getApiProvider("qoder-api")).toBeDefined();
    expect(() => streamSimple(liteModel("qoder") as never, emptyContext)).not.toThrow(
      /No API provider registered for api: qoder-api/,
    );
    expect(() => streamSimple(liteModel("qoder-cn") as never, emptyContext)).not.toThrow(
      /No API provider registered for api: qoder-api/,
    );
  });

  it("still registers providers when registerApiProvider is absent (OMP-style)", async () => {
    for (const name of patEnvNames) delete process.env[name];
    stubNetworkFailure();

    vi.doMock("@earendil-works/pi-ai/compat", () => ({
      // OMP bundled pi-ai/compat does not export registerApiProvider.
    }));

    const { default: registerProviders } = await import("../index.js");

    const providers = new Map<string, Record<string, unknown>>();
    const registerProvider = vi.fn((providerID: string, config: Record<string, unknown>) => {
      providers.set(providerID, config);
    });
    const pi = {
      registerProvider,
      on: vi.fn(),
    };

    await expect(registerProviders(pi as never)).resolves.toBeUndefined();

    expect(registerProvider).toHaveBeenCalledTimes(2);
    expect(providers.has("qoder")).toBe(true);
    expect(providers.has("qoder-cn")).toBe(true);
    expect(providers.get("qoder")?.api).toBe("qoder-api");
    expect(providers.get("qoder-cn")?.api).toBe("qoder-api");
    expect(typeof providers.get("qoder")?.streamSimple).toBe("function");
    expect(typeof providers.get("qoder-cn")?.streamSimple).toBe("function");
  });
});

describe("shared provider recovery dispatch", () => {
  it("uses each request model's provider even when OMP keeps the last API registration", async () => {
    for (const name of patEnvNames) delete process.env[name];
    stubNetworkFailure();
    vi.doMock("../protocol/stream.js", () => ({
      streamQoder: (
        model: { provider: string },
        _context: unknown,
        options: { apiKey: string; credentialId: number },
        renew: (provider: string, access: string, id: number) => Promise<{ accessToken: string }>,
      ) => renew(model.provider, options.apiKey, options.credentialId),
    }));
    const providers = new Map<string, Record<string, unknown>>();
    const handlers = new Map<string, Array<(event: unknown, context: unknown) => Promise<void>>>();
    const pi = {
      registerProvider(provider: string, config: Record<string, unknown>) {
        providers.set(provider, config);
      },
      on(event: string, handler: (event: unknown, context: unknown) => Promise<void>) {
        const existing = handlers.get(event) ?? [];
        existing.push(handler);
        handlers.set(event, existing);
      },
    };
    const credentials: Record<string, { type: string; access: string; userID: string; expires: number }> = {
      qoder: { type: "oauth", access: "qoder-old", userID: "global-user", expires: 1 },
      "qoder-cn": { type: "oauth", access: "qoder-cn-old", userID: "cn-user", expires: 1 },
    };
    const accessById = vi.fn(async (provider: string, id: number) => {
      const accessToken = `${provider}-${id}-new`;
      credentials[provider].access = accessToken;
      return { ok: true, accessToken, apiKey: accessToken };
    });
    const authStorage = {
      credentials: {
        list: (provider: string) => [
          {
            id: provider === "qoder" ? 1 : 2,
            provider,
            credential: credentials[provider],
          },
        ],
      },
      oauth: { accessById },
    };
    // Load after vi.doMock so registration uses the observable stream seam.
    const { default: registerProviders } = await import("../index.js");
    await registerProviders(pi as never);
    await handlers.get("session_start")?.[0](
      {},
      {
        modelRegistry: { authStorage, getApiKeyForProvider: vi.fn().mockResolvedValue(undefined) },
      },
    );
    const dispatch = providers.get("qoder-cn")?.streamSimple as (
      model: { provider: string },
      context: unknown,
      options: { apiKey: string; credentialId: number },
    ) => Promise<{ accessToken: string }>;
    await expect(dispatch({ provider: "qoder" }, {}, { apiKey: "qoder-old", credentialId: 1 })).resolves.toMatchObject({
      accessToken: "qoder-1-new",
      userID: "global-user",
    });
    await expect(
      dispatch({ provider: "qoder-cn" }, {}, { apiKey: "qoder-cn-old", credentialId: 2 }),
    ).resolves.toMatchObject({ accessToken: "qoder-cn-2-new", userID: "cn-user" });
    expect(accessById.mock.calls.map(([provider, id]) => [provider, id])).toEqual([
      ["qoder", 1],
      ["qoder-cn", 2],
    ]);
  });
});
