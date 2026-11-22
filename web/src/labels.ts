import type { Pool, UsageBy, UsageRange, WindowName } from "../../shared/api.ts";
import { h } from "./dom.ts";

export const POOL: Record<Pool, string> = { vibe: "Vibe Code", api: "Studio (API)" };
export const WIN: Record<WindowName, string> = { "5h": "5 hours", day: "Day", week: "Week" };
export const RANGES: Record<UsageRange, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
export const BYS: Record<UsageBy, string> = { model: "Model", client: "API key", account: "Account", pool: "Budget" };
export const RANGE_DAYS: Record<UsageRange, number> = { "24h": 1, "7d": 7, "30d": 30 };
export const SRC: Record<string, string> = {
  "vibe-cli": "Vibe CLI sign-in (updates automatically)",
  keyring: "saved on this computer",
  env: "environment setting",
  inline: "stored by Mistwatch",
};
// Mistral's internal plan names, as people know them
export const PLAN: Record<string, string> = { FREE: "Free", INDIVIDUAL: "Pro", EDU: "Student", TEAM: "Team" };
export const planName = (raw: string): string => PLAN[raw.trim().toUpperCase()] ?? raw;
export const NAME_SRC: Record<string, [string, string]> = {
  custom: ["custom", "info"],
  "built-in": ["built-in", ""],
  mistral: ["from Mistral", ""],
  auto: ["auto", ""],
};
export const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)"];
export const PERIOD_DAYS = 30.44;
export const poolLabel = (p: string): string => (p === "vibe" || p === "api" ? POOL[p] : p);
export const winLabel = (n: string): string => (n === "5h" || n === "day" || n === "week" ? WIN[n] : n);
export const colorOf = (name: string, i: number): string =>
  name === "other" ? "var(--s-other)" : (SERIES[i % SERIES.length] ?? "var(--s-other)");
export const asRange = (v: string): UsageRange => (v === "24h" || v === "30d" ? v : "7d");
export const asBy = (v: string): UsageBy => (v === "client" || v === "account" || v === "pool" ? v : "model");
// sync books spend it cannot attribute to a key under the "(external)" marker
export const clientLabel = (c: string | null): string => (c === "(external)" ? "Unknown" : c || "—");
export const DISCLAIMER =
  "Mistwatch is an independent, unofficial tool. It is not affiliated with, endorsed by or sponsored by Mistral AI. “Mistral” is a trademark of Mistral AI.";
export const legal = (): HTMLElement => h("footer", { class: "legal" }, h("p", {}, DISCLAIMER));
