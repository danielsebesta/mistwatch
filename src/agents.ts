import { isAbsolute, join } from "node:path";
import type { AgentConfig, AgentTool } from "../shared/api.ts";
import { autoname, builtin } from "./modelnames.ts";
import { LADDER } from "./router.ts";
export const ENV = "MISTWATCH_TOKEN";
export type ModelSpec = [id: string, name: string, ctx: number, vision: boolean];
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const NON_ASCII = /[\u0080-\uffff]/g;
export const dumpJson = (v: unknown): string =>
  JSON.stringify(v, null, 2).replace(NON_ASCII, (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
export const models = (): ModelSpec[] => {
  const out: ModelSpec[] = [["auto", "Auto", 262_144, true]];
  const seen = new Set<string>();
  for (const st of LADDER) {
    if (seen.has(st.model)) continue;
    seen.add(st.model);
    out.push([st.model, builtin(st.model) ?? autoname(st.model), st.ctx, st.vision]);
  }
  // Included with Vibe Code; offered by name, the router does not pick it.
  out.push(["zai-glm-5-3-flash-vibe-free", "GLM 5.3 Flash (Free)", 1_048_576, true]);
  return out;
};
// The names Mistwatch itself uses for its three router models.
export const VIBE_AUTO: readonly (readonly [name: string, label: string, ctx: number])[] = models()
  .slice(0, 1)
  .map(([id, name, ctx]) => [id, name, ctx] as const);
export const pi = (base: string, env = ENV): Record<string, unknown> => ({
  providers: {
    mistwatch: {
      baseUrl: `${base}/v1`,
      api: "openai-completions",
      apiKey: env,
      models: models().map(([id, name, ctx, vision]) => ({
        id,
        name,
        reasoning: id !== "mistral-small-2603",
        input: vision ? ["text", "image"] : ["text"],
        contextWindow: ctx,
        maxTokens: 32_768,
      })),
    },
  },
});
export const opencode = (base: string, env = ENV): Record<string, unknown> => ({
  $schema: "https://opencode.ai/config.json",
  provider: {
    mistwatch: {
      npm: "@ai-sdk/openai-compatible",
      name: "mistwatch",
      options: { baseURL: `${base}/v1`, apiKey: `{env:${env}}` },
      models: Object.fromEntries(
        models().map(([id, name, ctx]) => [id, { name, limit: { context: ctx, output: 32_768 } }]),
      ),
    },
  },
});
export const vibeAutoBlock = ([name, label, ctx]: (typeof VIBE_AUTO)[number]): string => `[[models]]
name = "${name}"
provider = "mistwatch"
alias = "${name}"
display_name = "${label}"
max_context_length = ${ctx}
supports_images = true
`;
export const vibe = (base: string, env = ENV): string => `[[providers]]
name = "mistwatch"
api_base = "${base}/v1"
api_key_env_var = "${env}"
backend = "mistral"

# Pick these in Vibe to let Mistwatch choose the model.
${VIBE_AUTO.map(vibeAutoBlock).join("\n")}
# Or set provider = "mistwatch" on the models you already use.
`;
export const merge = (dst: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> => {
  for (const [k, v] of Object.entries(src)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const cur = dst[k];
    dst[k] = isRec(v) && isRec(cur) ? merge(cur, v) : v;
  }
  return dst;
};
export const opencodeConfigPath = (
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const xdg = env.XDG_CONFIG_HOME;
  const base = platform !== "win32" && xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "opencode", "opencode.json");
};
export const TOOLS: Record<AgentTool, { label: string; path: string; language: string }> = {
  opencode: { label: "OpenCode", path: "~/.config/opencode/opencode.json", language: "json" },
  pi: { label: "Pi", path: "~/.pi/agent/models.json", language: "json" },
  vibe: { label: "Vibe CLI", path: "~/.vibe/config.toml", language: "toml" },
  env: { label: "Other tools", path: "environment", language: "sh" },
};
export const TOOL_ORDER: readonly AgentTool[] = ["opencode", "pi", "vibe", "env"];
export const render = (tool: AgentTool, base: string, env = ENV): AgentConfig => {
  const { label, path, language } = TOOLS[tool];
  let text: string;
  let note: string;
  if (tool === "opencode") {
    text = `${dumpJson(opencode(base, env))}\n`;
    note = "Merge this into the file, or run: mistwatch agent-config opencode --write";
  } else if (tool === "pi") {
    text = `${dumpJson(pi(base, env))}\n`;
    note = "Merge this into the file, or run: mistwatch agent-config pi --write";
  } else if (tool === "vibe") {
    text = vibe(base, env);
    note = "Add this to the file.";
  } else {
    text = `export OPENAI_BASE_URL="${base}/v1"\nexport OPENAI_API_KEY="$${env}"\n`;
    note = 'Any tool that speaks the OpenAI chat completions API. Use the model name "auto".';
  }
  return {
    tool,
    label,
    path,
    language,
    content: text,
    filename: path.includes("/") ? (path.split("/").pop() ?? path) : "mistwatch.env",
    note: `${note} Set ${env} to a key from the API keys page.`,
  };
};
export const llmsTxt = (base: string): string => `# Mistwatch

> A local gateway in front of Mistral AI. It speaks the OpenAI/Mistral chat completions API, tracks the Vibe Code and Studio (API) budgets, spreads spending over time and can pick the model for you (\`auto\`). Unofficial: not affiliated with Mistral AI.

## Connect

- Base URL: \`${base}/v1\`
- Auth: \`Authorization: Bearer mw-...\` (or \`x-api-key\`). Create keys in the web UI under "API keys". Without any key the gateway is open to the local machine.
- Format: Mistral/OpenAI chat completions, including streaming and tool calls. \`POST /v1/chat/completions\`, \`/v1/fim/completions\`, \`/v1/embeddings\`, \`/v1/ocr\`, \`/v1/moderations\` and \`/v1/conversations\` are counted against the budget. Every other path is forwarded without accounting.
- Not offered: Anthropic Messages (\`/v1/messages\`) and OpenAI Responses (\`/v1/responses\`). Mistral does not serve them, so Claude Code and current Codex CLI need a translating proxy (for example LiteLLM) in front, or their own provider.

## Models

- \`auto\` picks the model and the reasoning effort for each request; you cannot set the effort. A small model rates how hard the request is from the prompt, the project instructions (such as AGENTS.md) and what the agent has done so far. Price and the budget that is left then decide between choices of similar strength. For GLM 5.3 Flash it tries the free Vibe variant first and falls back to the paid one for ten minutes when that is refused.
- Any Mistral model id is forwarded unchanged. \`GET /v1/models\` lists the upstream models.

## What a client should handle

- \`401\` with \`error.type = "mistwatch_auth"\`: the key is wrong or revoked.
- \`429\` with \`error.type = "mistwatch_budget_exhausted"\`: no account has room right now. Wait for the \`Retry-After\` header (seconds) instead of retrying at once. The body lists each pool and when it frees up.
- Requests whose \`User-Agent\` contains \`Mistral-Vibe\` are charged to the Vibe Code budget, all others to the Studio API budget. If one is used up, the other is tried.
- Response headers on accounted calls: \`x-mw-account\`, \`x-mw-pool\`, \`x-mw-room-eur\` (what can still be spent now) and, for \`auto\`, \`x-mw-routed\` (the model and effort chosen).

## Set up a tool

- Run one command: \`npx mistwatch setup --yes --harness vibe\` (or \`opencode\`, \`pi\`, or a list such as \`vibe,opencode\`). It creates the config, links the Vibe CLI login, creates a client token (shown once) and writes the tool's provider config. Any file it changes is copied to \`<file>.<timestamp>.bak\` first and merged, never replaced. Safe to run again. Needs Node 24+. If the default port 8787 is taken, add \`--port N\`: it writes the port into config.toml and into the tool configs (\`serve --port N\` alone changes neither).
- Give the token to tools through the environment variable \`${ENV}\`. Never ask the user to paste keys into chat and never print the token again.
- Verify with \`mistwatch status\` and, while the proxy runs, \`curl -H "Authorization: Bearer $${ENV}" ${base}/v1/models\`.
- If the Vibe login is missing, the user runs \`vibe --setup\` and then \`mistwatch import-vibe\`.
- Ask the user before starting \`mistwatch serve\`: it keeps running.
- By hand: \`mistwatch agent-config opencode --write\`, \`mistwatch agent-config pi --write\`, \`mistwatch vibe-config\`. Any other OpenAI-compatible tool: base URL \`${base}/v1\`, key from the API keys page, model \`auto\`.
- The same snippets can be copied or downloaded from the web UI: ${base}/#/keys
- Full agent instructions: AGENTS.md in the repository.

## Building an integration

- Read the key from an environment variable (\`${ENV}\`); never write it into a file you commit.
- Default to the model \`auto\` and let the gateway choose.
- On \`429\`, show the user the wait time from \`Retry-After\`. Do not switch models to get around it.
- Use one key per tool so its usage shows up separately under "Spend by key".
`;
