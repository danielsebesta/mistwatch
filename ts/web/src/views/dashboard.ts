import type {
  AggStatus,
  LedgerRow,
  PoolStatus,
  PoolWindow,
  StatusResponse,
  Summary,
  UsageBy,
  UsageRange,
  UsageResponse,
  WindowTotal,
} from "../../../shared/api.ts";
import { api } from "../api.ts";
import { entriesOf, h, ic, type Kid, keysOf, svg } from "../dom.ts";
import { latest, stepTab } from "../flow.ts";
import { ago, errMsg, eur, eur4, niceMax, pct100, plural, short, when } from "../format.ts";
import { asBy, asRange, BYS, colorOf, PERIOD_DAYS, poolLabel, RANGE_DAYS, RANGES, winLabel } from "../labels.ts";
import { handlers, pref } from "../state.ts";
import { toast } from "../toast.ts";
import { act, badge, emptyState, errState, fold, pageHead, skel, td } from "../ui.ts";

type SetPref = (k: "range" | "by", v: string) => void;

const refresh = (slot: HTMLElement, kids: HTMLElement[]): void => {
  // Keep a focused control alive; the next refresh replaces the slot.
  if (!slot.contains(document.activeElement)) slot.replaceChildren(...kids);
};

type Controls = { head: HTMLElement; sync: (range: UsageRange, by: UsageBy) => void };

const chartControls = (set: SetPref): Controls => {
  const keys = keysOf(RANGES);
  const tabs = keys.map((r) => h("button", { class: "tab", role: "tab", onclick: () => set("range", r) }, r));
  const strip = h("div", { class: "tabs", role: "tablist", "aria-label": "Time range" }, tabs);
  strip.addEventListener("keydown", (e) => {
    const from = tabs.findIndex((t) => t === document.activeElement);
    const to = stepTab(tabs.length, from, e.key);
    const next = to === null ? undefined : keys[to];
    if (next === undefined) return;
    e.preventDefault();
    tabs[to ?? 0]?.focus();
    set("range", next);
  });
  const sel = h(
    "select",
    { class: "input", style: "width:auto", "aria-label": "Split spending by", onchange: () => set("by", sel.value) },
    entriesOf(BYS).map(([k, v]) => h("option", { value: k }, `by ${v.toLowerCase()}`)),
  );
  const sync = (range: UsageRange, by: UsageBy): void => {
    tabs.forEach((t, i) => {
      const on = keys[i] === range;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    });
    if (sel.value !== by) sel.value = by;
  };
  return {
    head: h("div", { class: "card-h" }, h("h2", {}, "Spending"), h("span", { class: "grow" }), strip, sel),
    sync,
  };
};

export const viewDash = async (main: HTMLElement): Promise<void> => {
  let range = asRange(pref.get("range", "7d"));
  let by = asBy(pref.get("by", "model"));
  let active = true;
  let timer = 0;
  const guard = latest();
  const syncMeta = h("p", {}, "Loading…");
  const body = h("div", { class: "stack" }, dashSkeleton());
  const slot = (): HTMLElement => h("div", { style: "display:contents" });
  const topSlot = slot();
  const chartSlot = slot();
  const restSlot = slot();
  const set: SetPref = (k, v) => {
    if (k === "range") range = asRange(v);
    else by = asBy(v);
    pref.set(k, v);
    controls.sync(range, by);
    void load();
  };
  const controls = chartControls(set);
  const chartSec = h("section", { class: "card", "aria-label": "Spending over time" }, controls.head, chartSlot);
  controls.sync(range, by);
  const load = async (): Promise<void> => {
    const ticket = guard.next();
    const [r, b] = [range, by];
    let d: StatusResponse, u: UsageResponse, led: LedgerRow[];
    try {
      [d, u, led] = await Promise.all([api.status(), api.usage(r, b), api.ledger(18)]);
    } catch (e) {
      if (active && guard.isCurrent(ticket) && body.isConnected && !body.dataset.ok)
        body.replaceChildren(errState(errMsg(e), load));
      return;
    }
    if (!active || !guard.isCurrent(ticket) || !body.isConnected) return;
    if (!body.dataset.ok) body.replaceChildren(topSlot, chartSec, restSlot);
    body.dataset.ok = "1";
    syncMeta.textContent = `Last sync with Mistral: ${d.last_sync ? ago(d.last_sync) : "not yet"}`;
    const parts = dashBody(d, u, led, r, b);
    chartSec.hidden = !parts.chart;
    refresh(topSlot, parts.top);
    refresh(chartSlot, parts.chart ?? []);
    refresh(restSlot, parts.rest);
  };
  const syncBtn = h(
    "button",
    {
      class: "btn",
      onclick: act(async () => {
        toast("Syncing with Mistral…");
        await api.sync();
        void load();
      }),
    },
    ic("refresh"),
    "Sync now",
  );
  const stop = (): void => {
    clearInterval(timer);
    timer = 0;
  };
  const poll = (): void => {
    stop();
    if (active && !document.hidden) timer = setInterval(() => void load(), 10000);
  };
  handlers.pause = stop;
  handlers.resume = () => {
    if (!active) return;
    poll();
    void load();
  };
  handlers.dispose = () => {
    active = false;
    stop();
  };
  main.append(pageHead("Overview", syncMeta, syncBtn), body);
  await load();
  poll();
};

