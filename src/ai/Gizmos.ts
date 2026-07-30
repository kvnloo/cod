/**
 * Debug gizmos.
 *
 * Everything here exists so behaviour can be *seen* in a still frame: paths,
 * cover quality, awareness meters, sight lines, grenade arcs and a text label
 * per agent saying what it thinks it is doing.
 *
 * Two implementation notes:
 *  - Lines are drawn as instanced beads. `THREE.Line` is capped at one pixel on
 *    every desktop driver, which is invisible in a 1080p screenshot.
 *  - Labels are drawn into a `CanvasTexture` at runtime. That is generated
 *    content, not an asset, so it respects the no-binaries rule.
 */

import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const _dir = new THREE.Vector3();

const BEAD_CAPACITY = 1400;
const BAR_CAPACITY = 96;

export class Gizmos {
  readonly root = new THREE.Group();
  private beads: THREE.InstancedMesh;
  private bars: THREE.InstancedMesh;
  private beadCount = 0;
  private barCount = 0;
  private labels: Label[] = [];
  private labelCount = 0;

  constructor() {
    this.root.name = 'ai-gizmos';
    this.root.userData.noCollide = true;
    this.root.frustumCulled = false;

    const beadMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.beads = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0), beadMat, BEAD_CAPACITY,
    );
    this.beads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beads.frustumCulled = false;
    this.beads.userData.noCollide = true;
    this.beads.count = 0;
    // Allocate the colour buffer up front so three injects the attribute.
    this.beads.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(BEAD_CAPACITY * 3), 3,
    );
    this.beads.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.beads);

    const barMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.bars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), barMat, BAR_CAPACITY);
    this.bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bars.frustumCulled = false;
    this.bars.userData.noCollide = true;
    this.bars.count = 0;
    this.bars.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(BAR_CAPACITY * 3), 3,
    );
    this.bars.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.bars);
  }

  get visible(): boolean { return this.root.visible; }
  set visible(v: boolean) { this.root.visible = v; }

  begin(): void {
    this.beadCount = 0;
    this.barCount = 0;
    this.labelCount = 0;
  }

  point(p: THREE.Vector3, color: number, size = 0.09): void {
    if (this.beadCount >= BEAD_CAPACITY) return;
    _m.compose(p, IDENTITY_Q, _s.setScalar(size));
    this.beads.setMatrixAt(this.beadCount, _m);
    this.beads.setColorAt(this.beadCount, _c.setHex(color));
    this.beadCount++;
  }

  /** Bead-strip line. `spacing` in metres between beads. */
  line(a: THREE.Vector3, b: THREE.Vector3, color: number, size = 0.045, spacing = 0.3): void {
    _dir.copy(b).sub(a);
    const len = _dir.length();
    if (len < 1e-4) return;
    const n = Math.min(64, Math.max(2, Math.ceil(len / spacing)));
    for (let i = 0; i <= n; i++) {
      _p.copy(a).addScaledVector(_dir, i / n);
      this.point(_p, color, size);
    }
  }

  /** Vertical meter: `fill` 0..1 of `height` metres, drawn at `p`. */
  bar(p: THREE.Vector3, fill: number, color: number, height = 0.5, width = 0.05): void {
    if (this.barCount >= BAR_CAPACITY) return;
    const h = Math.max(0.01, height * Math.min(1, Math.max(0, fill)));
    _p.copy(p);
    _p.y += h * 0.5;
    _m.compose(_p, IDENTITY_Q, _s.set(width, h, width));
    this.bars.setMatrixAt(this.barCount, _m);
    this.bars.setColorAt(this.barCount, _c.setHex(color));
    this.barCount++;
    // Backing track so an empty meter is still visible.
    if (this.barCount < BAR_CAPACITY) {
      _p.copy(p);
      _p.y += height * 0.5;
      _m.compose(_p, IDENTITY_Q, _s.set(width * 0.42, height, width * 0.42));
      this.bars.setMatrixAt(this.barCount, _m);
      this.bars.setColorAt(this.barCount, _c.setHex(0x10161c));
      this.barCount++;
    }
  }

  /** Axis-aligned box outline, drawn as bead edges. */
  box(centre: THREE.Vector3, half: THREE.Vector3, color: number, size = 0.03): void {
    for (let i = 0; i < 4; i++) {
      const sx = (i & 1) ? 1 : -1;
      const sz = (i & 2) ? 1 : -1;
      _p.set(centre.x + half.x * sx, centre.y - half.y, centre.z + half.z * sz);
      _dir.set(centre.x + half.x * sx, centre.y + half.y, centre.z + half.z * sz);
      this.line(_p, _dir, color, size, 0.35);
    }
  }

  /** A ground marker: a small ring of beads. */
  ring(centre: THREE.Vector3, radius: number, color: number, size = 0.04, segments = 14): void {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      _p.set(centre.x + Math.cos(a) * radius, centre.y + 0.03, centre.z + Math.sin(a) * radius);
      this.point(_p, color, size);
    }
  }

  /** Text label floating at a world position. */
  label(p: THREE.Vector3, text: string, color = '#eaf2ff'): void {
    let l = this.labels[this.labelCount];
    if (!l) {
      l = new Label();
      this.labels.push(l);
      this.root.add(l.sprite);
    }
    l.set(text, color);
    l.sprite.position.copy(p);
    l.sprite.visible = true;
    this.labelCount++;
  }

  end(): void {
    this.beads.count = this.beadCount;
    this.beads.instanceMatrix.needsUpdate = true;
    if (this.beads.instanceColor) this.beads.instanceColor.needsUpdate = true;
    this.bars.count = this.barCount;
    this.bars.instanceMatrix.needsUpdate = true;
    if (this.bars.instanceColor) this.bars.instanceColor.needsUpdate = true;
    for (let i = this.labelCount; i < this.labels.length; i++) this.labels[i].sprite.visible = false;
  }

  dispose(): void {
    this.beads.geometry.dispose();
    (this.beads.material as THREE.Material).dispose();
    this.bars.geometry.dispose();
    (this.bars.material as THREE.Material).dispose();
    for (const l of this.labels) l.dispose();
    this.labels.length = 0;
    this.root.removeFromParent();
  }
}

