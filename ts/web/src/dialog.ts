import { h, type Kid } from "./dom.ts";

export function modal(content: Kid): HTMLDialogElement {
  const d = h("dialog", { class: "dlg" }, h("div", {}, content));
  d.addEventListener("close", () => d.remove());
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
  document.body.append(d);
  d.showModal();
  d.remove = () => {
    if (d.open) d.close();
    else HTMLElement.prototype.remove.call(d);
  };
  return d;
}

export function confirmDlg(o: { title: string; body: string; ok?: string; danger?: boolean }): Promise<boolean> {
  const { title, body, ok = "Confirm", danger = false } = o;
  return new Promise((res) => {
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        res(v);
      }
      m.remove();
    };
    const m = modal([
      h("h2", {}, title),
      h("p", { class: "mut sm" }, body),
      h(
        "div",
        { class: "acts" },
        h("button", { class: "btn", onclick: () => finish(false) }, "Cancel"),
        h("button", { class: `btn ${danger ? "danger solid" : "pri"}`, onclick: () => finish(true) }, ok),
      ),
    ]);
    m.addEventListener("close", () => finish(false));
  });
}