const dashSkeleton = (): HTMLElement => {
  return h(
    "div",
    { class: "stack", "aria-busy": "true", "aria-label": "Loading" },
    h(
      "div",
      { class: "strip" },
      [0, 1, 2, 3].map(() =>
        h("div", { class: "cell" }, skel("40%", ".75rem"), skel("65%", "1.75rem"), skel("80%", ".75rem")),
      ),
    ),
    h("div", { class: "card" }, skel("30%", "1rem"), h("div", { style: "height:1rem" }), skel("100%", "10rem")),
    h(
      "div",
      { class: "cols" },
      h("div", { class: "card" }, skel("50%"), h("div", { style: "height:.75rem" }), skel("100%", "5rem")),
      h("div", { class: "card" }, skel("50%"), h("div", { style: "height:.75rem" }), skel("100%", "5rem")),
    ),
  );
};

const windowTable = (rows: [string, WindowTotal | PoolWindow][]): HTMLElement => {
  return h(
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
          h("th", {}, "Period"),
          h("th", { class: "n" }, "Spent"),
          h("th", { class: "n" }, "Limit"),
          h("th", { class: "n" }, "Left"),
          h("th", {}, ""),
        ),
      ),
      h(
        "tbody",
        {},
        rows.map(([n, w]) =>
          h(
            "tr",
            {},
            td("Period", "", n),
            td("Spent", "n", eur(w.spent)),
            td("Limit", "n", eur(w.cap)),
            td("Left", `n ${w.room > 0 ? "tx-ok" : "tx-bad"}`, eur(w.room)),
            td("", "mut xs", "retry_at" in w && w.retry_at ? `free from ${when(w.retry_at)}` : ""),
          ),
        ),
      ),
    ),
  );
};

