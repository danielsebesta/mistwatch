import type { ModelRow } from "../../../shared/api.ts";
import { api, signOut } from "../api.ts";
import { confirmDlg } from "../dialog.ts";
import { h, ic, qs } from "../dom.ts";
import { errMsg, when } from "../format.ts";
import { NAME_SRC } from "../labels.ts";
import { session } from "../state.ts";
import { toast } from "../toast.ts";
import { act, focusedKey, pageHead, restoreFocus, skel, td } from "../ui.ts";

export const viewSettings = async (main: HTMLElement): Promise<void> => {
  const me = session.me;
  if (!me) return;
  const old = h("input", { class: "input", id: "pw0", type: "password", autocomplete: "current-password" });
  const nw = h("input", { class: "input", id: "pw1", type: "password", autocomplete: "new-password" });
  const change = act(async () => {
    await api.password({ old: old.value, new: nw.value });
    old.value = nw.value = "";
    toast("Password changed. Other sessions were signed out.");
  });
  main.append(
    pageHead("Settings", "Sign-in and how models are named."),
    h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "cols" },
        h(
          "section",
          { class: "card" },
          h("div", { class: "card-h" }, h("h2", {}, "Account")),
          h(
            "div",
            { class: "stack" },
            h("label", { class: "f", for: "pw0" }, "Current password", old),
            h("label", { class: "f", for: "pw1" }, "New password (10+ characters)", nw),
            h(
              "div",
              { class: "row" },
              h("button", { class: "btn pri", onclick: change }, "Change password"),
              h("span", { class: "grow" }),
              h("span", { class: "sm mut" }, "Signed in as ", h("b", {}, me.username)),
              h("button", { class: "btn", onclick: act(signOut) }, ic("logout"), "Sign out"),
            ),
          ),
        ),
        h(
          "section",
          { class: "card", id: "ulist" },
          skel("30%", "1.25rem"),
          h("div", { style: "height:1rem" }),
          skel("100%", "3rem"),
        ),
      ),
      h(
        "section",
        { class: "card", id: "mlist" },
        skel("30%", "1.25rem"),
        h("div", { style: "height:1rem" }),
        skel("100%", "6rem"),
      ),
    ),
  );
  modelNames();
  const load = act(async () => {
    const box = qs("#ulist");
    const fk = box ? focusedKey(box) : null;
    const us = await api.users();
    const un = h("input", {
      class: "input",
      id: "un",
      "data-fk": "new-user",
      autocomplete: "off",
      spellcheck: "false",
    });
    const up = h("input", { class: "input", id: "up", type: "password", autocomplete: "new-password" });
    box?.replaceChildren(
      h("div", { class: "card-h" }, h("h2", {}, "Users")),
      h(
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
              h("th", {}, "User"),
              h("th", { class: "n" }, "Since"),
              h("th", {}, h("span", { class: "sr" }, "Actions")),
            ),
          ),
          h(
            "tbody",
            {},
            us.map((u) =>
              h(
                "tr",
                {},
                td(
                  "User",
                  "",
                  u.username,
                  u.username === me.username ? h("span", { class: "badge", style: "margin-left:.5rem" }, "you") : null,
                ),
                td("Since", "n", when(u.created)),
                td(
                  "",
                  "",
                  u.username === me.username
                    ? ""
                    : h(
                        "button",
                        {
                          class: "btn ghost danger sm",
                          "data-fk": `del-${u.id}`,
                          "aria-label": `Delete user ${u.username}`,
                          onclick: act(async () => {
                            if (
                              await confirmDlg({
                                title: `Delete user ${u.username}?`,
                                body: "They will no longer be able to sign in.",
                                ok: "Delete user",
                                danger: true,
                              })
                            ) {
                              await api.delUser(u.id);
                              load();
                            }
                          }),
                        },
                        "Delete",
                      ),
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        "div",
        { class: "field-row", style: "margin-top:var(--sp-4)" },
        h("label", { class: "f", for: "un" }, "New user", un),
        h("label", { class: "f", for: "up" }, "Password", up),
        h(
          "button",
          {
            class: "btn",
            "data-fk": "add-user",
            onclick: act(async () => {
              await api.addUser({ username: un.value, password: up.value });
              toast("User added");
              load();
            }),
          },
          ic("plus"),
          "Add user",
        ),
      ),
    );
    restoreFocus(box ?? document, fk);
  });
  load();
};

const modelNames = async (showAll = false): Promise<void> => {
  const box = qs("#mlist");
  if (!box) return;
  const fk = focusedKey(box);
  let rows: ModelRow[];
  try {
    rows = await api.models(showAll);
  } catch (e) {
    toast(errMsg(e), true);
    return;
  }
  const all = h("input", {
    type: "checkbox",
    checked: showAll,
    "data-fk": "all",
    onchange: () => modelNames(all.checked),
  });
  box.replaceChildren(
    h(
      "div",
      { class: "card-h" },
      h("h2", {}, "Model names"),
      h("span", { class: "grow" }),
      h("label", { class: "check" }, all, "All Mistral models"),
      h(
        "button",
        {
          class: "btn",
          "data-fk": "refresh",
          onclick: act(async () => {
            const r = await api.refreshModels();
            toast(`Loaded ${r.models} models from Mistral`);
            modelNames(showAll);
          }),
        },
        ic("refresh"),
        "Refresh",
      ),
    ),
    h(
      "p",
      { class: "mut sm", style: "margin:calc(var(--sp-2)*-1) 0 var(--sp-4)" },
      "Choose how models are named in charts and tables. Different IDs of the same model are combined. Edit a name and press Enter.",
    ),
    h(
      "div",
      { class: "tw" },
      h(
        "table",
        { class: "tbl wide" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "Model ID"),
            h("th", {}, "Shown as"),
            h("th", {}, "Source"),
            h("th", {}, h("span", { class: "sr" }, "Actions")),
          ),
        ),
        h(
          "tbody",
          {},
          rows.map((r) => {
            const inp = h("input", {
              class: "input",
              value: r.display,
              "data-fk": `name-${r.key}`,
              "aria-label": `Display name for ${r.ids[0] ?? ""}`,
            });
            const save = act(async () => {
              if (inp.value.trim() && inp.value.trim() !== r.display) {
                await api.renameModel(r.key, { display: inp.value });
                toast("Saved");
                modelNames(showAll);
              }
            });
            inp.addEventListener("keydown", (e) => {
              if (e.key === "Enter") save();
            });
            inp.addEventListener("blur", save);
            const [label, tone] = NAME_SRC[r.source] ?? [r.source, ""];
            return h(
              "tr",
              {},
              h(
                "td",
                { title: r.description ?? "" },
                h("code", {}, r.ids[0] ?? ""),
                r.ids.length > 1 ? h("span", { class: "mut xs" }, ` +${r.ids.length - 1} aliases`) : null,
              ),
              h("td", {}, inp),
              h("td", {}, h("span", { class: `badge ${tone}` }, label)),
              h(
                "td",
                {},
                r.source === "custom"
                  ? h(
                      "button",
                      {
                        class: "btn ghost sm",
                        "data-fk": `reset-${r.key}`,
                        onclick: act(async () => {
                          await api.resetModel(r.key);
                          modelNames(showAll);
                        }),
                      },
                      "Reset",
                    )
                  : "",
              ),
            );
          }),
        ),
      ),
    ),
  );
  restoreFocus(box, fk);
};
