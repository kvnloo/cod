/**
 * Screen stack.
 *
 * Menus are DOM, mounted lazily and kept in a stack so "back" always has a
 * meaning. Opening or closing announces `ui:screen` on the bus, which is how the
 * rest of the game learns it should stop reading input and pause the clock —
 * nothing reaches into gameplay directly.
 */

import { bus } from '../../core/EventBus';
import { el } from './Dom';
import type { UiScreenName } from '../UiEvents';

export interface ScreenHost {
  /** Push a screen by name. */
  push(name: UiScreenName): void;
  /** Pop the top screen. */
  back(): void;
  /** Close every screen. */
  closeAll(): void;
  readonly top: UiScreenName;
}

export abstract class Screen {
  readonly root: HTMLElement;
  protected built = false;

  constructor(readonly name: UiScreenName, readonly host: ScreenHost) {
    this.root = el('div', { class: 'ob-screen', role: 'dialog', aria: { modal: 'true', label: name } });
  }

  /** Builds the DOM once, on first open. */
  protected abstract build(): void;

  /** Called every time the screen becomes visible. */
  onOpen(): void { /* optional */ }
  onClose(): void { /* optional */ }
  /** Per-frame hook for screens with live content. */
  tick(_dt: number): void { /* optional */ }

  ensureBuilt(): void {
    if (this.built) return;
    this.built = true;
    this.build();
  }
}

export class MenuStack implements ScreenHost {
  private screens = new Map<UiScreenName, Screen>();
  private stack: UiScreenName[] = [];
  private openTimer = 0;

  constructor(private layer: HTMLElement) { }

  register(screen: Screen): void {
    this.screens.set(screen.name, screen);
    this.layer.appendChild(screen.root);
  }

  get top(): UiScreenName {
    return this.stack.length ? this.stack[this.stack.length - 1] : 'none';
  }

  get isOpen(): boolean { return this.stack.length > 0; }

  push(name: UiScreenName): void {
    if (name === 'none') { this.closeAll(); return; }
    const screen = this.screens.get(name);
    if (!screen) return;
    if (this.top === name) return;

    // Hide whatever is currently on top without unmounting it.
    const prev = this.screens.get(this.top);
    if (prev) prev.root.classList.remove('is-open');

    screen.ensureBuilt();
    screen.root.classList.add('is-mounted');
    // Force a style flush so the opacity transition actually runs.
    void screen.root.offsetWidth;
    screen.root.classList.add('is-open');
    screen.onOpen();
    this.stack.push(name);
    bus.emit('ui:screen', { screen: name, open: true });
    bus.emit('ui:sound', { cue: 'menuOpen' });
  }

  /** Replaces the whole stack with a single screen. */
  replace(name: UiScreenName): void {
    this.closeAll(true);
    this.push(name);
  }

  back(): void {
    const name = this.stack.pop();
    if (!name) return;
    const screen = this.screens.get(name);
    if (screen) {
      screen.root.classList.remove('is-open');
      screen.onClose();
      window.setTimeout(() => {
        if (this.top !== name) screen.root.classList.remove('is-mounted');
      }, 320);
    }
    bus.emit('ui:screen', { screen: name, open: false });
    bus.emit('ui:sound', { cue: 'menuBack' });

    const next = this.screens.get(this.top);
    if (next) {
      next.root.classList.add('is-mounted');
      void next.root.offsetWidth;
      next.root.classList.add('is-open');
      next.onOpen();
      bus.emit('ui:screen', { screen: next.name, open: true });
    }
  }

  closeAll(silent = false): void {
    while (this.stack.length) {
      const name = this.stack.pop();
      if (!name) break;
      const screen = this.screens.get(name);
      if (screen) {
        screen.root.classList.remove('is-open');
        screen.onClose();
        window.setTimeout(() => screen.root.classList.remove('is-mounted'), 320);
      }
      if (!silent) bus.emit('ui:screen', { screen: name, open: false });
    }
    if (!silent) bus.emit('ui:sound', { cue: 'menuClose' });
  }

  tick(dt: number): void {
    this.openTimer += dt;
    const s = this.screens.get(this.top);
    s?.tick(dt);
  }

  get(name: UiScreenName): Screen | undefined { return this.screens.get(name); }
}

/* ---------------------------------------------------------- shared frame -- */

export interface FrameParts {
  root: HTMLElement;
  body: HTMLElement;
  footerLeft: HTMLElement;
  footerRight: HTMLElement;
  topRight: HTMLElement;
}

/**
 * The common menu chrome: brand top-left, chips top-right, a body grid and a
 * hint bar along the bottom. Every screen uses it so the whole front end feels
 * like one product.
 */
export function menuFrame(
  screen: Screen, title: string, subtitle: string, bodyClass = 'cols-nav',
): FrameParts {
  const topRight = el('div', { class: 'ob-topbar-right' });
  const body = el('div', { class: `ob-body ${bodyClass}` });
  const footerLeft = el('div', { class: 'ob-keyhints' });
  const footerRight = el('div', { text: 'OPERATION BLACKOUT  ·  BUILD 1.0.0' });

  screen.root.appendChild(el('div', { class: 'ob-vine' }));
  screen.root.appendChild(
    el('div', { class: 'ob-topbar' },
      el('div', { class: 'ob-brand' },
        el('div', { class: 'ob-brand-mark', text: title }),
        el('div', { class: 'ob-brand-sub', text: subtitle }),
      ),
      topRight,
    ),
  );
  screen.root.appendChild(body);
  screen.root.appendChild(el('div', { class: 'ob-footer' }, footerLeft, footerRight));

  return { root: screen.root, body, footerLeft, footerRight, topRight };
}

export function keyHint(key: string, label: string): HTMLElement {
  return el('span', { class: 'ob-keyhint' }, el('b', { text: key }), label);
}
