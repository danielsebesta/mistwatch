import type {
  AccountPatch,
  AccountsResponse,
  AdoptResponse,
  AgentConfig,
  ApiKeysResponse,
  BoostState,
  Credentials,
  LedgerRow,
  LoginResponse,
  ModelRename,
  ModelRow,
  ModelsRefreshResponse,
  NewApiKeyResponse,
  OkResponse,
  OwnerResponse,
  PasswordChange,
  Pool,
  PutKeyBody,
  PutKeyResponse,
  SessionResponse,
  SetupResponse,
  SignInAttempt,
  StatusResponse,
  SummaryResponse,
  SyncAllResult,
  UsageBy,
  UsageRange,
  UsageResponse,
  UserRow,
} from "../../shared/api.ts";
import { enc } from "./format.ts";
import { handlers, session } from "./state.ts";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const strProp = (o: object, k: string): string | undefined => {
  const v = (o as Record<string, unknown>)[k];
  return typeof v === "string" ? v : undefined;
};

const req = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const r = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-mw": "1" },
    body: body === undefined ? null : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await r.json();
  } catch {
    // empty body
  }
  if (r.status === 401 && path !== "/login") {
    session.me = null;
    handlers.boot();
    throw new ApiError("Your session has expired.", 401);
  }
  if (!r.ok) {
    const msg =
      typeof data === "object" && data !== null ? (strProp(data, "detail") ?? strProp(data, "message")) : undefined;
    throw new ApiError(msg ?? `Error ${r.status}`, r.status);
  }
  return data as T;
};

export const api = {
  session: () => req<SessionResponse>("GET", "/session"),
  setup: (b: Credentials) => req<SetupResponse>("POST", "/setup", b),
  login: (b: Credentials) => req<LoginResponse>("POST", "/login", b),
  logout: () => req<OkResponse>("POST", "/logout"),
  password: (b: PasswordChange) => req<OkResponse>("POST", "/password", b),
  users: () => req<UserRow[]>("GET", "/users"),
  addUser: (b: Credentials) => req<OkResponse>("POST", "/users", b),
  delUser: (id: number) => req<OkResponse>("DELETE", `/users/${id}`),
  status: () => req<StatusResponse>("GET", "/status"),
  summary: () => req<SummaryResponse>("GET", "/summary"),
  usage: (range: UsageRange, by: UsageBy) => req<UsageResponse>("GET", `/usage?range=${range}&by=${by}`),
  ledger: (limit: number) => req<LedgerRow[]>("GET", `/ledger?limit=${limit}`),
  models: (all: boolean) => req<ModelRow[]>("GET", `/models${all ? "?all=true" : ""}`),
  renameModel: (key: string, b: ModelRename) => req<OkResponse>("PUT", `/models/${enc(key)}`, b),
  resetModel: (key: string) => req<OkResponse>("DELETE", `/models/${enc(key)}`),
  refreshModels: () => req<ModelsRefreshResponse>("POST", "/models-refresh"),
  sync: () => req<SyncAllResult>("POST", "/sync"),
  boost: () => req<BoostState>("POST", "/boost"),
  accounts: () => req<AccountsResponse>("GET", "/accounts"),
  owner: (name: string) => req<OwnerResponse>("GET", `/accounts/${enc(name)}/owner`),
  addKey: (b: { key?: string; source?: "vibe-cli" }) => req<AdoptResponse>("POST", "/keys/add", b),
  adopt: (name: string) => req<AdoptResponse>("POST", `/accounts/${enc(name)}/adopt`),
  newSignin: () => req<SignInAttempt>("POST", "/signin"),
  patchAccount: (name: string, b: AccountPatch) => req<OkResponse>("PATCH", `/accounts/${enc(name)}`, b),
  delAccount: (name: string) => req<OkResponse>("DELETE", `/accounts/${enc(name)}`),
  putKey: (name: string, pool: Pool, b: PutKeyBody) =>
    req<PutKeyResponse>("PUT", `/accounts/${enc(name)}/keys/${pool}`, b),
  delKey: (name: string, pool: Pool) => req<OkResponse>("DELETE", `/accounts/${enc(name)}/keys/${pool}`),
  startSignin: (name: string) => req<SignInAttempt>("POST", `/accounts/${enc(name)}/signin`),
  signinStatus: (id: string) => req<SignInAttempt>("GET", `/signin/${enc(id)}`),
  signinCancel: (id: string) => req<OkResponse>("DELETE", `/signin/${enc(id)}`),
  agentConfig: () => req<AgentConfig[]>("GET", "/agent-config"),
  apikeys: () => req<ApiKeysResponse>("GET", "/apikeys"),
  newApikey: (name: string) => req<NewApiKeyResponse>("POST", "/apikeys", { name }),
  delApikey: (id: number) => req<OkResponse>("DELETE", `/apikeys/${id}`),
};

export const signOut = async (): Promise<void> => {
  await api.logout();
  session.me = null;
  handlers.boot();
};
