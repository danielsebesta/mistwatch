import type { SessionResponse, SummaryResponse, WindowTotal } from "../../shared/api.ts";
import { api, signOut } from "./api.ts";
import { entriesOf, h, type IconName, ic, logoMark, qs } from "./dom.ts";
import { errMsg, eur, pct100 } from "./format.ts";
import { legal, POOL } from "./labels.ts";
import { disposeView, handlers, session } from "./state.ts";
import { act, badge, errState } from "./ui.ts";
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
const isRoute = (x: string): x is RouteKey => Object.hasOwn(ROUTES, x);

// the spending limits of each period, small, in the sidebar
const limitRows = (box: HTMLElement, w: [string, WindowTotal][]): void => {
  box.replaceChildren(
    h("span", { class: "xs mut" }, "Limits right now"),
    ...w.map(([name, t]) => {
      const pct = t.cap > 0 ? pct100((t.spent / t.cap) * 100) : 100;
      const tone = pct >= 95 ? "bad" : pct >= 80 ? "warn" : "";
      return h(
        "div",
        { class: "lim", title: `${eur(t.spent)} of ${eur(t.cap)} spent` },
        h("span", { class: "sm" }, name),
        h(
          "span",
          { class: `num xs ${t.room > 0 ? "mut" : "tx-bad"}` },
          t.room > 0 ? `${eur(t.room)} left` : "none left",
        ),
        h("span", { class: "mini" }, h("i", { class: tone, style: `width:${pct}%` })),
      );
    }),
  );
};

const loadSummary = async (): Promise<void> => {
  const els = document.querySelectorAll<HTMLElement>(".sumv");
  if (!els.length) return;
  let d: SummaryResponse;
  try {
    d = await api.summary();
  } catch {
    return;
  }
  const a = d.all;
  const lim = document.querySelector<HTMLElement>(".side-lim");
  if (lim) {
    if (a)
      limitRows(lim, [
        ["5 hours", a.windows["5h"]],
        ["Day", a.windows.day],
        ["Week", a.windows.week],
        ["Month", a.month],
      ]);
    else lim.replaceChildren();
  }
  els.forEach((el) => {
    el.replaceChildren();
    if (!a) {
      el.append(h("span", { class: "mut sm" }, "No active budget"));
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
};

const render = (): void => {
  disposeView();
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
  document.title = `${ROUTES[route][0]} · Mistwatch`;
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
        h("div", { class: "side-lim", "aria-label": "Limits right now" }),
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
  if (!document.hidden) session.sumTimer = setInterval(loadSummary, 15000);
};

const boot = async (): Promise<string | null> => {
  disposeView();
  clearInterval(session.sumTimer);
  let s: SessionResponse;
  try {
    s = await api.session();
  } catch (e) {
    const msg = errMsg(e);
    // a sign-in form on screen reports the error itself
    if (!qs(".auth form")) {
      document.title = "Mistwatch";
      qs("#app")?.replaceChildren(
        h(
          "div",
          { class: "auth" },
          h(
            "div",
            { class: "box" },
            errState(msg, () => void boot()),
          ),
        ),
      );
    }
    return msg;
  }
  session.me = s.user;
  if (s.setup_needed) viewAuth("setup");
  else if (!session.me) viewAuth("login");
  else render();
  return null;
};
handlers.boot = boot;

window.addEventListener("hashchange", () => {
  if (session.me) {
    render();
    scrollTo(0, 0);
    qs("#main")?.focus({ preventScroll: true });
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    handlers.pause();
    clearInterval(session.sumTimer);
    return;
  }
  if (!session.me) return;
  void loadSummary();
  session.sumTimer = setInterval(loadSummary, 15000);
  handlers.resume();
});
void boot();
