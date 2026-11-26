import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQoderModelsMemCache, getCachedModels, staticCnModels, staticModels } from "../catalog.js";
import { clearCosyVersionMemCache } from "../cosy-version.js";
import initExtension, { refreshQoderModelsForMode } from "../index.js";
import { getQoderRegionConfig, QODER_MODES } from "../region.js";

function testHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

const CACHE_PATH = join(testHome(), ".pi", "agent", "qoder-models-cache.json");
const COSY_CACHE_PATH = join(testHome(), ".pi", "agent", "qoder-cosy-version-cache.json");

const OAUTH_CREDENTIAL = {
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 3600000,
  userID: "user-id",
  email: "test@example.com",
  name: "Test User",
  machineID: "machine-id",
} as unknown as RefreshModelsContext["credential"];

function refreshContext(allowNetwork: boolean, credential?: RefreshModelsContext["credential"]): RefreshModelsContext {
  return {
    allowNetwork,
    credential,
    publish: async () => true,
    signal: new AbortController().signal,
  } as RefreshModelsContext;
}

/** Catalog fetch stub: COSY refresh gets an empty release list, the model list gets `chat`. */
function stubCatalogFetch(chat: unknown[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) =>
    String(url).includes("repo.qoder.com")
      ? new Response("[]", { status: 200 })
      : new Response(JSON.stringify({ chat }), { status: 200 }),
  );
}

beforeEach(() => {
  // 这些覆盖路径优先于 HOME，必须一并限制在测试目录内。
  vi.stubEnv("PI_CODING_AGENT_DIR", join(testHome(), ".pi", "agent"));
  vi.stubEnv("QODER_ENDPOINTS_CACHE_PATH", undefined);
  clearQoderModelsMemCache();
  clearCosyVersionMemCache();
  rmSync(CACHE_PATH, { force: true });
  rmSync(COSY_CACHE_PATH, { force: true });
  clearQoderModelsMemCache();
  clearCosyVersionMemCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(CACHE_PATH, { force: true });
  rmSync(COSY_CACHE_PATH, { force: true });
  clearQoderModelsMemCache();
  clearCosyVersionMemCache();
  vi.unstubAllEnvs();
});

describe("refreshQoderModelsForMode", () => {
  it("online refresh fetches the live catalog and returns it instead of the static list", async () => {
    vi.stubGlobal(
      "fetch",
      stubCatalogFetch([
        { key: "lite", enable: true, display_name: "Lite" },
        { key: "ultimate", enable: true, display_name: "Ultimate", is_reasoning: true },
      ]),
    );

    const models = await refreshQoderModelsForMode("global", refreshContext(true, OAUTH_CREDENTIAL));

    expect(models.map((model) => model.id)).toEqual(["Lite", "Ultimate"]);
    // The fetched catalog is also persisted, so the next offline read agrees.
    expect(getCachedModels("global").map((model) => model.id)).toEqual(["Lite", "Ultimate"]);
    expect(existsSync(CACHE_PATH)).toBe(true);
  });

  it("offline refresh returns the cached list without fetching", async () => {
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({
        updatedAt: Date.now(),
        models: [{ id: "Lite", name: "Lite" }],
        configs: { Lite: { key: "lite", enable: true, display_name: "Lite" } },
      }),
      "utf8",
    );
    clearQoderModelsMemCache();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network must not be used"));
    vi.stubGlobal("fetch", fetchMock);

    const models = await refreshQoderModelsForMode("global", refreshContext(false, OAUTH_CREDENTIAL));

    expect(models.map((model) => model.id)).toEqual(["Lite"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("online refresh without a credential falls back to the static list without fetching", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network must not be used"));
    vi.stubGlobal("fetch", fetchMock);

    const models = await refreshQoderModelsForMode("global", refreshContext(true));

    expect(models.map((model) => model.id)).toEqual(staticModels.map((model) => model.id));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("online refresh with a credential but a failed fetch keeps the static list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        String(url).includes("repo.qoder.com")
          ? new Response("[]", { status: 200 })
          : new Response("error", { status: 500 }),
      ),
    );

    const models = await refreshQoderModelsForMode("global", refreshContext(true, OAUTH_CREDENTIAL));

    expect(models.map((model) => model.id)).toEqual(staticModels.map((model) => model.id));
  });
});

describe("provider registration", () => {
  it("registers a refreshModels hook so the host refreshes qoder after login", async () => {
    // 启动会用环境令牌自动登录；此处只验证无凭证时的静态注册。
    for (const mode of QODER_MODES) {
      for (const name of getQoderRegionConfig(mode).patEnvNames) {
        vi.stubEnv(name, undefined);
      }
    }
    const fetchMock = vi.fn().mockRejectedValue(new Error("network must not be used"));
    vi.stubGlobal("fetch", fetchMock);

    const registered = new Map<string, ProviderConfig>();
    const pi = {
      registerProvider: (id: string, config: ProviderConfig) => {
        registered.set(id, config);
      },
      on: () => {},
      registerCommand: () => {},
      registerFlag: () => {},
    } as unknown as ExtensionAPI;

    await initExtension(pi);

    const qoder = registered.get("qoder");
    expect(qoder).toBeDefined();
    expect(typeof qoder?.refreshModels).toBe("function");
    const qoderCn = registered.get("qoder-cn");
    expect(qoderCn).toBeDefined();
    expect(typeof qoderCn?.refreshModels).toBe("function");
    // The static snapshot is still registered (refresh replaces it later);
    // the hook is what keeps it from staying static after login.
    expect(qoder?.models?.map((model) => model.id)).toEqual(staticModels.map((model) => model.id));
    expect(qoderCn?.models?.map((model) => model.id)).toEqual(staticCnModels.map((model) => model.id));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
