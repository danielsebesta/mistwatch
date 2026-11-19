import type { AccountsResponse, AccountView, Pool, SignInAttempt, SyncedPools } from "../../../shared/api.ts";
import { api } from "../api.ts";
import { confirmDlg, modal } from "../dialog.ts";
import { entriesOf, h, ic } from "../dom.ts";
import { errMsg, eur } from "../format.ts";
import { POOL, planName, poolLabel, SRC } from "../labels.ts";
import { toast } from "../toast.ts";
import { act, badge, emptyState, errState, focusedKey, pageHead, restoreFocus, skel } from "../ui.ts";

export const viewAccounts = async (main: HTMLElement): Promise<void> => {
  const list = h(
    "div",
    { class: "stack" },
    h("div", { class: "card" }, skel("30%", "1.25rem"), h("div", { style: "height:1rem" }), skel("100%", "4rem")),
  );
  main.append(
    pageHead(
      "Accounts",
      "Vibe Code uses the key from the Vibe CLI sign-in and the subscription budget. Studio (API) uses a key from console.mistral.ai and a separate API budget.",
    ),
    list,
  );
  const load = async () => {
    const fk = focusedKey(list);
    let d: AccountsResponse;
    try {
      d = await api.accounts();
    } catch (e) {
      list.replaceChildren(errState(errMsg(e), load));
      return;
    }
    // accounts are not named by hand: a key or a sign-in is filed under the person it belongs to
    const form = h(
      "div",
      { class: "card" },
      h("div", { class: "card-h" }, h("h2", {}, "Add a key")),
      h(
        "p",
        { class: "mut sm" },
        "Mistwatch asks Mistral who the key belongs to and files it under that person's e-mail or organization.",
      ),
      h(
        "div",
        { class: "row", style: "gap:var(--sp-2);flex-wrap:wrap" },
        h(
          "button",
          { class: "btn pri", "data-fk": "add-signin", onclick: () => signIn(null, load) },
          ic("plus"),
          "Sign in with Mistral",
        ),
        d.vibe_cli_available
          ? h(
              "button",
              {
                class: "btn",
                "data-fk": "add-vibe-cli",
                onclick: act(async () => {
                  await api.addKey({ source: "vibe-cli" });
                  toast("Vibe CLI login added");
                  load();
                }),
              },
              "Use Vibe CLI login",
            )
          : null,
        h("button", { class: "btn", "data-fk": "add-paste", onclick: () => pasteNewKey(load) }, "Paste a key"),
      ),
    );
    list.replaceChildren(
      ...(d.accounts.length ? d.accounts.map((a) => accountCard(a, d.vibe_cli_available, load)) : []),
      form,
    );
    if (!d.accounts.length) {
      list.prepend(
        h(
          "div",
          { class: "card" },
          emptyState(
            "accounts",
            "No accounts yet",
            "Sign in with Mistral or paste a key below. Keys of the same person are grouped automatically.",
          ),
        ),
      );
    }
    restoreFocus(list, fk);
  };
  load();
};

