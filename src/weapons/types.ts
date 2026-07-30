/**
 * Weapon module contracts.
 *
 * Everything a weapon *is* lives in a `WeaponDef`: the numbers that drive
 * gameplay, the numbers that drive the procedural mesh, and the numbers that
 * drive the view-model rig. Nothing in this file allocates or references
 * three.js state, so the catalogue can be read by tools, tests and the HUD
 * without dragging the renderer in.
 *
 * Units are SI throughout: metres, seconds, m/s, kilograms, degrees only where
 * explicitly named `Deg`.
 */

export type WeaponClass =
  | 'assault' | 'smg' | 'shotgun' | 'sniper'
  | 'lmg' | 'marksman' | 'pistol' | 'launcher';

export type FireMode = 'auto' | 'semi' | 'burst';

/** How the action cycles — drives the procedural bolt/pump animation. */
export type ActionKind = 'closedBolt' | 'openBolt' | 'boltAction' | 'pump' | 'beltFed' | 'tube';

export type HitZone = 'head' | 'neck' | 'chest' | 'stomach' | 'arm' | 'leg' | 'none';

export type Vec3 = [number, number, number];

/* ------------------------------------------------------------- ballistics */

/** One point on the damage-vs-distance curve. Interpolated linearly. */
export interface DamageStop {
  /** Metres from the muzzle. */
  distance: number;
  /** Damage to an unarmoured torso at that distance. */
  damage: number;
}

export type HitZoneMultipliers = Record<HitZone, number>;

export interface BallisticsProfile {
  /** Muzzle velocity, m/s. */
  muzzleVelocity: number;
  /**
   * Ballistic coefficient expressed as a drag constant `k`, where
   * `dv/dt = -k · v²`. 0.0004 is a 5.56 spitzer, 0.0016 a pistol round.
   */
  drag: number;
  /** Multiplier on gravity — 1 for real drop, 0 for a laser. */
  gravityScale: number;
  /**
   * Distance under which the shot is resolved as a hitscan. Pistol-calibre
   * rounds are hitscan to ~40 m because the flight time is imperceptible;
   * rifle and sniper rounds always simulate.
   */
  hitscanRange: number;
  /**
   * Penetration power in "reference metres": the round defeats a surface when
   * `thickness / SurfaceProps.penetrationDepth ≤ power`.
   */
  penetration: number;
  /** Damage retained after passing through one wall, 0..1. */
  penetrationDamage: number;
  /** Multiplier on the surface ricochet chance. */
  ricochet: number;
  /** Every Nth round is a tracer. 0 disables. */
  tracerEvery: number;
  /** Pellets per trigger pull (shotguns). */
  pellets: number;
  /** Radius of the pellet cone in degrees (shotguns). */
  pelletSpreadDeg: number;
  /** Explosive payload, for launchers. */
  explosive?: { radius: number; damage: number; power: number; kind: string };
}

/* ----------------------------------------------------------------- recoil */

/**
 * A designed recoil pattern.
 *
 * `vertical` / `horizontal` are *per-shot* impulses in degrees, walked in
 * order; past the end of the array the last entry repeats with the jitter
 * still applied, which is exactly how a real spray pattern behaves — a shaped
 * climb that flattens into noise.
 */
export interface RecoilPattern {
  vertical: number[];
  horizontal: number[];
  /** Random spread added to each impulse, degrees, normal-distributed. */
  verticalJitter: number;
  horizontalJitter: number;
  /** First shot out of a burst is multiplied by this (crisper, snappier). */
  firstShot: number;
  /** Fraction of the kick the camera recovers automatically, 0..1. */
  recoverFraction: number;
  /** Seconds of no fire before the pattern index resets. */
  resetTime: number;
  /** ADS multiplier on the whole pattern. */
  adsScale: number;
  /** Crouch/prone stability multiplier. */
  crouchScale: number;
  /** View-model kick: metres back along the bore, and degrees of muzzle climb. */
  viewKickBack: number;
  viewKickUp: number;
  viewKickRoll: number;
  /** Spring constants for the view-model kick recovery. */
  viewFrequency: number;
  viewDamping: number;
  /** Camera shake amplitude per shot. */
  shake: number;
}

/* ----------------------------------------------------------------- spread */

/** Cone half-angles in degrees for each stance. */
export interface SpreadProfile {
  hip: number;
  ads: number;
  crouchScale: number;
  /** Added at full sprint / full walk speed. */
  moving: number;
  movingAds: number;
  /** Added while airborne. */
  jumping: number;
  /** Per-shot bloom added while the trigger is held. */
  bloomPerShot: number;
  bloomMax: number;
  /** Bloom decay in degrees per second. */
  bloomDecay: number;
  /** ADS multiplier applied to bloom (a good gun barely blooms in ADS). */
  bloomAdsScale: number;
  /** True when the first shot from a settled ADS is perfectly accurate. */
  firstShotAccurate: boolean;
}

/* --------------------------------------------------------------- handling */