const dashBody = (
  d: StatusResponse,
  u: UsageResponse,
  led: LedgerRow[],
  range: UsageRange,
  by: UsageBy,
): { top: HTMLElement[]; chart: HTMLElement[] | null; rest: HTMLElement[] } => {
  const sm = d.summary;
  const a = sm.all;
  if (!a) {
    return {
      chart: null,
      rest: [],
      top: [
        h(
          "div",
          { class: "card" },
          emptyState(
            "key",
            "Nothing to watch yet",
            "Add a Mistral account and key. Mistwatch will track your budget and help you spread it out.",
            h("a", { class: "btn pri", href: "#/accounts" }, ic("plus"), "Add an account"),
          ),
        ),
      ],
    };
  }
  const poolRows = d.pools.filter((p) => p.account === p.group);
  const split = h(
    "div",
    { class: "dash-split" },
    h("div", { class: "stack aside" }, poolsCard(sm, poolRows), limitsCard(a)),
    led.length
      ? h(
          "div",
          { class: "card rec" },
          h(
            "div",
            { class: "card-h" },
            h("h2", {}, "Recent requests"),
            h("span", { class: "mut sm" }, `latest ${led.length}`),
          ),
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
                  h("th", {}, "When"),
                  h("th", {}, "Key"),
                  h("th", {}, "Model"),
                  h("th", { class: "n" }, "Tokens in / out"),
                  h("th", { class: "n" }, "Cost"),
                ),
              ),
              h(
                "tbody",
                {},
                led.map((r) =>
                  h(
                    "tr",
                    {},
                    td("When", "", when(r.ts)),
                    td("Key", "max trunc", r.client || "—"),
                    h(
                      "td",
                      { "data-l": "Model", class: "max trunc", title: r.model ?? "" },
                      r.model_name ?? r.endpoint ?? "—",
                    ),
                    td(
                      "Tokens in / out",
                      "n",
                      r.prompt_tokens !== null ? `${r.prompt_tokens} / ${r.completion_tokens ?? 0}` : "—",
                    ),
                    td("Cost", "n", eur4(r.cost_eur)),
                  ),
                ),
              ),
            ),
          ),
        )
      : h(
          "div",
          { class: "card rec" },
          h("div", { class: "card-h" }, h("h2", {}, "Recent requests")),
          emptyState(
            "clock",
            "No requests yet",
            "Requests sent through Mistwatch show up here.",
            h("a", { class: "btn", href: "#/keys" }, "Create an API key"),
          ),
        ),
  );
  const fl = h(
    "div",
    {},
    fold(
      "Limits per budget",
      "spent and what is left",
      ...poolRows.map((p) =>
        h(
          "div",
          { style: "margin-bottom:var(--sp-4)" },
          h("div", { class: "sm mut", style: "margin:var(--sp-2) 0" }, `${p.account} · ${poolLabel(p.pool)}`),
          windowTable([
            ["Month", p.month],
            ...entriesOf(p.windows).map(([n, w]) => [winLabel(n), w] as [string, PoolWindow]),
          ]),
        ),
      ),
    ),
    d.by_client_7d.length
      ? fold(
          "Spend by key",
          "last 7 days",
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
                  h("th", {}, "Key"),
                  h("th", {}, "Account / budget"),
                  h("th", { class: "n" }, "Requests"),
                  h("th", { class: "n" }, "Cost"),
                ),
              ),
              h(
                "tbody",
                {},
                d.by_client_7d.map((r) =>
                  h(
                    "tr",
                    {},
                    td("Key", "max trunc", r.client),
                    td("Account / budget", "max trunc", `${r.account} / ${poolLabel(r.pool)}`),
                    td("Requests", "n", r.n),
                    td("Cost", "n", eur(r.cost_eur)),
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
  );
  return { top: [summaryStrip(a)], chart: chartCard(u, a, range, by), rest: [split, fl] };
};

const summaryStrip = (a: AggStatus): HTMLElement => {
  const pct = a.initial_eur ? pct100((a.used_eur / a.initial_eur) * 100) : 0;
  const wins: [string, WindowTotal][] = [
    ["5 hours", a.windows["5h"]],
    ["Day", a.windows.day],
    ["Week", a.windows.week],
    ["Month", a.month],
  ];
  const tight = wins.filter(([, w]) => w.cap > 0).sort((x, y) => x[1].room / x[1].cap - y[1].room / y[1].cap)[0];
  const tightPct = tight ? pct100((tight[1].spent / tight[1].cap) * 100) : 0;
  const resetAt = a.reset_at;
  const resetIn = resetAt ? (resetAt - Date.now() / 1000) / 86400 : null;
  const cell = (k: string, v: Kid, s: Kid, extra?: Kid, cls?: string): HTMLElement =>
    h(
      "div",
      { class: "cell" },
      h("div", { class: "k" }, k),
      h("div", { class: `v ${cls || ""}` }, v),
      h("div", { class: "s" }, s),
      extra,
    );
  return h(
    "section",
    { class: "strip", "aria-label": "Summary" },
    cell(
      "Spent this period",
      eur(a.used_eur),
      `of ${eur(a.initial_eur)} · ${pct.toFixed(0)}% used`,
      h(
        "div",
        { class: "mini" },
        h("i", { class: pct >= 90 ? "bad" : pct >= 75 ? "warn" : "", style: `width:${pct}%` }),
      ),
    ),
    cell(
      "Available now",
      eur(a.room_eur),
      a.blocked
        ? badge("bad", `Blocked${a.retry_at ? ` until ${when(a.retry_at)}` : ""}`)
        : badge("ok", "Ready", "Within every limit"),
    ),
    tight
      ? cell(
          "Closest limit",
          eur(Math.max(tight[1].room, 0)),
          `${tight[0]} · ${eur(tight[1].spent)} of ${eur(tight[1].cap)}`,
          h(
            "div",
            { class: "mini" },
            h("i", { class: tightPct >= 95 ? "bad" : tightPct >= 80 ? "warn" : "", style: `width:${tightPct}%` }),
          ),
        )
      : null,
    resetIn !== null && resetAt
      ? cell(
          "Resets",
          resetIn < 1 ? "< 1 day" : `in ${Math.round(resetIn)} d`,
          new Date(resetAt * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }),
        )
      : null,
  );
};

