import type { AgentConfig, AgentTool } from "../shared/api.ts";
import { autoname, builtin } from "./modelnames.ts";
import { LADDER } from "./router.ts";
export const ENV = "MISTWATCH_TOKEN";
export type ModelSpec = [id: string, name: string, ctx: number, vision: boolean];
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
export const vibeAutoBlock = ([name, label, ctx]: (typeof VIBE_AUTO)[number]): string => `[[models]]
name = "${name}"
provider = "mistwatch"
alias = "${name}"
display_name = "${label}"
max_context_length = ${ctx}
supports_images = true
# Mistwatch picks the reasoning effort itself, so Vibe has no effort to offer.
thinking_levels = ["off"]
`;
// Vibe Desktop signs in to Mistral itself and never sends a key to a "mistral" provider that is not on a Mistral host,
// so for the Desktop the provider is "generic" (it uses the key) and asks Mistwatch to flatten the thinking chunks.
export const FLAT_HEADERS = '{ x-mw-flat-content = "1" }';
export const vibe = (base: string, env = ENV, desktop = false): string => `[[providers]]
name = "mistwatch"
api_base = "${base}/v1"
api_key_env_var = "${env}"
backend = "${desktop ? "generic" : "mistral"}"
${
  desktop
    ? `extra_headers = ${FLAT_HEADERS}
`
    : ""
}
# Pick these in Vibe to let Mistwatch choose the model.
${VIBE_AUTO.map(vibeAutoBlock).join("\n")}
# Or set provider = "mistwatch" on the models you already use.
`;
export const TOOLS: Record<AgentTool, { label: string; path: string; language: string }> = {
  vibe: { label: "Vibe CLI", path: "~/.vibe/config.toml", language: "toml" },
};
export const TOOL_ORDER: readonly AgentTool[] = ["vibe"];
export const render = (tool: AgentTool, base: string, env = ENV): AgentConfig => {
  const { label, path, language } = TOOLS[tool];
  const text = vibe(base, env);
  const note = "Add this to the file.";
  return {
    tool,
    label,
    path,
    language,
    content: text,
    filename: path.split("/").pop() ?? path,
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
- Only Vibe and the Vibe CLI are served: a request whose \`User-Agent\` does not contain \`Mistral-Vibe\` gets \`403\` with \`error.type = "mistwatch_not_vibe"\` (config: \`vibe_only\` under \`[limits]\`). Mistral counts other tools towards the API allowance since 1 December 2026, so do not point another tool at this gateway and do not fake the User-Agent.
- \`GET /v1/mistwatch/limits\` lists the 5h, day, week and month windows of every pool; \`GET /v1/billing/budget\` gives the pooled Vibe Code budget and \`GET /v1/billing/subscription\` the plan, both in Mistral's shape.
- Standard \`RateLimit-Policy\`, \`RateLimit\` and \`RateLimit-Limit/Remaining/Reset\` headers come on accounted calls, in euro cents, for the tightest window; a 429 adds \`RateLimit-Remaining: 0\`.
- Response headers on accounted calls: \`x-mw-limits\` (room/cap per window), \`x-mw-account\`, \`x-mw-pool\`, \`x-mw-room-eur\` (what can still be spent now) and, for \`auto\`, \`x-mw-routed\` (the model and effort chosen).

## Set up a tool

- Run one command: \`npx mistwatch setup --yes --harness vibe\`. It creates the config, links the Vibe CLI login, creates a client token (shown once) and writes the tool's provider config. Any file it changes is copied to \`<file>.<timestamp>.bak\` first and merged, never replaced. Safe to run again. Needs Node 24+. If the default port 8787 is taken, add \`--port N\`: it writes the port into config.toml and into the tool configs (\`serve --port N\` alone changes neither).
- Give the token to tools through the environment variable \`${ENV}\`. Never ask the user to paste keys into chat and never print the token again.
- Verify with \`mistwatch status\` and, while the proxy runs, \`curl -H "Authorization: Bearer $${ENV}" ${base}/v1/models\`.
- If the Vibe login is missing, the user runs \`vibe --setup\` and then \`mistwatch import-vibe\`.
- Ask the user before starting \`mistwatch serve\`: it keeps running.
- By hand: \`mistwatch vibe-config\`.
- The same snippets can be copied or downloaded from the web UI: ${base}/#/keys
- Full agent instructions: AGENTS.md in the repository.

## Building an integration

- Read the key from an environment variable (\`${ENV}\`); never write it into a file you commit.
- Default to the model \`auto\` and let the gateway choose.
- On \`429\`, show the user the wait time from \`Retry-After\`. Do not switch models to get around it.
- Use one key per tool so its usage shows up separately under "Spend by key".
`;
