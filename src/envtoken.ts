import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const TOKEN_ENV = "MISTWATCH_TOKEN";

export type KeyCheck = "valid" | "rejected" | "unreachable";
// A Mistwatch server lists models for a good key and answers 401 for a bad or missing one.
export const checkKey = async (url: string, token: string, doFetch: typeof fetch = fetch): Promise<KeyCheck> => {
  try {
    const res = await doFetch(`${url}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) return "rejected";
    return res.ok ? "valid" : "unreachable";
  } catch {
    return "unreachable";
  }
};

export type PersistResult =
  | { saved: true; where: string; note: string }
  | { saved: false; reason: string; manual: string };

export type PersistDeps = {
  platform: NodeJS.Platform;
  home: string;
  shell: string | undefined;
  now: () => Date;
  // Asked before a shell profile is touched; Windows stores the variable in the user's environment instead.
  confirm: (question: string) => Promise<boolean>;
  // Copies a profile before it is changed.
  backup: (path: string, now: Date) => unknown;
  // Windows only; the default runs setx.
  setx?: (name: string, value: string) => Promise<void>;
};

const runSetx = (name: string, value: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("setx", [name, value], { windowsHide: true }, (e) => (e ? reject(e) : resolve()));
  });

const LINE = new RegExp(`^export ${TOKEN_ENV}=.*$`, "m");
export const profileFor = (shell: string | undefined, home: string): string | null => {
  const name = basename(shell ?? "");
  if (name === "zsh") return join(home, ".zshrc");
  if (name === "bash") return existsSync(join(home, ".bashrc")) ? join(home, ".bashrc") : join(home, ".bash_profile");
  return null;
};
export const manualCommand = (platform: NodeJS.Platform, shell: string | undefined): string => {
  if (platform === "win32") return `setx ${TOKEN_ENV} <key>   (then open a new terminal)`;
  if (basename(shell ?? "") === "fish") return `set -Ux ${TOKEN_ENV} <key>`;
  return `export ${TOKEN_ENV}=<key>   (add it to your shell profile)`;
};

export const persistToken = async (token: string, d: PersistDeps): Promise<PersistResult> => {
  const manual = manualCommand(d.platform, d.shell);
  if (d.platform === "win32") {
    try {
      await (d.setx ?? runSetx)(TOKEN_ENV, token);
    } catch (e) {
      return { saved: false, reason: `setx failed: ${e instanceof Error ? e.message : String(e)}`, manual };
    }
    return { saved: true, where: "your user environment", note: "open a new terminal for it to take effect" };
  }
  const profile = profileFor(d.shell, d.home);
  if (!profile) return { saved: false, reason: "no known shell profile for this shell", manual };
  if (!(await d.confirm(`Add ${TOKEN_ENV} to ${profile}? The key is stored there in plain text.`)))
    return { saved: false, reason: "not saved", manual };
  const raw = existsSync(profile) ? readFileSync(profile, "utf8") : "";
  const line = `export ${TOKEN_ENV}=${JSON.stringify(token)}`;
  const next = LINE.test(raw)
    ? raw.replace(LINE, () => line)
    : `${raw}${raw === "" || raw.endsWith("\n") ? "" : "\n"}# Mistwatch\n${line}\n`;
  if (raw !== "") d.backup(profile, d.now());
  writeFileSync(profile, next, { mode: 0o600 });
  return { saved: true, where: profile, note: "open a new terminal, or run `source` on it" };
};