const chartCard = (u: UsageResponse, a: AggStatus, range: UsageRange, by: UsageBy): HTMLElement[] => {
  const label = (n: string): string => (by === "pool" ? poolLabel(n) : n);
  const avg = u.total / RANGE_DAYS[range];
  const delta = u.prev_total > 0 ? ((u.total - u.prev_total) / u.prev_total) * 100 : null;
  const over = a.fair_daily_eur > 0 && avg > a.fair_daily_eur;
  const legend = h(
    "div",
    { class: "legend" },
    u.series.map((s, i) =>
      h(
        "span",
        {},
        h("i", { style: `background:${colorOf(s.name, i)}` }),
        h("span", { class: "trunc" }, label(s.name)),
        h("span", { class: "mut num" }, eur4(s.total)),
      ),
    ),
  );
  const box = h("div", { class: "chart" });
  const draw = () => drawChart(box, u, a, label);
  requestAnimationFrame(draw);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (!box.isConnected) ro.disconnect();
      else draw();
    });
    ro.observe(box);
  }
  return [
    h(
      "div",
      { class: "row sm", style: "margin:calc(var(--sp-2)*-1) 0 var(--sp-3);gap:var(--sp-1) var(--sp-4)" },
      h(
        "span",
        {},
        h("b", { class: "num" }, eur(u.total)),
        h("span", { class: "mut" }, ` in ${RANGES[range]} · ${plural(u.requests, "request")}`),
      ),
      delta === null
        ? null
        : h("span", { class: "mut" }, `${delta >= 0 ? "up" : "down"} ${Math.abs(delta).toFixed(0)}% vs. previous`),
      a.fair_daily_eur > 0
        ? [
            h("span", { class: "mut num" }, `avg ${eur(avg)}/day · target ${eur(a.fair_daily_eur)}/day`),
            over ? badge("warn", "Spending fast") : badge("ok", "On track"),
          ]
        : null,
    ),
    box,
    u.series.length ? legend : null,
  ].flatMap((x) => (x ? [x] : []));
};

