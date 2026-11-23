// Web UI /api/* JSON contract. Type-only: no DOM, no Node.
export type Pool = "vibe" | "api";
export type WindowName = "5h" | "day" | "week";
export type OkResponse = { ok: true };
export type ApiErrorBody = { detail?: string; message?: string };

// ---------- session / users ----------
export type SessionUser = { id: number; username: string };
export type SessionResponse = { setup_needed: boolean; user: SessionUser | null };
export type Credentials = { username: string; password: string };
export type LoginResponse = { ok: true; user: SessionUser };
export type SetupResponse = { ok: true; api_key?: { name: string; secret: string } };
export type PasswordChange = { old: string; new: string };
export type UserRow = { id: number; username: string; created: number };

// ---------- budgets ----------
export type PoolWindow = { cap: number; spent: number; room: number; retry_at: number | null };
export type WindowTotal = { cap: number; spent: number; room: number };
export type MonthBudget = { cap: number; spent: number; room: number };
export type PoolStatus = {
  account: string;
  pool: Pool;
  group: string;
  members: string[];
  initial_eur: number;
  used_eur: number;
  remaining_eur: number;
  reserve_eur: number;
  reset_at: number;
  days_left: number;
  snapshot_age_s: number;
  daily_fair_share_eur: number;
  room_eur: number;
  blocked_by: string | null;
  retry_at: number | null;
  month: MonthBudget;
  windows: Record<WindowName, PoolWindow>;
  blocked_temporarily: boolean;
  enabled: boolean;
};
export type AggStatus = {
  budgets: number;
  accounts: string[];
  initial_eur: number;
  used_eur: number;
  remaining_eur: number;
  month: MonthBudget;
  room_eur: number;
  fair_daily_eur: number;
  windows: Record<WindowName, WindowTotal>;
  blocked: boolean;
  retry_at: number | null;
  reset_at: number | null;
  resets: { at: number; budgets: number }[];
};
export type SharedGroup = { canonical: string; members: string[]; confidence: "sure" | "likely" };
export type Summary = {
  pools: Partial<Record<Pool, AggStatus>>;
  all: AggStatus | null;
  shared: SharedGroup[];
  accounts: number;
};
// A boost lifts the 5 h and day windows for a few hours, once per local day. Month and week still apply.
export type BoostState = { active: boolean; until: number | null; available: boolean; hours: number };
export type SummaryResponse = Summary & { last_sync: number | null; boost: BoostState };
export type ByClientRow = { client: string; account: string; pool: Pool; n: number; cost_eur: number };
export type StatusResponse = {
  now: number;
  last_sync: number | null;
  pools: PoolStatus[];
  summary: Summary;
  boost: BoostState;
  by_client_7d: ByClientRow[];
};

// ---------- usage / ledger ----------
export type UsageRange = "24h" | "7d" | "30d";
export type UsageBy = "model" | "client" | "account" | "pool";
export type UsageUnit = "hour" | "day";
export type UsageSeries = {
  name: string;
  total: number;
  values: number[];
  tokens: number[];
  requests: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
};
export type UsageResponse = {
  range: UsageRange;
  by: UsageBy;
  unit: UsageUnit;
  buckets: number[];
  step: number;
  series: UsageSeries[];
  total: number;
  prev_total: number;
  requests: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
};
export type LedgerRow = {
  id: number;
  ts: number;
  account: string;
  pool: Pool;
  client: string | null;
  model: string | null;
  endpoint: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cost_eur: number;
  source: "proxy" | "sync";
  estimated: number | null;
  status: number | null;
  latency_ms: number | null;
  model_name: string | null;
};

// ---------- model names ----------
export type ModelSource = "custom" | "built-in" | "mistral" | "auto";
export type ModelRow = {
  key: string;
  ids: string[];
  display: string;
  source: ModelSource;
  calls: number;
  last: number | null;
  description: string | null;
};
export type ModelRename = { display: string };
export type ModelsRefreshResponse = { models: number };

// ---------- Mistral accounts and their keys ----------
export type KeySource = "vibe-cli" | "keyring" | "env" | "inline";
export type KeyInfo = { source: KeySource; hint: string | null; ok: boolean; error?: string };
export type AccountView = {
  name: string;
  priority: number;
  enabled: boolean;
  keys: Record<Pool, KeyInfo | null>;
  shared_with: string[];
};
export type KeyOwner = {
  name: string | null;
  email: string | null;
  workspace: string | null;
  organization: string | null;
  plan: string | null;
  kind: string | null;
};
export type OwnerResponse = Record<Pool, KeyOwner | null>;
export type AccountsResponse = { accounts: AccountView[]; vibe_cli_available: boolean };
export type AdoptResponse = { ok: true; adopted: { account: string; pool: Pool; created: boolean }[] };
export type AccountPatch = { enabled?: boolean; priority?: number };
export type SyncPoolResult = { used: number; initial: number; source: string };
export type SyncedPools = Partial<Record<Pool, SyncPoolResult>>;
export type SyncAllResult = Record<string, SyncedPools>;
export type PutKeyBody = { key: string; verify?: boolean } | { source: "vibe-cli" };
export type PutKeyResponse = { ok: true; synced: SyncedPools; account: AccountView };
export type KeyCheckBody = { key: string };
export type KeyBudget = { initial: number; used: number; currency: string | null };
export type KeyCheckResponse = {
  valid: boolean;
  budgets?: Partial<Record<Pool, KeyBudget>>;
  error?: string;
  note?: string;
};

// ---------- browser sign-in ----------
export type SignInStatus = "pending" | "exchanging" | "done" | "error" | "expired" | "denied" | "cancelled";
export type SignInAttempt = {
  id: string;
  account: string;
  pool: Pool;
  status: SignInStatus;
  message: string;
  sign_in_url: string;
  expires_at: number;
  synced: SyncedPools;
};

// ---------- tool configs / proxy API keys ----------
export type AgentTool = "vibe";
export type AgentConfig = {
  tool: AgentTool;
  label: string;
  path: string;
  language: string;
  content: string;
  filename: string;
  note: string;
};
export type ApiKeyRow = { id: number; name: string; prefix: string; created: number; last_used: number | null };
export type ApiKeysResponse = { keys: ApiKeyRow[]; base_url: string };
export type ApiKeyCreate = { name: string };
export type NewApiKeyResponse = { key: ApiKeyRow; secret: string };