export interface HandlingProfile {
  /** Seconds from hip to fully sighted. */
  adsTime: number;
  /** Seconds from sprint to able-to-fire. */
  sprintOut: number;
  /** Seconds to reach the sprint pose. */
  sprintIn: number;
  drawTime: number;
  holsterTime: number;
  /** Melee bash duration and the moment damage lands. */
  meleeTime: number;
  meleeHitAt: number;
  meleeDamage: number;
  meleeRange: number;
  /** Movement speed multiplier while carrying / while ADS. */
  moveScale: number;
  adsMoveScale: number;
  /** Weapon mass in kg — drives sway inertia and the bob amplitude. */
  mass: number;
  /** Seconds between the trigger being released and being able to fire again. */
  semiRefire: number;
  /** Rounds fired per burst and the gap between bursts. */
  burstCount: number;
  burstDelay: number;
  /** Seconds of extra cycle time after each shot for a manual action. */
  cycleTime: number;
  /** Seconds the inspect animation runs. */
  inspectTime: number;
}

/* ---------------------------------------------------------------- reloads */

/**
 * Normalised keyframe times inside a reload. `tactical` / `empty` are the
 * absolute durations; everything else is a fraction of whichever is running,
 * so one timeline drives both.
 */
export interface ReloadProfile {
  tactical: number;
  empty: number;
  /** Magazine leaves the well. */
  magOut: number;
  /** Fresh magazine reaches the well. */
  magIn: number;
  /** Magazine is seated (slap). */
  magSeat: number;
  /** Bolt/charging handle released — empty reload only. */
  boltRelease: number;
  /** Fraction at which the ammo counter updates. */
  addAmmoAt: number;
  /** Shell-by-shell reloads (shotguns): per-shell time and the top/tail. */
  perShell?: number;
  shellIn?: number;
  shellOut?: number;
}

/* ------------------------------------------------------------------ audio */

/**
 * Parameters for the synthesised report. The audio module owns the actual
 * synthesis; this is the weapon's voice, described numerically.
 */
export interface AudioProfile {
  /** Fundamental of the low "body" thump, Hz. */
  bodyHz: number;
  /** Body decay, seconds. */
  bodyDecay: number;
  /** Centre of the mid crack band, Hz. */
  crackHz: number;
  crackDecay: number;
  /** Bright transient level 0..2. */
  snap: number;
  /** Tail/reverb send 0..1. */
  tail: number;
  /** Mechanical action noise level 0..1. */
  mech: number;
  /** Overall loudness in dB relative to the mix reference. */
  loudnessDb: number;
  /** Metres at which the report is still audible. */
  audibleRange: number;
  /** Suppressed variant: body/crack scaling and extra "pfft" noise. */
  suppressedBody: number;
  suppressedSnap: number;
  /** Pitch jitter per shot, semitones. */
  pitchJitter: number;
}

/* ------------------------------------------------------- view-model tuning */

export interface ViewProfile {
  /** Hip-fire rest pose, in view space (metres / degrees). */
  hipPosition: Vec3;
  hipRotationDeg: Vec3;
  /** Distance from the eye to the sight when aiming. */
  adsDistance: number;
  /** Extra offset applied on top of the auto-computed sight alignment. */
  adsOffset: Vec3;
  /** Sprint pose. */
  sprintPosition: Vec3;
  sprintRotationDeg: Vec3;
  /** Low-ready pose used near walls and while mantling. */
  lowReadyPosition: Vec3;
  lowReadyRotationDeg: Vec3;
  /** Bob amplitude scale — heavy weapons swing more. */
  bobScale: number;
  /** Sway (mouse lag) scale. */
  swayScale: number;
  /** View-model FOV as a fraction of the world FOV while aiming. */
  adsFovScale: number;
  /** Extra world-FOV squeeze when aiming (scopes). */
  scopeZoom: number;
}

/* ------------------------------------------------------------ mesh tuning */

export type MaterialKey =
  | 'phosphate' | 'blued' | 'polymer' | 'polymerTan' | 'rubber'
  | 'alu' | 'wood' | 'brass' | 'glass' | 'lens' | 'black'
  /** Gloved hands and the sleeve/forearm wrap of the first-person arms. */
  | 'glove' | 'gloveKnuckle' | 'sleeve';

