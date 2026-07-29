/**
 * Input aggregation: keyboard, mouse (pointer-locked), and gamepad, normalised
 * into a per-frame action snapshot.
 *
 * Consumers never touch DOM events. They read `input.state` (held) and
 * `input.pressed(...)` / `input.released(...)` edges, which are cleared once per
 * frame by `Engine`.
 */

export type Action =
  | 'forward' | 'back' | 'left' | 'right'
  | 'jump' | 'crouch' | 'prone' | 'sprint'
  | 'fire' | 'ads' | 'reload' | 'melee'
  | 'use' | 'grenade' | 'tactical' | 'switchWeapon'
  | 'leanLeft' | 'leanRight' | 'inspect'
  | 'slot1' | 'slot2' | 'slot3'
  | 'pause' | 'scoreboard' | 'flashlight';

const DEFAULT_BINDINGS: Record<string, Action> = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'jump',
  ControlLeft: 'crouch', KeyC: 'crouch',
  KeyX: 'prone',
  ShiftLeft: 'sprint',
  KeyR: 'reload',
  KeyV: 'melee',
  KeyF: 'use',
  KeyG: 'grenade',
  KeyQ: 'leanLeft',
  KeyE: 'leanRight',
  Tab: 'scoreboard',
  Escape: 'pause',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3',
  KeyI: 'inspect',
  KeyT: 'tactical',
  KeyL: 'flashlight',
};

export interface InputState {
  actions: Set<Action>;
  /** Accumulated mouse delta for this frame, in raw device units. */
  mouseDX: number;
  mouseDY: number;
  wheel: number;
  /** Analog movement from gamepad, [-1..1]. Keyboard fills these too. */
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
  /** Analog trigger values from gamepad, [0..1]. */
  triggerFire: number;
  triggerAds: number;
  usingGamepad: boolean;
}

export class Input {
  readonly state: InputState = {
    actions: new Set(),
    mouseDX: 0, mouseDY: 0, wheel: 0,
    moveX: 0, moveY: 0, lookX: 0, lookY: 0,
    triggerFire: 0, triggerAds: 0,
    usingGamepad: false,
  };

  bindings: Record<string, Action> = { ...DEFAULT_BINDINGS };
  locked = false;
  enabled = true;
  /** Set true by the capture harness so synthetic input can be injected. */
  scripted = false;

  private downEdges = new Set<Action>();
  private upEdges = new Set<Action>();
  private element: HTMLElement | null = null;
  private disposers: Array<() => void> = [];
  private lastGamepadIndex = -1;

  attach(element: HTMLElement): void {
    this.element = element;
    const add = <K extends keyof DocumentEventMap>(
      target: EventTarget, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    add(window, 'keydown', (e) => {
      if (!this.enabled) return;
      if (e.repeat) return;
      const a = this.bindings[e.code];
      if (a) {
        e.preventDefault();
        if (!this.state.actions.has(a)) this.downEdges.add(a);
        this.state.actions.add(a);
        this.state.usingGamepad = false;
      }
    });

    add(window, 'keyup', (e) => {
      const a = this.bindings[e.code];
      if (a) {
        e.preventDefault();
        if (this.state.actions.delete(a)) this.upEdges.add(a);
      }
    });

    add(window, 'blur', () => this.releaseAll());

    add(element, 'mousedown', (e) => {
      if (!this.enabled || !this.locked) return;
      const a = e.button === 0 ? 'fire' : e.button === 2 ? 'ads' : e.button === 1 ? 'switchWeapon' : null;
      if (a) {
        if (!this.state.actions.has(a)) this.downEdges.add(a);
        this.state.actions.add(a);
        this.state.usingGamepad = false;
      }
    });

    add(window, 'mouseup', (e) => {
      const a = e.button === 0 ? 'fire' : e.button === 2 ? 'ads' : e.button === 1 ? 'switchWeapon' : null;
      if (a && this.state.actions.delete(a)) this.upEdges.add(a);
    });

    add(element, 'contextmenu', (e) => e.preventDefault());

    add(window, 'mousemove', (e) => {
      if (!this.enabled || !this.locked || this.scripted) return;
      // movementX/Y already excludes acceleration on most platforms.
      this.state.mouseDX += e.movementX;
      this.state.mouseDY += e.movementY;
      this.state.usingGamepad = false;
    });

    add(element, 'wheel', (e) => {
      if (!this.enabled || !this.locked) return;
      e.preventDefault();
      this.state.wheel += Math.sign(e.deltaY);
    }, { passive: false });

    add(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      if (!this.locked) this.releaseAll();
    });
  }

