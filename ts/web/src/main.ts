import type { SessionResponse, SummaryResponse } from "../../shared/api.ts";
import { api, signOut } from "./api.ts";
import { entriesOf, h, type IconName, ic, logoMark, qs } from "./dom.ts";
import { eur, pct100 } from "./format.ts";
import { legal, POOL } from "./labels.ts";
import { handlers, session } from "./state.ts";
import { act, badge } from "./ui.ts";
import { viewAccounts } from "./views/accounts.ts";
import { viewAuth } from "./views/auth.ts";
import { viewDash } from "./views/dashboard.ts";
import { viewKeys } from "./views/keys.ts";
import { viewSettings } from "./views/settings.ts";

type RouteDef = [label: string, icon: IconName, view: (main: HTMLElement) => void];
const ROUTES: { "": RouteDef; "#/accounts": RouteDef; "#/keys": RouteDef; "#/settings": RouteDef } = {
  "": ["Overview", "overview", viewDash],
  "#/accounts": ["Accounts", "accounts", viewAccounts],
  "#/keys": ["API keys", "key", viewKeys],
  "#/settings": ["Settings", "settings", viewSettings],
};
type RouteKey = keyof typeof ROUTES;
const isRoute = (x: string): x is RouteKey => x in ROUTES;

async function loadSummary(): Promise<void> {
  const els = document.querySelectorAll<HTMLElement>(".sumv");
  if (!els.length) return;
  let d: SummaryResponse;
  try {
    d = await api.summary();
  } catch {
    return;
  }
  const a = d.all;
  els.forEach((el) => {
    el.replaceChildren();
    if (!a) {
      el.append(h("span", { class: "mut sm" }, "No budget yet"));
      return;
    }
    const used = a.initial_eur ? pct100((a.used_eur / a.initial_eur) * 100) : 0;
    el.title = `${entriesOf(d.pools)
      .map(([p, v]) => `${POOL[p]}: ${eur(v.remaining_eur)} left of ${eur(v.initial_eur)}`)
      .join("\n")}\nCan spend now: ${eur(a.room_eur)}`;
    if (el.dataset.full) el.append(h("span", { class: "xs mut" }, "Left in total"));
    el.append(
      h(
        "span",
        { class: "row nw", style: "gap:.5rem" },
        h("b", { class: "num" }, eur(a.remaining_eur)),
        el.dataset.full ? null : h("span", { class: "mut" }, "left"),
        a.blocked ? badge("bad", "exhausted") : null,
      ),
    );
    if (el.dataset.full) {
      el.append(
        h("span", { class: "mini" }, h("i", { class: a.blocked ? "bad" : "", style: `width:${used}%` })),
        h("span", { class: "xs mut" }, a.blocked ? "All budgets used up" : `Can spend now ${eur(a.room_eur)}`),
      );
    }
  });
}

function render(): void {
  clearInterval(session.timer);
  clearInterval(session.sumTimer);
  const me = session.me;
  const app = qs("#app");
  if (!me || !app) return;
  const route = isRoute(location.hash) ? location.hash : "";
  const links = (cls: boolean): HTMLAnchorElement[] =>
    entriesOf(ROUTES).map(([r, [label, icon]]) =>
      h(
        "a",
        { href: r || "#/", "aria-current": r === route ? "page" : null },
        ic(icon),
        cls ? h("span", {}, label) : label,
      ),
    );
  const main = h("main", { class: "page", id: "main", tabindex: "-1" });
  app.replaceChildren(
    h(
      "div",
      { class: "shell" },
      h(
        "aside",
        { class: "side" },
        h("a", { class: "brand", href: "#/" }, logoMark(), "Mistwatch"),
        h("nav", { class: "nav", "aria-label": "Main" }, links(false)),
        h("a", { class: "side-sum sumv", "data-full": "1", href: "#/", title: "Total across all accounts and keys" }),
        h(
          "div",
          { class: "side-foot" },
          h("span", { class: "who trunc", title: me.username }, me.username),
          h(
            "button",
            { class: "btn ghost icon", "aria-label": "Sign out", title: "Sign out", onclick: act(signOut) },
            ic("logout"),
          ),
        ),
      ),
      h(
        "div",
        { class: "main" },
        h(
          "header",
          { class: "top" },
          h("a", { class: "brand", href: "#/" }, logoMark(), "Mistwatch"),
          h("a", { class: "sumv", href: "#/" }),
        ),
        main,
        legal(),
      ),
    ),
    h("nav", { class: "tabbar", "aria-label": "Main" }, links(true)),
  );
  ROUTES[route][2](main);
  void loadSummary();
  session.sumTimer = setInterval(loadSummary, 15000);
}

async function boot(): Promise<void> {
  clearInterval(session.timer);
  let s: SessionResponse;
  try {
    s = await api.session();
  } catch {
    return;
  }
  session.me = s.user;
  if (s.setup_needed) return viewAuth("setup");
  if (!session.me) return viewAuth("login");
  render();
}
handlers.boot = boot;

window.addEventListener("hashchange", () => {
  if (session.me) {
    render();
    scrollTo(0, 0);
  }
});
void boot();