const drawChart = (box: HTMLElement, u: UsageResponse, a: AggStatus, label: (n: string) => string): void => {
  const W = Math.max(box.clientWidth || 640, 200);
  const narrow = W < 460;
  const H = Math.round(Math.min(Math.max(W * 0.38, 170), 280));
  const L = narrow ? 36 : 44;
  const R = 4;
  const T = 10;
  const B = 24;
  const n = u.buckets.length;
  const pw = W - L - R;
  const ph = H - T - B;
  const sums = u.buckets.map((_, i) => u.series.reduce((t, s) => t + (s.values[i] ?? 0), 0));
  const fair = u.unit === "day" ? a.fair_daily_eur : 0;
  const peak = Math.max(...sums, 0.0001);
  // a pace line far above the bars would flatten them
  const fairShown = fair > 0 && fair <= peak * 2.5;
  const top = niceMax(Math.max(peak, fairShown ? fair * 1.05 : 0));
  const y = (v: number) => T + ph - (v / top) * ph;
  const bw = pw / n;
  const root = svg("svg", {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": `Spending over ${RANGES[u.range]}: total ${eur(u.total)}`,
  });
  const ticks = narrow ? 2 : 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (top * i) / ticks;
    root.append(
      svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "g" }),
      svg("text", { x: L - 6, y: y(v) + 4, class: "ax", "text-anchor": "end" }, short(v)),
    );
  }
  const fmtX = (t: number): string => {
    const dt = new Date(t * 1000);
    return u.unit === "hour"
      ? dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : dt.toLocaleDateString(
          "en-GB",
          u.range === "7d" && !narrow
            ? { weekday: "short", day: "numeric" }
            : { day: "numeric", month: narrow ? "numeric" : "short" },
        );
  };
  const every = u.unit === "hour" ? (narrow ? 6 : 4) : n <= 7 ? (narrow ? 2 : 1) : narrow ? 7 : 5;
  const tip = h("div", { class: "tip", hidden: true });
  let active: SVGElement | null = null;
  u.buckets.forEach((t, i) => {
    const x = L + i * bw;
    if ((n - 1 - i) % every === 0)
      root.append(svg("text", { x: x + bw / 2, y: H - 6, class: "ax", "text-anchor": "middle" }, fmtX(t)));
    let acc = 0;
    u.series.forEach((s, si) => {
      const v = s.values[i] ?? 0;
      if (v <= 0) return;
      const y0 = y(acc);
      const y1 = y(acc + v);
      acc += v;
      root.append(
        svg("rect", {
          x: x + bw * 0.16,
          y: y1,
          width: bw * 0.68,
          height: Math.max(y0 - y1, 1),
          rx: 1.5,
          style: `fill:${colorOf(s.name, si)}`,
        }),
      );
    });
    const hit = svg("rect", { x, y: T, width: bw, height: ph, class: "hit" });
    const show = () => {
      active?.classList.remove("on");
      hit.classList.add("on");
      active = hit;
      const when_ =
        u.unit === "hour"
          ? `${fmtX(t)} – ${fmtX(t + 3600)}`
          : new Date(t * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
      tip.replaceChildren(
        h("b", {}, when_),
        ...u.series
          .filter((s) => (s.values[i] ?? 0) > 0)
          .map((s) =>
            h(
              "div",
              {},
              h("i", { style: `background:${colorOf(s.name, u.series.indexOf(s))}` }),
              `${label(s.name)} ${eur4(s.values[i] ?? 0)}`,
            ),
          ),
        h("div", { class: "t" }, `Total ${eur4(sums[i] ?? 0)}`),
      );
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(x + bw / 2 - tw / 2, 0), Math.max(W - tw, 0))}px`;
      tip.style.top = `${Math.max(y(sums[i] ?? 0) - tip.offsetHeight - 8, 0)}px`;
    };
    const hide = () => {
      tip.hidden = true;
      hit.classList.remove("on");
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") hide();
    });
    root.append(hit);
  });
  if (fair > 0 && !fairShown)
    root.append(
      svg(
        "text",
        { x: W - R, y: T - 1, class: "ax", "text-anchor": "end" },
        `pace ${short(fair)}/day, above this chart`,
      ),
    );
  if (fairShown) {
    root.append(
      svg("line", { x1: L, x2: W - R, y1: y(fair), y2: y(fair), class: "pace" }),
      svg("text", { x: W - R, y: y(fair) - 4, class: "ax", "text-anchor": "end" }, `pace ${short(fair)}`),
    );
  }
  const sr = h(
    "table",
    { class: "sr" },
    h("caption", {}, `Spending per ${u.unit}`),
    h(
      "tbody",
      {},
      u.buckets.map((t, i) => h("tr", {}, h("th", { scope: "row" }, fmtX(t)), h("td", {}, eur4(sums[i] ?? 0)))),
    ),
  );
  box.replaceChildren(root, tip, sr);
  if (!u.total) box.append(h("div", { class: "empty-chart" }, "No spending in this period."));
};

const limitsCard = (a: AggStatus): HTMLElement => {
  const rows: [string, WindowTotal][] = [
    ["5 hours", a.windows["5h"]],
    ["Day", a.windows.day],
    ["Week", a.windows.week],
    ["Month", a.month],
  ];
  return h(
    "section",
    { class: "card", "aria-label": "Limits right now" },
    h("div", { class: "card-h" }, h("h2", {}, "Limits right now")),
    h(
      "p",
      { class: "mut sm", style: "margin:calc(var(--sp-2)*-1) 0 var(--sp-4)" },
      "How much you can spend in each time period. Unused budget raises the limits.",
    ),
    rows.map(([name, w]) => {
      const pct = w.cap > 0 ? pct100((w.spent / w.cap) * 100) : 100;
      const tone = pct >= 95 ? "bad" : pct >= 80 ? "warn" : "";
      return h(
        "div",
        { class: "wrow" },
        h("div", { class: "sm" }, name),
        h(
          "div",
          { class: "min0" },
          h("div", { class: "mini" }, h("i", { class: tone, style: `width:${pct}%` })),
          h("div", { class: "mut xs num", style: "margin-top:.25rem" }, `${eur(w.spent)} of ${eur(w.cap)}`),
        ),
        h(
          "div",
          { class: `num sm ${w.room > 0 ? "" : "tx-bad"}` },
          w.room > 0 ? `${eur(w.room)} left` : badge("bad", "none left"),
        ),
      );
    }),
  );
};

const poolsCard = (sm: Summary, rows: PoolStatus[]): HTMLElement => {
  const items = rows.map((p) => {
    const init = p.initial_eur || 0;
    const usedF = init ? Math.min(1, p.used_eur / init) : 0;
    const capF = init ? Math.max(0, (init - p.reserve_eur) / init) : 1;
    const elapsed = Math.min(1, Math.max(0, 1 - p.days_left / PERIOD_DAYS));
    // fair share of the usable budget by now
    const fairEur = (init - p.reserve_eur) * elapsed;
    const exhausted = p.remaining_eur <= p.reserve_eur + 0.005 || usedF >= capF;
    const ahead = !exhausted && p.used_eur > fairEur * 1.1 + 0.5;
    const tone = exhausted ? "bad" : ahead ? "warn" : "";
    const state = !p.enabled
      ? badge("", "Off")
      : p.blocked_by
        ? badge("bad", `Blocked: ${p.blocked_by}`)
        : p.blocked_temporarily
          ? badge("warn", "Paused")
          : exhausted
            ? badge("bad", "Used up")
            : ahead
              ? badge("warn", "Spending fast")
              : badge("ok", "On track");
    const bar = h(
      "div",
      {
        class: "pbar",
        role: "img",
        "aria-label": `${eur(p.used_eur)} of ${eur(init)} used. Planned spending so far ${eur(Math.max(fairEur, 0))}. Kept in reserve ${eur(p.reserve_eur)}.`,
      },
      h("i", { class: `fill ${tone}`, style: `width:${usedF * 100}%` }),
      h("i", { class: "res", style: `left:${capF * 100}%` }),
      h("i", { class: "mark", style: `left:${elapsed * 100}%` }),
    );
    return h(
      "div",
      { class: "prow" },
      h(
        "div",
        { class: "row nw" },
        h("b", { class: "trunc", title: p.account }, p.account),
        h("span", { class: "mut sm" }, poolLabel(p.pool)),
        h("span", { class: "grow" }),
        h("b", { class: "num" }, eur(p.remaining_eur)),
        h("span", { class: "mut sm" }, "left"),
      ),
      bar,
      h(
        "div",
        { class: "row", style: "gap:var(--sp-1) var(--sp-3)" },
        state,
        p.members.length > 1
          ? h("span", { class: "badge info", title: p.members.join(", ") }, `${p.members.length} keys, one budget`)
          : null,
        h(
          "span",
          { class: "mut xs tnum" },
          `${eur(p.used_eur)} of ${eur(init)} · resets in ${Math.max(p.days_left, 0).toFixed(0)} days · ${eur(Math.max(p.room_eur, 0))} available now`,
        ),
      ),
    );
  });
  const shared = sm.shared.map((g) =>
    h(
      "p",
      { class: "mut xs", style: "margin-top:var(--sp-3)" },
      `Counted as one budget: ${g.members.join(", ")}${g.confidence === "sure" ? " (same usage)" : " (probably the same account, nothing spent yet)"}`,
    ),
  );
  return h(
    "section",
    { class: "card", "aria-label": "Budgets" },
    h("div", { class: "card-h" }, h("h2", {}, "Budgets")),
    items,
    shared,
    h(
      "div",
      { class: "keyline", "aria-hidden": "true" },
      h("span", {}, h("i", { class: "sw" }), "used"),
      h("span", {}, h("i", { class: "sw mark" }), "planned spending so far"),
      h("span", {}, h("i", { class: "sw res" }), "kept in reserve"),
    ),
  );
};
