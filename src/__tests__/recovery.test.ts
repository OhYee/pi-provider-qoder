import { describe, expect, it, vi } from "vitest";
import { createQoderAuthRecovery, isQoderLoginExpired } from "../auth/recovery.js";

const oauth = (access: string, userID = "user-a") => ({ type: "oauth" as const, access, userID, expires: 42 });
const asHost = (host: unknown) => host as Parameters<typeof createQoderAuthRecovery>[0];

describe("Qoder login expiry classification", () => {
  it("recognizes only the explicit 105 login-expired error, including a gateway wrapper", () => {
    const expired = { code: "105", message: "Login expired" };
    expect(isQoderLoginExpired(JSON.stringify(expired))).toBe(true);
    expect(isQoderLoginExpired({ code: 105, message: "login expired" })).toBe(true);
    expect(isQoderLoginExpired(JSON.stringify({ code: "403", message: JSON.stringify(expired) }))).toBe(true);
    expect(isQoderLoginExpired({ code: "105", message: "Permission denied" })).toBe(false);
    expect(isQoderLoginExpired({ code: "403", message: "Forbidden" })).toBe(false);
    expect(isQoderLoginExpired({ code: "110", message: "Login expired" })).toBe(false);
    expect(isQoderLoginExpired("not json")).toBe(false);
    expect(isQoderLoginExpired({ code: "1050", message: "Login expired" })).toBe(false);
  });
});

