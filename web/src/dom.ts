import { attrValue } from "./attr.ts";
export type Kid = Node | string | number | boolean | null | undefined | Kid[];
export type Props = {
  class?: string | null;
  id?: string | null;
  style?: string | null;
  title?: string | null;
  role?: string | null;
  href?: string | null;
  target?: string | null;
  rel?: string | null;
  download?: string | null;
  type?: string | null;
  value?: string | number | null;
  placeholder?: string | null;
  for?: string | null;
  autocomplete?: string | null;
  autocapitalize?: string | null;
  spellcheck?: string | null;
  inputmode?: string | null;
  src?: string | null;
  alt?: string | null;
  width?: string | number | null;
  height?: string | number | null;
  tabindex?: string | number | null;
  scope?: string | null;
  checked?: boolean | null;
  disabled?: boolean | null;
  selected?: boolean | null;
  hidden?: boolean | null;
  required?: boolean | null;
  novalidate?: boolean | null;
  onclick?: ((e: MouseEvent) => void) | null;
  onsubmit?: ((e: SubmitEvent) => void) | null;
  onkeydown?: ((e: KeyboardEvent) => void) | null;
  onchange?: ((e: Event) => void) | null;
  oninput?: ((e: Event) => void) | null;
  onblur?: ((e: FocusEvent) => void) | null;
  [key: `aria-${string}`]: string | number | boolean | null | undefined;
  [key: `data-${string}`]: string | number | boolean | null | undefined;
};

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...kids: Kid[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    const a = attrValue(k, v);
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (a === null) continue;
    else if (k === "class") el.className = a;
    else if (k === "value") (el as { value: unknown }).value = v;
    else if (k === "checked" || k === "disabled" || k === "selected" || k === "hidden") Reflect.set(el, k, true);
    else el.setAttribute(k, a);
  }
  const add = (k: Kid): void => {
    if (k === null || k === undefined || k === false) return;
    if (Array.isArray(k)) {
      for (const x of k) add(x);
      return;
    }
    el.append(k instanceof Node ? k : String(k));
  };
  for (const k of kids) add(k);
  return el;
};

export const svg = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number>,
  ...kids: (Node | string | null | undefined)[]
): SVGElementTagNameMap[K] => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, String(v));
  for (const k of kids) if (k !== null && k !== undefined) el.append(k instanceof Node ? k : String(k));
  return el;
};

const ICONS = {
  overview:
    '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  accounts:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.7.7 2.8 2.4 3 5.2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-3 3 3 3"/>',
  settings:
    '<path d="M4 6h8M18 6h2M4 12h2M12 12h8M4 18h10M20 18h0"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.4v.1"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.1"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  logout: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
} satisfies Record<string, string>;
export type IconName = keyof typeof ICONS;
export const ic = (name: IconName): SVGSVGElement => {
  const s = svg("svg", { class: "ic", viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" });
  s.innerHTML = ICONS[name];
  return s;
};
export const logoMark = (): HTMLImageElement =>
  h("img", { src: "/favicon.svg", alt: "", width: 24, height: 24, "aria-hidden": "true" });
export const qs = <T extends Element = HTMLElement>(sel: string, el: ParentNode = document): T | null =>
  el.querySelector<T>(sel);
export const keysOf = <T extends object>(o: T): (keyof T)[] => Object.keys(o) as (keyof T)[];
export const entriesOf = <T extends object>(o: T): [keyof T, NonNullable<T[keyof T]>][] =>
  Object.entries(o) as [keyof T, NonNullable<T[keyof T]>][];
