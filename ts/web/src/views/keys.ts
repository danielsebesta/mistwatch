import type { AgentConfig, ApiKeysResponse } from "../../../shared/api.ts";
import { api } from "../api.ts";
import { confirmDlg } from "../dialog.ts";
import { h, ic } from "../dom.ts";
import { ago, errMsg, when } from "../format.ts";
import {
  act,
  codeBlock,
  emptyState,
  errState,
  focusedKey,
  pageHead,
  restoreFocus,
  showNewKey,
  skel,
  td,
} from "../ui.ts";

export const viewKeys = async (main: HTMLElement): Promise<void> => {
  const list = h(
    "div",
    { class: "stack" },
    h("div", { class: "card" }, skel("30%", "1.25rem"), h("div", { style: "height:1rem" }), skel("100%", "4rem")),
  );
  main.append(
    pageHead(
      "API keys",
      "Keys that let your tools (Vibe CLI, Pi, OpenCode, scripts) use Mistwatch. The full key is shown only once, when you create it.",
    ),
    list,
  );
  const load = async () => {
    const fk = focusedKey(list);
    let d: ApiKeysResponse;
    let cfgs: AgentConfig[] = [];
    try {
      d = await api.apikeys();
    } catch (e) {
      list.replaceChildren(errState(errMsg(e), load));
      return;
    }
    try {
      cfgs = await api.agentConfig();
    } catch {
      cfgs = [];
    }
    const nameIn = h("input", {
      class: "input",
      id: "kn",
      "data-fk": "new-name",
      placeholder: "e.g. vibe-cli",
      autocomplete: "off",
      spellcheck: "false",
    });
    const create = act(async () => {
      const r = await api.newApikey(nameIn.value);
      showNewKey(r.key.name, r.secret);
      load();
    });
    nameIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") create();
    });
    const form = h(
      "div",
      { class: "field-row" },
      h("label", { class: "f", for: "kn" }, "New key name", nameIn),
      h("button", { class: "btn pri", "data-fk": "create", onclick: create }, ic("plus"), "Create key"),
    );
    list.replaceChildren(
      h(
        "section",
        { class: "card", "aria-label": "API keys" },
        d.keys.length
          ? h(
              "div",
              { class: "tw" },
              h(
                "table",
                { class: "tbl stack" },
                h(
                  "thead",
                  {},
                  h(
                    "tr",
                    {},
                    h("th", {}, "Name"),
                    h("th", {}, "Key"),
                    h("th", { class: "n" }, "Created"),
                    h("th", { class: "n" }, "Last used"),
                    h("th", {}, h("span", { class: "sr" }, "Actions")),
                  ),
                ),
                h(
                  "tbody",
                  {},
                  d.keys.map((k) =>
                    h(
                      "tr",
                      {},
                      td("Name", "max trunc", h("b", {}, k.name)),
                      td("Key", "", h("code", {}, `${k.prefix}…`)),
                      td("Created", "n", when(k.created)),
                      td("Last used", "n", ago(k.last_used)),
                      td(
                        "",
                        "",
                        h(
                          "button",
                          {
                            class: "btn ghost danger sm",
                            "data-fk": `revoke-${k.id}`,
                            "aria-label": `Revoke key ${k.name}`,
                            onclick: act(async () => {
                              if (
                                await confirmDlg({
                                  title: `Revoke "${k.name}"?`,
                                  body: "Tools using this key stop working immediately.",
                                  ok: "Revoke key",
                                  danger: true,
                                })
                              ) {
                                await api.delApikey(k.id);
                                load();
                              }
                            }),
                          },
                          "Revoke",
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : h(
              "div",
              { style: "margin-bottom:var(--sp-4)" },
              emptyState(
                "key",
                "No keys yet",
                "Without a key, any app on this computer can use Mistwatch. Create one key for each tool.",
              ),
            ),
        d.keys.length ? h("div", { style: "height:var(--sp-4)" }) : null,
        form,
      ),
      toolsCard(cfgs, d.base_url),
    );
    restoreFocus(list, fk);
  };
  load();
};

const toolsCard = (cfgs: AgentConfig[], baseUrl: string): HTMLElement => {
  let cur = 0;
  const panel = h("div", { class: "stack", role: "tabpanel", id: "tool-panel", style: "gap:var(--sp-3)" });
  const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Tool" });
  const show = (i: number) => {
    cur = i;
    const c = cfgs[i];
    if (!c) return;
    tabs.querySelectorAll<HTMLElement>(".tab").forEach((t, j) => {
      t.setAttribute("aria-selected", String(j === i));
      t.tabIndex = j === i ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", `tool-tab-${i}`);
    const dl = () => {
      const a = h("a", {
        href: URL.createObjectURL(new Blob([c.content], { type: "text/plain" })),
        download: c.filename,
      });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    panel.replaceChildren(
      h("div", { class: "sm mut" }, c.tool === "env" ? "Set these variables" : ["Goes in ", h("code", {}, c.path)]),
      codeBlock(c.content),
      h("p", { class: "sm mut" }, c.note),
      ...(c.tool === "env"
        ? [
            h("div", { class: "sm mut" }, "Quick test"),
            codeBlock(
              `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer mw-…" -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`,
            ),
          ]
        : []),
      h(
        "div",
        { class: "row" },
        c.tool === "env" ? null : h("button", { class: "btn", onclick: dl }, ic("download"), `Download ${c.filename}`),
      ),
    );
  };
  cfgs.forEach((c, i) => {
    tabs.append(
      h(
        "button",
        { class: "tab", role: "tab", id: `tool-tab-${i}`, "aria-controls": "tool-panel", onclick: () => show(i) },
        c.label,
      ),
    );
  });
  tabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    show((cur + (e.key === "ArrowRight" ? 1 : cfgs.length - 1)) % cfgs.length);
    tabs.querySelectorAll<HTMLElement>(".tab")[cur]?.focus();
  });
  if (cfgs.length) show(0);
  else panel.append(h("p", { class: "sm mut" }, "Base URL: ", h("code", {}, baseUrl)));
  return h(
    "section",
    { class: "card", "aria-label": "Connect your tools" },
    h(
      "div",
      { class: "card-h" },
      h("h2", {}, "Connect your tools"),
      h("span", { class: "grow" }),
      cfgs.length ? tabs : null,
    ),
    panel,
    h(
      "p",
      { class: "sm mut", style: "margin-top:var(--sp-4)" },
      "Model ",
      h("code", {}, "auto"),
      " picks a model for each request based on how hard it is. ",
      h("code", {}, "auto-fast"),
      " prefers cheaper models, ",
      h("code", {}, "auto-max"),
      " aims for quality. Claude Code and recent Codex need a translating proxy; see ",
      h("a", { href: "/llms.txt", target: "_blank", rel: "noopener" }, "llms.txt"),
      ".",
    ),
  );
};