const accountCard = (a: AccountView, vibeCli: boolean, reload: () => void): HTMLElement => {
  const fk = (s: string): string => `${a.name}:${s}`;
  const prio = h("input", {
    class: "input short",
    type: "number",
    inputmode: "numeric",
    value: a.priority,
    id: `pr-${a.name}`,
    "data-fk": fk("priority"),
    title: "Lower number is used first",
  });
  let savedPrio = String(a.priority);
  prio.addEventListener(
    "change",
    act(async () => {
      const v = prio.value.trim();
      try {
        if (!/^-?\d+$/.test(v)) throw new Error("Priority must be a whole number.");
        await api.patchAccount(a.name, { priority: Number(v) });
      } catch (e) {
        prio.value = savedPrio;
        throw e;
      }
      savedPrio = v;
      toast("Priority saved");
    }),
  );
  const sw = h("button", {
    class: "switch",
    role: "switch",
    type: "button",
    "aria-checked": String(!!a.enabled),
    "aria-label": "Enabled",
    "data-fk": fk("enabled"),
    onclick: act(async () => {
      await api.patchAccount(a.name, { enabled: !a.enabled });
      reload();
    }),
  });
  // who Mistral says the keys belong to; read once per card, shown beside each key
  const owners = a.keys.vibe || a.keys.api ? api.owner(a.name).catch(() => null) : Promise.resolve(null);
  const titleEl = h("h2", { class: "trunc", title: a.name }, a.name);
  const subEl = h("div", { class: "xs mut trunc" });
  const planEl = h("span", {});
  void owners.then((o) => {
    const person = o?.vibe ?? o?.api;
    if (!person) return;
    if (person.name) {
      titleEl.textContent = person.name;
      subEl.textContent = person.email ?? a.name;
    }
    if (o?.vibe?.plan) planEl.replaceWith(badge("info", planName(o.vibe.plan)));
  });
  const keyRow = (pool: Pool) => {
    const k = a.keys[pool];
    const who = h("span", { class: "mut" });
    void owners.then((o) => {
      const t = o?.[pool];
      if (!t) return;
      // the Vibe budget belongs to the person's plan, the Studio budget to the workspace
      const text = pool === "vibe" ? (t.plan ? `${planName(t.plan)} plan` : "") : (t.organization ?? t.workspace ?? "");
      if (text) who.textContent = `· ${pool === "vibe" ? text : `workspace ${text}`}`;
    });
    const kl = h(
      "div",
      { class: "kl" },
      h("b", { class: "sm" }, POOL[pool]),
      k ? (k.ok ? badge("ok", "Connected") : badge("bad", "Can't read key")) : badge("", "Missing"),
    );
    const ki = h(
      "div",
      { class: "ki" },
      k
        ? [
            h("code", { title: k.hint ?? "" }, k.hint || "—"),
            h("span", {}, `· ${SRC[k.source] ?? k.source}`),
            k.error ? h("span", { class: "tx-bad" }, `· ${k.error}`) : null,
            who,
          ]
        : "No key",
    );
    const btns: HTMLButtonElement[] = [];
    if (pool === "vibe")
      btns.push(
        h(
          "button",
          { class: "btn", "data-fk": fk(`${pool}-signin`), onclick: () => signIn(a.name, reload) },
          k ? "Sign in again" : "Sign in with Mistral",
        ),
      );
    if (pool === "vibe" && vibeCli && !(k && k.source === "vibe-cli")) {
      btns.push(
        h(
          "button",
          {
            class: "btn",
            "data-fk": fk("vibe-cli"),
            onclick: act(async () => {
              const r = await api.putKey(a.name, "vibe", { source: "vibe-cli" });
              toast(`Connected to Vibe CLI${syncNote(r)}`);
              reload();
            }),
          },
          "Use Vibe CLI",
        ),
      );
    }
    btns.push(
      h(
        "button",
        { class: "btn", "data-fk": fk(`${pool}-paste`), onclick: () => pasteKey(a.name, pool, reload) },
        k ? "Change key" : "Paste key",
      ),
    );
    if (k) {
      btns.push(
        h(
          "button",
          {
            class: "btn ghost danger",
            "data-fk": fk(`${pool}-remove`),
            "aria-label": `Remove ${POOL[pool]} key`,
            onclick: act(async () => {
              if (
                await confirmDlg({
                  title: "Remove this key?",
                  body: `The ${POOL[pool]} key of ${a.name} will be forgotten. Budget tracking for it stops until you add a key again.`,
                  ok: "Remove key",
                  danger: true,
                })
              ) {
                await api.delKey(a.name, pool);
                reload();
              }
            }),
          },
          "Remove",
        ),
      );
    }
    return h("div", { class: "keyrow" }, kl, ki, h("div", { class: "ka" }, btns));
  };
  return h(
    "section",
    { class: "card acct", "aria-label": `Account ${a.name}` },
    h(
      "div",
      { class: "acct-h" },
      h("div", { class: "acct-t" }, titleEl, subEl),
      planEl,
      a.enabled ? null : badge("warn", "Disabled"),
      a.shared_with.length
        ? h(
            "span",
            { class: "badge info", title: "Same Mistral account, counted as one budget" },
            `shares budget with ${a.shared_with.join(", ")}`,
          )
        : null,
      h("span", { class: "grow" }),
      h("label", { class: "row nw sm mut", style: "gap:var(--sp-2)" }, "Priority", prio),
      h("label", { class: "row nw sm mut", style: "gap:var(--sp-2)" }, "Enabled", sw),
      h(
        "button",
        {
          class: "btn ghost danger icon",
          "data-fk": fk("delete"),
          "aria-label": `Delete account ${a.name}`,
          title: "Delete account",
          onclick: act(async () => {
            if (
              await confirmDlg({
                title: `Delete ${a.name}?`,
                body: "The account and its keys are removed. Usage history is kept.",
                ok: "Delete account",
                danger: true,
              })
            ) {
              await api.delAccount(a.name);
              reload();
            }
          }),
        },
        ic("trash"),
      ),
    ),
    keyRow("vibe"),
    keyRow("api"),
  );
};

const syncNote = (r: { synced?: SyncedPools }): string => {
  const parts = entriesOf(r.synced ?? {}).map(([p, v]) => `${poolLabel(p)}: ${eur(v.used)} / ${eur(v.initial)}`);
  return parts.length ? ` · ${parts.join(", ")}` : "";
};