const IDENTITY_Q = new THREE.Quaternion();
void _q;

/** One canvas-backed text sprite. Redraws only when the string changes. */
class Label {
  readonly sprite: THREE.Sprite;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private texture: THREE.CanvasTexture;
  private text = '';
  private colour = '';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 96;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: this.texture, transparent: true, depthTest: false, toneMapped: false,
    });
    this.sprite = new THREE.Sprite(material);
    this.sprite.scale.set(1.7, 0.32, 1);
    this.sprite.renderOrder = 999;
    this.sprite.userData.noCollide = true;
  }

  set(text: string, colour: string): void {
    if (text === this.text && colour === this.colour) return;
    this.text = text;
    this.colour = colour;
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, 512, 96);
    ctx.fillStyle = 'rgba(6,10,14,0.72)';
    ctx.fillRect(0, 8, 512, 80);
    ctx.font = '600 44px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colour;
    ctx.fillText(text, 256, 50, 496);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
    this.sprite.removeFromParent();
  }
}

/** Palette shared by the gizmo layer so colours mean the same thing everywhere. */
export const GIZMO = {
  path: 0x38d9ff,
  pathGoal: 0x00ffa8,
  coverGood: 0x2bd66a,
  coverBad: 0xd63b3b,
  coverClaimed: 0xffc93c,
  losClear: 0x5cff8f,
  losBlocked: 0x9aa4ae,
  awareIdle: 0x6f7d8c,
  awareSuspicious: 0xffd166,
  awareSearch: 0xff9f1c,
  awareCombat: 0xff3b30,
  lastKnown: 0xff6ad5,
  grenade: 0xffe066,
  flank: 0xb388ff,
  navCell: 0x2a4a63,
} as const;
