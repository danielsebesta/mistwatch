import { readFileSync } from "node:fs";

// Set by the build (scripts/build.ts); from source (tsx, tests) it is read from package.json.
declare const __MW_VERSION__: string | undefined;
const fromPackage = (): string => {
  try {
    const j: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const v = typeof j === "object" && j !== null ? (j as { version?: unknown }).version : undefined;
    return typeof v === "string" ? v : "dev";
  } catch {
    return "dev";
  }
};
export const VERSION: string = typeof __MW_VERSION__ === "string" ? __MW_VERSION__ : fromPackage();