// Sign-in runs in a new Mistral tab; we poll until the key lands.
// name null: a new sign-in, filed under whoever signed in once it is done
const signIn = async (name: string | null, reload: () => void): Promise<void> => {
  // opened inside the click so popup blockers allow it
  const tab = window.open("", "_blank");
  let att: SignInAttempt;
  try {
    att = name === null ? await api.newSignin() : await api.startSignin(name);
  } catch (e) {
    tab?.close();
    toast(errMsg(e), true);
    return;
  }
  if (tab) {
    // the Mistral page must not reach back into this one
    tab.opener = null;
    tab.location.href = att.sign_in_url;
  }
  const msg = h("p", { class: "mut sm", role: "status" }, "Waiting for sign-in in the browser…");
  let stopped = false;
  let settled = false;
  const m = modal([
    h("h2", {}, "Sign in with Mistral"),
    h(
      "p",
      { class: "mut sm" },
      "In the new tab, sign in to Mistral and choose a workspace. This page finishes automatically.",
    ),
    h("a", { href: att.sign_in_url, target: "_blank", rel: "noopener", class: "sm" }, "Open the sign-in page again"),
    msg,
    h(
      "div",
      { class: "acts" },
      h(
        "button",
        {
          class: "btn",
          onclick: () => m.remove(),
        },
        "Cancel",
      ),
    ),
  ]);
  // closing by any route (Cancel, Escape, backdrop) abandons the attempt
  m.addEventListener("close", () => {
    stopped = true;
    if (!settled) {
      api.signinCancel(att.id).catch(() => null);
      if (name === null) api.delAccount(att.account).catch(() => null);
    }
  });
  while (!stopped && document.body.contains(m)) {
    await new Promise((r) => setTimeout(r, 2000));
    if (stopped) return;
    let s: SignInAttempt;
    try {
      s = await api.signinStatus(att.id);
    } catch (e) {
      msg.textContent = errMsg(e);
      msg.className = "err";
      return;
    }
    if (s.status === "done") {
      stopped = true;
      settled = true;
      m.remove();
      if (name === null) {
        try {
          const r = await api.adopt(att.account);
          const to = r.adopted[0]?.account;
          toast(to ? `Signed in as ${to}` : "Signed in");
        } catch (e) {
          toast(errMsg(e), true);
        }
      } else toast(`Signed in${syncNote(s)}`);
      reload();
      return;
    }
    if (!["pending", "exchanging"].includes(s.status)) {
      stopped = true;
      if (name === null) api.delAccount(att.account).catch(() => null);
      msg.textContent = s.message || "Sign-in failed.";
      msg.className = "err";
      return;
    }
    if (s.status === "exchanging") msg.textContent = "Finishing…";
  }
};

const pasteKey = (name: string, pool: Pool, reload: () => void): void => {
  const inp = h("input", {
    class: "input",
    id: "pk",
    type: "password",
    placeholder: pool === "vibe" ? "Vibe CLI key" : "API key from console.mistral.ai",
    autocomplete: "off",
    spellcheck: "false",
  });
  const msg = h("div", { class: "err", role: "alert" });
  const save = h(
    "button",
    {
      class: "btn pri",
      onclick: async () => {
        save.disabled = true;
        msg.textContent = "";
        try {
          const r = await api.putKey(name, pool, { key: inp.value });
          m.remove();
          toast(`Key saved${syncNote(r)}`);
          reload();
        } catch (e) {
          msg.textContent = errMsg(e);
          save.disabled = false;
        }
      },
    },
    "Verify and save",
  );
  const m = modal([
    h("h2", {}, `${POOL[pool]} key`),
    h(
      "p",
      { class: "mut sm" },
      `For account ${name}. Mistwatch checks the key with Mistral, then stores it securely on this computer. It is never shown in full.`,
    ),
    h("label", { class: "f", for: "pk" }, "Key", inp),
    msg,
    h("div", { class: "acts" }, h("button", { class: "btn", onclick: () => m.remove() }, "Cancel"), save),
  ]);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save.click();
  });
  inp.focus();
};

const pasteNewKey = (reload: () => void): void => {
  const inp = h("input", {
    class: "input",
    id: "pk",
    type: "password",
    placeholder: "Vibe CLI key or API key",
    autocomplete: "off",
    spellcheck: "false",
  });
  const msg = h("div", { class: "err", role: "alert" });
  const save = h(
    "button",
    {
      class: "btn pri",
      onclick: async () => {
        save.disabled = true;
        msg.textContent = "";
        try {
          const r = await api.addKey({ key: inp.value });
          m.remove();
          const to = r.adopted[0]?.account;
          toast(to ? `Key added to ${to}` : "Key added");
          reload();
        } catch (e) {
          msg.textContent = errMsg(e);
          save.disabled = false;
        }
      },
    },
    "Verify and add",
  );
  const m = modal([
    h("h2", {}, "Paste a key"),
    h(
      "p",
      { class: "mut sm" },
      "Mistwatch checks the key with Mistral, finds out whose it is and which budget it belongs to, and stores it securely on this computer.",
    ),
    h("label", { class: "f", for: "pk" }, "Key", inp),
    msg,
    h("div", { class: "acts" }, h("button", { class: "btn", onclick: () => m.remove() }, "Cancel"), save),
  ]);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save.click();
  });
  inp.focus();
};