describe("host-owned Qoder credential recovery", () => {
  it("uses the exact OMP provider and credential row with rejected-token context", async () => {
    const rows = [
      { id: 1, provider: "qoder", credential: oauth("old-global") },
      { id: 2, provider: "qoder-cn", credential: oauth("old-cn") },
    ];
    const accessById = vi.fn(async () => {
      rows[1].credential.access = "new-cn";
      return { ok: true, accessToken: "new-cn", apiKey: "new-cn" };
    });
    const host = {
      credentials: { list: vi.fn(() => rows) },
      oauth: { accessById },
    };
    const renew = createQoderAuthRecovery(asHost(host));
    await expect(renew("qoder-cn", "old-cn", 2)).resolves.toMatchObject({ accessToken: "new-cn", userID: "user-a" });
    expect(accessById).toHaveBeenCalledOnce();
    expect(accessById).toHaveBeenCalledWith("qoder-cn", 2, {
      forceRefresh: true, refreshReason: "auth-recovery", rejectedAccessToken: "old-cn",
    });
  });

  it("uses the supplied row after another request has already rotated its token", async () => {
    const accessById = vi.fn().mockResolvedValue({ ok: true, accessToken: "peer-new", apiKey: "peer-new" });
    const host = {
      credentials: { list: () => [{ id: 7, provider: "qoder", credential: oauth("peer-new") }] },
      oauth: { accessById },
    };
    await expect(createQoderAuthRecovery(asHost(host))("qoder", "old", 7)).resolves.toMatchObject({
      accessToken: "peer-new", userID: "user-a",
    });
    expect(accessById).toHaveBeenCalledWith("qoder", 7, expect.objectContaining({ rejectedAccessToken: "old" }));
  });

  it("requires exactly one matching OAuth row without provenance and rejects static keys", async () => {
    const accessById = vi.fn();
    const host = {
      credentials: { list: () => [
        { id: 1, provider: "qoder", credential: oauth("same") },
        { id: 2, provider: "qoder", credential: oauth("same") },
        { id: 3, provider: "qoder", credential: { type: "api_key", key: "static" } },
      ] },
      oauth: { accessById },
    };
    const renew = createQoderAuthRecovery(asHost(host));
    await expect(renew("qoder", "same")).rejects.toThrow(/identify/);
    await expect(renew("qoder", "static")).rejects.toThrow(/identify/);
    expect(accessById).not.toHaveBeenCalled();
  });

  it("shares an in-flight renewal only for the same provider and rejected token", async () => {
    let release!: (result: { ok: true; accessToken: string; apiKey: string }) => void;
    const gate = new Promise<{ ok: true; accessToken: string; apiKey: string }>((resolve) => { release = resolve; });
    const rows = [
      { id: 1, provider: "qoder", credential: oauth("old") },
      { id: 2, provider: "qoder-cn", credential: oauth("old") },
      { id: 3, provider: "qoder", credential: oauth("other") },
    ];
    const accessById = vi.fn(async (provider: string, id: number) => {
      const result = await gate;
      const row = rows.find((candidate) => candidate.provider === provider && candidate.id === id);
      if (row) row.credential.access = result.accessToken;
      return result;
    });
    const host = {
      credentials: { list: () => rows },
      oauth: { accessById },
    };
    const renew = createQoderAuthRecovery(asHost(host));
    const first = renew("qoder", "old", 1);
    const shared = renew("qoder", "old", 1);
    const cn = renew("qoder-cn", "old", 2);
    const other = renew("qoder", "other", 3);
    const otherRow = renew("qoder", "old", 3);
    expect(first).toBe(shared);
    expect(accessById).toHaveBeenCalledTimes(4);
    release({ ok: true, accessToken: "new", apiKey: "new" });
    await expect(Promise.all([first, shared, cn, other, otherRow])).resolves.toEqual(
      Array.from({ length: 5 }, () => expect.objectContaining({ accessToken: "new", userID: "user-a" })),
    );
  });

  it("does not adopt an OMP fallback, an unchanged token, or a failed refresh", async () => {
    const accessById = vi.fn()
      .mockResolvedValueOnce({ ok: true, accessToken: "new", apiKey: "other" })
      .mockResolvedValueOnce({ ok: true, accessToken: "old", apiKey: "old" })
      .mockResolvedValueOnce({ ok: false });
    const host = {
      credentials: { list: () => [{ id: 1, provider: "qoder", credential: oauth("old") }] },
      oauth: { accessById },
    };
    const renew = createQoderAuthRecovery(asHost(host));
    for (let i = 0; i < 3; i++) await expect(renew("qoder", "old")).rejects.toThrow(/renewal/);
  });

  it("uses Pi runtime's atomic modify and verifies the refreshed account", async () => {
    let current = oauth("old");
    const modify = vi.fn(async (_provider: string, update: (value: typeof current) => Promise<typeof current>) => {
      current = await update(current);
      return current;
    });
    const host = {
      credentials: { modify, read: vi.fn(async () => current) },
      getAuth: vi.fn(async () => {
        expect(current.expires).toBe(0);
        current = oauth("new");
        return { auth: { apiKey: current.access } };
      }),
    };
    await expect(createQoderAuthRecovery(asHost(host))("qoder", "old")).resolves.toMatchObject({
      accessToken: "new", userID: "user-a",
    });
    expect(modify).toHaveBeenCalledOnce();
  });

  it("does not replay with a replacement Pi account or rewrite a different credential", async () => {
    let current = oauth("old");
    const modify = vi.fn(async (_provider: string, update: (value: typeof current) => Promise<typeof current>) => {
      current = await update(current);
      return current;
    });
    const host = {
      credentials: { modify, read: vi.fn(async () => current) },
      getAuth: vi.fn(async () => {
        current = oauth("other-new", "user-b");
        return { auth: { apiKey: current.access } };
      }),
    };
    const renew = createQoderAuthRecovery(asHost(host));
    await expect(renew("qoder", "old")).rejects.toThrow(/renewal/);
    await expect(renew("qoder", "old")).rejects.toThrow(/identify/);
    expect(host.getAuth).toHaveBeenCalledOnce();
  });

  it("uses the old Pi backend lock for conditional expiry and locked host refresh", async () => {
    let stored: Record<string, { type: "oauth"; access: string; userID: string; expires: number }> = { qoder: oauth("old") };
    const withLock = vi.fn((update: (content: string) => { result: unknown; next?: string }) => {
      const result = update(JSON.stringify(stored));
      if (result.next) stored = JSON.parse(result.next);
      return result.result;
    });
    const host = {
      storage: { withLock },
      reload: vi.fn(),
      get: (provider: string) => stored[provider],
      getApiKey: vi.fn(async () => {
        expect(stored.qoder.expires).toBe(0);
        stored.qoder = oauth("new");
        return "new";
      }),
    };
    const renew = createQoderAuthRecovery(asHost(host));
    await expect(renew("qoder", "old")).resolves.toMatchObject({ accessToken: "new", userID: "user-a" });
    await expect(renew("qoder", "old")).rejects.toThrow(/identify/);
    expect(host.getApiKey).toHaveBeenCalledOnce();
    expect(stored.qoder.access).toBe("new");
  });

  it("checks token ambiguity before joining a row-specific in-flight refresh", async () => {
    const rows = [
      { id: 1, provider: "qoder", credential: oauth("same", "user-a") },
      { id: 2, provider: "qoder", credential: oauth("same", "user-b") },
    ];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const accessById = vi.fn(async (_provider: string, id: number) => {
      await gate;
      const row = rows.find((candidate) => candidate.id === id)!;
      row.credential.access = `new-${id}`;
      return { ok: true, accessToken: row.credential.access, apiKey: row.credential.access };
    });
    const renew = createQoderAuthRecovery(asHost({ credentials: { list: () => rows }, oauth: { accessById } }));
    const first = renew("qoder", "same", 1);
    await expect(renew("qoder", "same")).rejects.toThrow(/identify/);
    const second = renew("qoder", "same", 2);
    expect(accessById).toHaveBeenCalledTimes(2);
    release();
    await expect(first).resolves.toMatchObject({ accessToken: "new-1", userID: "user-a" });
    await expect(second).resolves.toMatchObject({ accessToken: "new-2", userID: "user-b" });
  });

  it("rejects placeholder identities and an identity changed in the same row", async () => {
    let current = oauth("old", "qoder-user");
    const accessById = vi.fn(async () => {
      current = oauth("new", "user-b");
      return { ok: true, accessToken: "new", apiKey: "new" };
    });
    const renew = createQoderAuthRecovery(asHost({
      credentials: { list: () => [{ id: 1, provider: "qoder", credential: current }] },
      oauth: { accessById },
    }));
    await expect(renew("qoder", "old", 1)).rejects.toThrow(/identify/);
    expect(accessById).not.toHaveBeenCalled();
    current = oauth("old", "user-a");
    await expect(renew("qoder", "old", 1)).rejects.toThrow(/renewal/);
    expect(accessById).toHaveBeenCalledTimes(1);
  });
});