/** Style/dimension inputs to the procedural mesh builder. */
export interface ModelProfile {
  /** Receiver width, height and length in metres. */
  receiver: Vec3;
  /**
   * Height of the top rail surface above the bore. This is the datum the whole
   * upper half of the weapon is built from — receiver top, handguard rail
   * riser, sight bases and optic mounts all key off it, which is what keeps a
   * swapped optic sitting flush instead of floating.
   */
  railHeight: number;
  barrelLength: number;
  barrelRadius: number;
  handguardLength: number;
  handguardRadius: number;
  /** 'rail' = quad-rail, 'mlok' = slotted tube, 'wood' = classic furniture. */
  handguardStyle: 'rail' | 'mlok' | 'wood' | 'shroud' | 'none';
  stockStyle: 'collapsible' | 'fixed' | 'skeleton' | 'thumbhole' | 'none' | 'brace';
  magStyle: 'stanag' | 'curved' | 'stick' | 'drum' | 'box' | 'pistol' | 'tube' | 'none';
  magLength: number;
  magCurve: number;
  action: ActionKind;
  /** Body material and furniture material. */
  bodyMaterial: MaterialKey;
  furnitureMaterial: MaterialKey;
  /** Where the muzzle is, in weapon-local space. */
  muzzle: Vec3;
  /** Where brass leaves the gun. */
  ejectPort: Vec3;
  /** Iron-sight optical axis height above the bore line. */
  sightHeight: number;
  /** Length of the top rail (0 = no rail). */
  topRail: number;
  /** Extra receiver detail flavour. */
  flavour: 'ar' | 'ak' | 'mp' | 'shotgun' | 'sniper' | 'lmg' | 'pistol' | 'launcher';
}

/* --------------------------------------------------------------- the def */

export interface WeaponDef {
  id: string;
  name: string;
  /** Short label for the HUD. */
  short: string;
  cls: WeaponClass;
  slot: 'primary' | 'secondary';
  fireModes: FireMode[];
  defaultFireMode: FireMode;
  rpm: number;
  magSize: number;
  startReserve: number;
  damage: DamageStop[];
  zones: HitZoneMultipliers;
  ballistics: BallisticsProfile;
  recoil: RecoilPattern;
  spread: SpreadProfile;
  handling: HandlingProfile;
  reload: ReloadProfile;
  audio: AudioProfile;
  view: ViewProfile;
  model: ModelProfile;
  /** Attachment ids fitted by default. */
  attachments: string[];
  /** Slots this weapon can accept. */
  slots: AttachmentSlot[];
}

/* ----------------------------------------------------------- attachments */

export type AttachmentSlot = 'optic' | 'muzzle' | 'underbarrel' | 'magazine' | 'stock' | 'laser';

/** Additive / multiplicative stat deltas an attachment applies. */
export interface AttachmentStats {
  adsTimeScale?: number;
  recoilScale?: number;
  recoilHorizontalScale?: number;
  hipSpreadScale?: number;
  adsSpreadScale?: number;
  bloomScale?: number;
  moveScale?: number;
  adsMoveScale?: number;
  magSizeDelta?: number;
  magSizeScale?: number;
  reloadScale?: number;
  muzzleVelocityScale?: number;
  penetrationScale?: number;
  rangeScale?: number;
  /** Suppressor: silences the report and removes the muzzle flash. */
  suppressed?: boolean;
  /** Optic magnification — 1 for a red dot, 4 for an ACOG. */
  magnification?: number;
  /** Laser: shows a beam and tightens hip fire. */
  laser?: boolean;
  sprintOutScale?: number;
  drawScale?: number;
}

export interface AttachmentDef {
  id: string;
  name: string;
  slot: AttachmentSlot;
  /** Weapon classes that can mount it. */
  classes: WeaponClass[] | 'all';
  stats: AttachmentStats;
  /** Free-form build hints consumed by the mesh builder. */
  build: AttachmentBuild;
  description: string;
}

export interface AttachmentBuild {
  kind:
  | 'reddot' | 'holo' | 'acog' | 'sniperScope' | 'ironsOnly'
  | 'suppressor' | 'compensator' | 'brake' | 'flashHider'
  | 'foregrip' | 'angledGrip' | 'bipod' | 'laser'
  | 'extMag' | 'quickMag' | 'drum'
  | 'lightStock' | 'heavyStock' | 'noStock';
  /** Length along the bore, metres. */
  length?: number;
  radius?: number;
  /** Optical axis height above the rail, metres. */
  sightHeight?: number;
  material?: MaterialKey;
  tint?: number;
}

/* ------------------------------------------------------------ runtime state */

export type WeaponState =
  | 'idle' | 'firing' | 'reloading' | 'drawing' | 'holstering'
  | 'melee' | 'inspecting' | 'sprinting';

/** Live, per-instance weapon state. */
export interface WeaponRuntime {
  id: string;
  name: string;
  ammo: number;
  magSize: number;
  reserve: number;
  rpm: number;
  ads: boolean;
  reloading: boolean;
  /* --- extended --- */
  def: WeaponDef;
  fireMode: FireMode;
  attachments: string[];
  /** Rounds fired since the recoil pattern last reset. */
  patternIndex: number;
  /** Accumulated bloom in degrees. */
  bloom: number;
  /** Heat 0..1 for LMG overheat feedback. */
  heat: number;
  chambered: boolean;
}

/** Everything a consumer needs to draw a HUD or synthesise audio. */
export interface WeaponSnapshot {
  id: string;
  name: string;
  short: string;
  cls: WeaponClass;
  ammo: number;
  magSize: number;
  reserve: number;
  fireMode: FireMode;
  ads: number;
  reloading: boolean;
  state: WeaponState;
  spreadDeg: number;
  heat: number;
  attachments: string[];
  suppressed: boolean;
  magnification: number;
}
