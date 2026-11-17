import { h, ic } from "./dom.ts";

export function toast(msg: string, bad?: boolean): void {
  const box = document.querySelector(bad ? "#alerts" : "#toasts");
  if (!box) return;
  const t = h("div", { class: `toast${bad ? " bad" : ""}` }, ic(bad ? "alert" : "check"), h("span", {}, msg));
  box.replaceChildren(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3200);
}
