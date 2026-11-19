type OAuthCredential = {
  type: "oauth";
  access: string;
  expires: number;
  userID?: string;
  [key: string]: unknown;
};

type Credential = OAuthCredential | { type: "api_key"; [key: string]: unknown };

type OmpStorage = {
  credentials: { list(provider: string): Array<{ id: number; provider: string; credential: Credential }> };
  oauth: {
    accessById(
      provider: string,
      id: number,
      options: { forceRefresh: true; refreshReason: "auth-recovery"; rejectedAccessToken: string },
    ): Promise<{ ok: boolean; accessToken?: string; apiKey?: string } | undefined>;
  };
};

type PiRuntime = {
  credentials: {
    modify(
      provider: string,
      update: (current: Credential | undefined) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined>;
    read(provider: string): Promise<Credential | undefined>;
  };
  getAuth(provider: string): Promise<{ auth: { apiKey?: string } } | undefined>;
};

type LegacyStorage = {
  storage: {
    withLock<T>(update: (content: string | undefined) => { result: T; next?: string }): T;
  };
  reload(): void;
  get(provider: string): Credential | undefined;
  getApiKey(provider: string): Promise<string | undefined>;
};

type Host = OmpStorage | PiRuntime | LegacyStorage;
export type RenewedQoderAccess = {
  accessToken: string;
  userID: string;
  name?: string;
  email?: string;
  machineID?: string;
};
export type RenewQoderAccess = (
  provider: string, rejectedAccess: string, credentialId?: number,
) => Promise<RenewedQoderAccess>;

function hasRealUserID(credential: OAuthCredential): boolean {
  return typeof credential.userID === "string" && credential.userID.trim() !== "" && credential.userID.trim() !== "qoder-user";
}

function renewedIdentity(credential: OAuthCredential): RenewedQoderAccess {
  return {
    accessToken: credential.access,
    userID: credential.userID as string,
    name: typeof credential.name === "string" ? credential.name : undefined,
    email: typeof credential.email === "string" ? credential.email : undefined,
    machineID: typeof credential.machineID === "string" ? credential.machineID : undefined,
  };
}

/** Use only host-owned storage and refresh locks; never write credentials here. */
export function createQoderAuthRecovery(host: Host): RenewQoderAccess {
  const pending = new Map<string, Promise<RenewedQoderAccess>>();
  return (provider, rejectedAccess, credentialId) => {
    let row: { id: number; userID: string } | undefined;
    if ("oauth" in host) {
      const matches = host.credentials.list(provider).filter((candidate) =>
        candidate.provider === provider && candidate.credential.type === "oauth" &&
        (credentialId === undefined ? candidate.credential.access === rejectedAccess : candidate.id === credentialId),
      );
      const match = matches[0];
      if (matches.length !== 1 || match.credential.type !== "oauth" || !hasRealUserID(match.credential)) {
        return Promise.reject(new Error("Qoder could not identify the rejected OAuth credential."));
      }
      row = { id: match.id, userID: match.credential.userID as string };
    }
    // A token may exist in more than one row; validate provenance before sharing.
    const key = JSON.stringify([provider, row?.id ?? null, rejectedAccess]);
    const existing = pending.get(key);
    if (existing) return existing;

    const renewal = (async () => {
      let renewed: OAuthCredential | undefined;
      if ("oauth" in host) {
        if (!row) throw new Error("Qoder could not identify the rejected OAuth credential.");
        const result = await host.oauth.accessById(provider, row.id, {
          forceRefresh: true,
          refreshReason: "auth-recovery",
          rejectedAccessToken: rejectedAccess,
        });
        const updated = host.credentials.list(provider).find((candidate) => candidate.id === row?.id);
        if (result?.ok && result.apiKey === result.accessToken && updated?.provider === provider &&
            updated.credential.type === "oauth" && updated.credential.access === result.accessToken &&
            updated.credential.userID === row.userID && hasRealUserID(updated.credential)) {
          renewed = updated.credential;
        }
      } else if ("getAuth" in host) {
        let userID: string | undefined;
        await host.credentials.modify(provider, async (current) => {
          if (current?.type !== "oauth" || current.access !== rejectedAccess || !hasRealUserID(current)) {
            throw new Error("Qoder could not identify the rejected OAuth credential.");
          }
          userID = current.userID;
          return { ...current, expires: 0 };
        });
        const key = (await host.getAuth(provider))?.auth.apiKey;
        const current = await host.credentials.read(provider);
        if (current?.type === "oauth" && current.userID === userID && current.access === key && hasRealUserID(current)) renewed = current;
      } else {
        // Older Pi exposes no compare-and-set API; use its backend lock so
        // another process's newer credential is never overwritten.
        const userID = host.storage?.withLock((content) => {
          const stored = JSON.parse(content || "{}") as Record<string, Credential>;
          const current = stored[provider];
          if (current?.type !== "oauth" || current.access !== rejectedAccess || !hasRealUserID(current)) {
            return { result: undefined };
          }
          stored[provider] = { ...current, expires: 0 };
          return { result: current.userID, next: JSON.stringify(stored, null, 2) };
        });
        if (!userID) throw new Error("Qoder could not identify the rejected OAuth credential.");
        host.reload();
        const key = await host.getApiKey(provider);
        host.reload();
        const updated = host.get(provider);
        if (updated?.type === "oauth" && updated.userID === userID && updated.access === key && hasRealUserID(updated)) renewed = updated;
      }
      if (!renewed || renewed.access === rejectedAccess) throw new Error("Qoder credential renewal did not produce a new token.");
      return renewedIdentity(renewed);
    })();
    pending.set(key, renewal);
    void renewal.finally(() => {
      pending.delete(key);
    }).catch(() => {});
    return renewal;
  };
}

/** Only an explicit Qoder code 105 is an expired-login rejection. */
export function isQoderLoginExpired(body: unknown): boolean {
  for (let depth = 0; depth < 4; depth++) {
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return false;
      }
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const error = body as Record<string, unknown>;
    if ((error.code === "105" || error.code === 105) &&
        typeof error.message === "string" && /^login expired$/i.test(error.message.trim())) return true;
    if (error.code !== "403" && error.code !== 403) return false;
    body = error.message;
  }
  return false;
}
