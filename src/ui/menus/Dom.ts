/**
 * Tiny DOM construction helpers plus the shared menu controls.
 *
 * Nothing here uses innerHTML with dynamic content, so no player-supplied string
 * (a name, a bind label) can ever be interpreted as markup. Every control exposes
 * a `refresh()` so an external change — a quality preset switching a dozen
 * graphics values at once — is reflected without rebuilding the screen.
 */

export type Child = Node | string | null | undefined | false;

export interface ElProps {
  class?: string;
  id?: string;
  text?: string;
  title?: string;
  type?: string;
  role?: string;
  tabIndex?: number;
  disabled?: boolean;
  style?: Partial<CSSStyleDeclaration>;
  data?: Record<string, string>;
  aria?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: ElProps = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.id) node.id = props.id;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  if (props.role) node.setAttribute('role', props.role);
  if (props.tabIndex !== undefined) node.tabIndex = props.tabIndex;
  if (props.disabled !== undefined && 'disabled' in node) {
    (node as unknown as { disabled: boolean }).disabled = props.disabled;
  }
  if (props.type && 'type' in node) (node as unknown as { type: string }).type = props.type;
  if (props.style) Object.assign(node.style, props.style);
  if (props.data) for (const [k, v] of Object.entries(props.data)) node.dataset[k] = v;
  if (props.aria) for (const [k, v] of Object.entries(props.aria)) node.setAttribute(`aria-${k}`, v);
  if (props.on) {
    for (const [k, fn] of Object.entries(props.on)) {
      node.addEventListener(k, fn as EventListener);
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const ch of children) {
    if (ch === null || ch === undefined || ch === false) continue;
    parent.appendChild(typeof ch === 'string' ? document.createTextNode(ch) : ch);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Applies `--i` so the stylesheet's stagger animation runs in reading order. */
export function stagger<T extends HTMLElement>(node: T, index: number): T {
  node.style.setProperty('--i', String(index));
  return node;
}

/* ------------------------------------------------------------ controls -- */

export interface Control {
  root: HTMLElement;
  refresh(): void;
}

export interface RowOptions {
  name: string;
  help?: string;
}

function rowShell(o: RowOptions, control: HTMLElement): HTMLElement {
  return el('div', { class: 'ob-row' },
    el('div', { class: 'ob-row-label' },
      el('div', { class: 'ob-row-name', text: o.name }),
      o.help ? el('div', { class: 'ob-row-help', text: o.help }) : null,
    ),
    el('div', { class: 'ob-row-control' }, control),
  );
}

export function sliderRow(
  o: RowOptions & {
    min: number; max: number; step: number;
    get: () => number; set: (v: number) => void;
    format?: (v: number) => string;
  },
): Control {
  const value = el('span', { class: 'ob-slider-value' });
  const input = el('input', { class: 'ob-slider', type: 'range' });
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step);
  const fmt = o.format ?? ((v: number) => v.toFixed(o.step < 1 ? 2 : 0));
  const sync = (): void => {
    const v = o.get();
    input.value = String(v);
    value.textContent = fmt(v);
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    o.set(v);
    value.textContent = fmt(v);
  });
  const wrap = el('div', {
    class: 'ob-row-control',
    style: { flex: '1 1 auto', minWidth: '0' },
  }, input, value);
  sync();
  return { root: rowShell(o, wrap), refresh: sync };
}

export function toggleRow(
  o: RowOptions & { get: () => boolean; set: (v: boolean) => void },
): Control {
  const knob = el('i');
  const btn = el('button', { class: 'ob-toggle', type: 'button', aria: { pressed: 'false' } }, knob);
  const sync = (): void => {
    const on = o.get();
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  btn.addEventListener('click', () => { o.set(!o.get()); sync(); });
  sync();
  return { root: rowShell(o, btn), refresh: sync };
}

export function segmentRow<T extends string>(
  o: RowOptions & {
    options: ReadonlyArray<{ value: T; label: string }>;
    get: () => T; set: (v: T) => void;
  },
): Control {
  const seg = el('div', { class: 'ob-seg', role: 'radiogroup' });
  const buttons: HTMLButtonElement[] = [];
  for (const opt of o.options) {
    const b = el('button', { type: 'button', text: opt.label, role: 'radio' });
    b.addEventListener('click', () => { o.set(opt.value); sync(); });
    buttons.push(b);
    seg.appendChild(b);
  }
  const sync = (): void => {
    const cur = o.get();
    for (let i = 0; i < buttons.length; i++) {
      const on = o.options[i].value === cur;
      buttons[i].classList.toggle('is-on', on);
      buttons[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  };
  sync();
  return { root: rowShell(o, seg), refresh: sync };
}

export function bindRow(
  o: RowOptions & { get: () => string; onCapture: (done: (code: string | null) => void) => void },
): Control {
  const btn = el('button', { class: 'ob-bind', type: 'button' });
  const sync = (): void => { btn.textContent = prettyKey(o.get()); };
  btn.addEventListener('click', () => {
    if (btn.classList.contains('is-listening')) return;
    btn.classList.add('is-listening');
    btn.textContent = 'PRESS A KEY';
    o.onCapture(() => {
      btn.classList.remove('is-listening');
      sync();
    });
  });
  sync();
  return { root: rowShell(o, btn), refresh: sync };
}

/** Human-readable label for a KeyboardEvent.code. */
export function prettyKey(code: string): string {
  if (!code) return 'UNBOUND';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return `${code.slice(5).toUpperCase()} ARROW`;
  const map: Record<string, string> = {
    Space: 'SPACE', ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT',
    ControlLeft: 'L CTRL', ControlRight: 'R CTRL', AltLeft: 'L ALT', AltRight: 'R ALT',
    Escape: 'ESC', Tab: 'TAB', Enter: 'ENTER', Backspace: 'BACKSPACE',
    CapsLock: 'CAPS', Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
    Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  return map[code] ?? code.toUpperCase();
}

/** Section heading inside a scrolling settings panel. */
export function sectionHeading(text: string): HTMLElement {
  return el('div', {
    class: 'ob-panel-title',
    style: { marginTop: 'calc(var(--ob-u)*16)' },
  }, el('span', { text }));
}

export function statBar(name: string, value01: number, label: string): HTMLElement {
  const fill = el('i', { class: 'ob-stat-fill' });
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, value01)) * 100)}%`;
  return el('div', { class: 'ob-stat' },
    el('div', { class: 'ob-stat-name', text: name }),
    el('div', { class: 'ob-stat-track' }, fill),
    el('div', { class: 'ob-stat-val', text: label }),
  );
}