  requestLock(): void {
    if (this.scripted) return;
    this.element?.requestPointerLock?.();
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  releaseAll(): void {
    for (const a of this.state.actions) this.upEdges.add(a);
    this.state.actions.clear();
    this.state.mouseDX = 0;
    this.state.mouseDY = 0;
  }

  held(a: Action): boolean { return this.state.actions.has(a); }
  pressed(a: Action): boolean { return this.downEdges.has(a); }
  released(a: Action): boolean { return this.upEdges.has(a); }

  /** Injects synthetic input for scripted capture runs. */
  inject(patch: Partial<Pick<InputState, 'mouseDX' | 'mouseDY' | 'moveX' | 'moveY'>> & { press?: Action[]; hold?: Action[]; release?: Action[] }): void {
    if (patch.mouseDX !== undefined) this.state.mouseDX += patch.mouseDX;
    if (patch.mouseDY !== undefined) this.state.mouseDY += patch.mouseDY;
    if (patch.moveX !== undefined) this.state.moveX = patch.moveX;
    if (patch.moveY !== undefined) this.state.moveY = patch.moveY;
    for (const a of patch.press ?? []) { this.downEdges.add(a); this.state.actions.add(a); }
    for (const a of patch.hold ?? []) this.state.actions.add(a);
    for (const a of patch.release ?? []) { if (this.state.actions.delete(a)) this.upEdges.add(a); }
  }

  /** Polls gamepads and folds analog axes into the shared state. */
  private pollGamepad(): void {
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    let pad: Gamepad | null = null;
    for (const p of pads) { if (p && p.connected) { pad = p; break; } }
    if (!pad) { this.lastGamepadIndex = -1; return; }

    const dz = (v: number, d = 0.16) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
    const lx = dz(pad.axes[0] ?? 0), ly = dz(pad.axes[1] ?? 0);
    const rx = dz(pad.axes[2] ?? 0), ry = dz(pad.axes[3] ?? 0);
    const active = Math.abs(lx) + Math.abs(ly) + Math.abs(rx) + Math.abs(ry) > 0.02
      || pad.buttons.some((b) => b.pressed);
    if (active) this.state.usingGamepad = true;
    if (!this.state.usingGamepad) return;

    this.state.moveX = lx;
    this.state.moveY = -ly;
    // Response curve: fine aim near centre, fast turn at the edge.
    const curve = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 2.4);
    this.state.lookX = curve(rx);
    this.state.lookY = curve(ry);
    this.state.triggerFire = pad.buttons[7]?.value ?? 0;
    this.state.triggerAds = pad.buttons[6]?.value ?? 0;

    const map: Array<[number, Action]> = [
      [0, 'jump'], [1, 'crouch'], [2, 'reload'], [3, 'switchWeapon'],
      [4, 'grenade'], [5, 'tactical'], [10, 'sprint'], [11, 'melee'],
      [9, 'pause'], [8, 'scoreboard'],
    ];
    for (const [i, action] of map) {
      const pressed = !!pad.buttons[i]?.pressed;
      const had = this.state.actions.has(action);
      if (pressed && !had) { this.downEdges.add(action); this.state.actions.add(action); }
      else if (!pressed && had) { this.state.actions.delete(action); this.upEdges.add(action); }
    }
    const fire = this.state.triggerFire > 0.35;
    if (fire && !this.state.actions.has('fire')) { this.downEdges.add('fire'); this.state.actions.add('fire'); }
    else if (!fire && this.state.actions.delete('fire')) this.upEdges.add('fire');
    const ads = this.state.triggerAds > 0.35;
    if (ads && !this.state.actions.has('ads')) { this.downEdges.add('ads'); this.state.actions.add('ads'); }
    else if (!ads && this.state.actions.delete('ads')) this.upEdges.add('ads');

    this.lastGamepadIndex = pad.index;
  }

  /** Rumble on hit / fire. No-op on pads without haptics. */
  rumble(strong: number, weak: number, ms: number): void {
    if (this.lastGamepadIndex < 0) return;
    const pad = navigator.getGamepads?.()[this.lastGamepadIndex];
    const act = (pad as unknown as { vibrationActuator?: { playEffect(t: string, o: object): Promise<unknown> } })?.vibrationActuator;
    act?.playEffect('dual-rumble', {
      duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak),
    }).catch(() => { });
  }

  /** Called once at the top of every frame by Engine. */
  beginFrame(): void {
    this.pollGamepad();
    if (!this.state.usingGamepad) {
      const a = this.state.actions;
      this.state.moveX = (a.has('right') ? 1 : 0) - (a.has('left') ? 1 : 0);
      this.state.moveY = (a.has('forward') ? 1 : 0) - (a.has('back') ? 1 : 0);
      this.state.lookX = 0;
      this.state.lookY = 0;
      this.state.triggerFire = a.has('fire') ? 1 : 0;
      this.state.triggerAds = a.has('ads') ? 1 : 0;
    }
  }

  /** Called at the very end of every frame by Engine. */
  endFrame(): void {
    this.downEdges.clear();
    this.upEdges.clear();
    this.state.mouseDX = 0;
    this.state.mouseDY = 0;
    this.state.wheel = 0;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}

export const input = new Input();
