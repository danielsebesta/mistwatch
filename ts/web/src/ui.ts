import { modal } from "./dialog.ts";
import { h, type IconName, ic, type Kid, qs } from "./dom.ts";
import { errMsg } from "./format.ts";
import { toast } from "./toast.ts";

const BADGE_ICON: Record<string, IconName> = { ok: "check", warn: "alert", bad: "x", info: "info" };
export const badge = (tone: string, text: string, title: string | null = null): HTMLSpanElement => {
  const icon = BADGE_ICON[tone];
  return h("span", { class: `badge ${tone || ""}`, title }, icon ? ic(icon) : null, text);
};
export const act =
  <A extends unknown[]>(fn: (...a: A) => Promise<void>): ((...a: A) => Promise<void>) =>
  async (...a) => {
    try {
      await fn(...a);
    } catch (e) {
      toast(errMsg(e), true);
    }
  };
// Toasts sit behind an open modal dialog, so a failure inside one is shown in the dialog itself.
const copyFailed = (b: HTMLElement): void => {
  const dlg = b.closest("dialog");
  if (!dlg) {
    toast("Copy failed", true);
    return;
  }
  const note =
    qs(".copy-err", dlg) ?? dlg.firstElementChild?.appendChild(h("p", { class: "err sm copy-err", role: "alert" }));
  if (note) note.textContent = "Copy failed. Select the text and copy it by hand.";
};
// Rebuilding a list drops focus: remember the focused control's data-fk key and refocus it afterwards.
export const focusedKey = (root: Element): string | null => {
  const a = document.activeElement;
  return a instanceof HTMLElement && root.contains(a) ? (a.dataset.fk ?? "") : null;
};
export const restoreFocus = (root: ParentNode, key: string | null): void => {
  if (key === null || (document.activeElement && document.activeElement !== document.body)) return;
  const t = [...root.querySelectorAll<HTMLElement>("[data-fk]")].find((e) => e.dataset.fk === key) ?? qs("#main h1");
  if (!t) return;
  if (!t.matches("a,button,input,select,textarea,[tabindex]")) t.tabIndex = -1;
  t.focus();
};
export const copyBtn = (text: string, label = "Copy"): HTMLButtonElement => {
  const b = h("button", { class: "btn ghost icon", type: "button", "aria-label": label, title: label });
  b.append(ic("copy"));
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      copyFailed(b);
      return;
    }
    qs(".copy-err", b.closest("dialog") ?? b)?.remove();
    b.replaceChildren(ic("check"));
    b.setAttribute("aria-label", "Copied");
    toast("Copied to clipboard");
    setTimeout(() => {
      b.replaceChildren(ic("copy"));
      b.setAttribute("aria-label", label);
    }, 1600);
  });
  return b;
};
export const codeBlock = (text: string): HTMLElement => h("div", { class: "code" }, h("pre", {}, text), copyBtn(text));
export const pageHead = (title: string, sub: Kid, ...actions: Kid[]): HTMLElement =>
  h(
    "div",
    { class: "page-h" },
    h("div", { class: "grow" }, h("h1", {}, title), sub ? h("p", {}, sub) : null),
    actions.length ? h("div", { class: "act row" }, actions) : null,
  );
export const emptyState = (icon: IconName, title: string, text: string, ...actions: Kid[]): HTMLElement =>
  h(
    "div",
    { class: "empty" },
    h("div", { class: "ei" }, ic(icon)),
    h("h2", {}, title),
    h("p", {}, text),
    actions.length ? h("div", { class: "row" }, actions) : null,
  );
export const skel = (w: string, hgt = "1rem"): HTMLElement =>
  h("div", { class: "sk", style: `width:${w};height:${hgt}` });
export const errState = (msg: string, retry: () => void): HTMLElement =>
  h(
    "div",
    { class: "card" },
    emptyState(
      "alert",
      "Could not load this page",
      msg,
      h("button", { class: "btn", onclick: retry }, ic("refresh"), "Try again"),
    ),
  );
export const fold = (title: Kid, hint: Kid, ...content: Kid[]): HTMLElement =>
  h(
    "details",
    { class: "fold" },
    h("summary", {}, ic("chevron"), h("span", {}, title), hint ? h("span", { class: "mut sm" }, hint) : null),
    h("div", { class: "fb" }, content),
  );
export const td = (label: string, cls: string, ...kids: Kid[]): HTMLTableCellElement =>
  h("td", { "data-l": label, class: cls || "" }, kids);
export const showNewKey = (name: string, secret: string, first?: boolean): void => {
  const m = modal([
    h("h2", {}, first ? "Account created. Your first API key" : `Key "${name}"`),
    h("div", { class: "keybox" }, h("code", {}, secret), copyBtn(secret, "Copy key")),
    h("p", { class: "sm mut" }, "Copy it now. You will not be able to see it again."),
    h("div", { class: "acts" }, h("button", { class: "btn pri", onclick: () => m.remove() }, "Done")),
  ]);
};
