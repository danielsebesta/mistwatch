import { ApiError, api } from "../api.ts";
import { h, ic, logoMark, qs } from "../dom.ts";
import { errMsg } from "../format.ts";
import { DISCLAIMER } from "../labels.ts";
import { handlers } from "../state.ts";
import { showNewKey } from "../ui.ts";

export function viewAuth(mode: "setup" | "login"): void {
  const setup = mode === "setup";
  const u = h("input", {
    class: "input",
    id: "u",
    autocomplete: "username",
    autocapitalize: "none",
    spellcheck: "false",
    required: true,
  });
  const p = h("input", {
    class: "input",
    id: "p",
    type: "password",
    autocomplete: setup ? "new-password" : "current-password",
    required: true,
  });
  const p2 = setup
    ? h("input", { class: "input", id: "p2", type: "password", autocomplete: "new-password", required: true })
    : null;
  const err = h("div", { class: "err", role: "alert" });
  const btn = h("button", { class: "btn pri wide", type: "submit" }, setup ? "Create account" : "Sign in");
  let lock: number | undefined;
  const startLock = (secs: number) => {
    clearInterval(lock);
    let left = secs;
    btn.disabled = true;
    const tick = () => {
      if (left <= 0) {
        clearInterval(lock);
        btn.disabled = false;
        err.replaceChildren();
        return;
      }
      err.replaceChildren(
        h("div", { class: "notice warn" }, ic("clock"), h("span", {}, `Too many attempts. Try again in ${left} s.`)),
      );
      left--;
    };
    tick();
    lock = setInterval(tick, 1000);
  };
  const go = async (e: SubmitEvent) => {
    e.preventDefault();
    err.replaceChildren();
    if (setup && p2 && p.value !== p2.value) {
      err.textContent = "Passwords do not match.";
      return;
    }
    btn.disabled = true;
    try {
      const r = setup
        ? await api.setup({ username: u.value, password: p.value })
        : await api.login({ username: u.value, password: p.value });
      await handlers.boot();
      if ("api_key" in r && r.api_key) showNewKey(r.api_key.name, r.api_key.secret, true);
    } catch (ex) {
      const m = ex instanceof ApiError && ex.status === 429 ? /(\d+)\s*s/.exec(ex.message) : null;
      const secs = m?.[1];
      if (secs) startLock(Number(secs));
      else {
        err.textContent = errMsg(ex);
        btn.disabled = false;
      }
    }
  };
  qs("#app")?.replaceChildren(
    h(
      "div",
      { class: "auth" },
      h(
        "div",
        { class: "box" },
        h("div", { class: "brand" }, logoMark(), "Mistwatch"),
        h(
          "form",
          { class: "card", onsubmit: go, novalidate: true },
          h("h1", {}, setup ? "Create your account" : "Sign in"),
          setup ? h("p", { class: "lead" }, "Create the first account. It manages keys and limits.") : null,
          h("label", { class: "f", for: "u" }, "Username", u),
          h("label", { class: "f", for: "p" }, "Password", p),
          setup ? h("label", { class: "f", for: "p2" }, "Password again", p2) : null,
          setup ? h("p", { class: "xs mut" }, "At least 10 characters.") : null,
          err,
          btn,
        ),
        h("p", { class: "foot" }, DISCLAIMER),
      ),
    ),
  );
  u.focus();
}
