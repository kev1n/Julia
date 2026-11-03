// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: the history store from `fork-thread-history.json` in the server's userdata dir; no file =
 * off. `"azure-keyvault"`: an Azure Blob container whose service principal is Key Vault `keyVault`
 * secret `secret`, read with this machine's `az` login, never stored in a file.
 * `T3CODE_THREAD_HISTORY_SECRET` picks another secret, or `off`; blobs expire by lifecycle rule.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

/** `fork-thread-history.json`: the store and its Key Vault secret. */
export interface HistoryStoreConfig {
  readonly store: "azure-keyvault";
  readonly keyVault: string;
  readonly secret: string;
}
const BLOB_API_VERSION = "2023-11-03";
/**
 * How long `az` may take to read the secret. A hung `az` otherwise holds the one sign-in every
 * offload and restore waits on. 300 s matches Node's fetch defaults (undici headersTimeout and
 * bodyTimeout) on the Azure calls below. The callback fires once `az` exits on SIGTERM.
 */
const AZ_TIMEOUT_MS = 300_000;

/** The `az` binary and its time limit; tests swap in a stand-in. */
interface AzCommand {
  readonly file: string;
  readonly timeoutMs: number;
}

/** The blob is gone: the lifecycle rule deleted it, or it was never written. */
export class HistoryBlobMissing extends Schema.TaggedError<HistoryBlobMissing>()(
  "HistoryBlobMissing",
  {
    message: Schema.String,
  },
) {}
/** Azure could not be reached or refused us; retrying may work. */
export class HistoryBlobUnavailable extends Schema.TaggedError<HistoryBlobUnavailable>()(
  "HistoryBlobUnavailable",
  {
    message: Schema.String,
  },
) {}

/** Azure refused this one blob (a 4xx other than sign-in); other threads may still move. */
export class HistoryBlobRejected extends Schema.TaggedError<HistoryBlobRejected>()(
  "HistoryBlobRejected",
  {
    message: Schema.String,
  },
) {}

const isHistoryBlobMissing = Schema.is(HistoryBlobMissing);
const isHistoryBlobUnavailable = Schema.is(HistoryBlobUnavailable);
const isHistoryBlobRejected = Schema.is(HistoryBlobRejected);

/** Any failure of a store call, as one of the errors above. */
export const asBlobError = (
  cause: unknown,
): HistoryBlobMissing | HistoryBlobUnavailable | HistoryBlobRejected =>
  isHistoryBlobMissing(cause) || isHistoryBlobUnavailable(cause) || isHistoryBlobRejected(cause)
    ? cause
    : new HistoryBlobUnavailable({
        message: cause instanceof Error ? cause.message : String(cause),
      });

export interface HistoryBlobStore {
  /** Signs in (or reuses the sign-in), so a sweep learns Azure is unusable before bundling. */
  readonly ready: () => Promise<void>;
  readonly put: (name: string, body: Uint8Array) => Promise<void>;
  readonly get: (name: string) => Promise<Uint8Array>;
}

interface Credential {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly account: string;
  readonly container: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * The configured store, with `T3CODE_THREAD_HISTORY_SECRET` replacing its secret; null (off) when
 * the file is missing or invalid, or the variable is `off`.
 */
export function readHistoryStoreConfig(userdataDir: string): HistoryStoreConfig | null {
  let raw: Partial<HistoryStoreConfig>;
  try {
    raw = JSON.parse(
      NodeFS.readFileSync(NodePath.join(userdataDir, "fork-thread-history.json"), "utf8"),
    ) as Partial<HistoryStoreConfig>;
  } catch {
    return null;
  }
  if (raw.store !== "azure-keyvault" || !raw.keyVault || !raw.secret) return null;
  const secret = process.env.T3CODE_THREAD_HISTORY_SECRET?.trim() || raw.secret;
  return secret === "off" ? null : { store: raw.store, keyVault: raw.keyVault, secret };
}

function readKeyVaultSecret(
  { keyVault, secret }: HistoryStoreConfig,
  az: AzCommand,
): Promise<Credential> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      az.file,
      ["keyvault", "secret", "show", "--vault-name", keyVault, "--name", secret],
      // The service runs under launchd, whose PATH lacks Homebrew.
      {
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` },
        timeout: az.timeoutMs,
      },
      (error, stdout) => {
        if (error)
          return reject(
            new HistoryBlobUnavailable({ message: `Key Vault secret ${secret} unreadable` }),
          );
        try {
          resolve(JSON.parse(JSON.parse(stdout).value) as Credential);
        } catch {
          reject(
            new HistoryBlobUnavailable({
              message: `Key Vault secret ${secret} is not a credential`,
            }),
          );
        }
      },
    );
  });
}

/** A store backed by the container the Key Vault secret names. */
export function azureHistoryBlobStore(
  config: HistoryStoreConfig,
  az: AzCommand = { file: "az", timeoutMs: AZ_TIMEOUT_MS },
): HistoryBlobStore {
  let session: Promise<{ credential: Credential; token: string; expiresAt: number }> | null = null;

  const authorize = async () => {
    const current = await session?.catch(() => null);
    if (current && current.expiresAt > Date.now()) return current;
    session = (async () => {
      const credential = await readKeyVaultSecret(config, az);
      const response = await fetch(
        `https://login.microsoftonline.com/${credential.tenantId}/oauth2/v2.0/token`,
        {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: credential.clientId,
            client_secret: credential.clientSecret,
            scope: "https://storage.azure.com/.default",
          }),
        },
      ).catch(() => null);
      if (!response?.ok) throw new HistoryBlobUnavailable({ message: "Azure sign-in failed" });
      const body = (await response.json()) as { access_token: string; expires_in: number };
      return {
        credential,
        token: body.access_token,
        expiresAt: Date.now() + body.expires_in * 1000,
      };
    })();
    return session;
  };

  const request = async (
    name: string,
    init: RequestInit & { headers?: Record<string, string> },
  ) => {
    const { credential, token } = await authorize();
    const url = `https://${credential.account}.blob.core.windows.net/${credential.container}/${name}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
        "x-ms-version": BLOB_API_VERSION,
      },
    }).catch(() => null);
    if (response === null)
      throw new HistoryBlobUnavailable({ message: "Azure Blob Storage unreachable" });
    return response;
  };

  return {
    ready: async () => void (await authorize()),
    put: async (name, body) => {
      const response = await request(name, {
        method: "PUT",
        headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/gzip" },
        body,
      });
      if (response.ok) return;
      const message = `upload failed (${response.status})`;
      if (
        response.status >= 400 &&
        response.status < 500 &&
        ![401, 403, 408, 429].includes(response.status)
      )
        throw new HistoryBlobRejected({ message });
      throw new HistoryBlobUnavailable({ message });
    },
    get: async (name) => {
      const response = await request(name, { method: "GET" });
      if (response.status === 404) throw new HistoryBlobMissing({ message: name });
      if (!response.ok)
        throw new HistoryBlobUnavailable({ message: `download failed (${response.status})` });
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
