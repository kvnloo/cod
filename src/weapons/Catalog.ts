/**
 * The weapon catalogue — eight weapons, one per archetype, with the full stat
 * block each one needs to feel distinct in the hand.
 *
 * ## Weapon-local space
 *
 * Every model is authored in the same frame so the view-model rig, the
 * attachment system and the ballistics all agree:
 *
 *   −Z  down the bore (the muzzle is at negative Z)
 *   +Y  up (the top rail)
 *   +X  the shooter's right (the ejection port side)
 *   origin at the rear face of the receiver, on the bore axis
 *
 * so `model.muzzle` is always `[0, 0, −length]` and the magazine hangs at
 * negative Y. The ADS pose is derived from the *sight* position in this frame,
 * not hand-tuned, which is why swapping an optic automatically re-aligns the
 * aimed pose.
 *
 * ## Balance intent
 *
 * Damage curves are authored as "shots to kill against 100 HP" bands, because
 * that is what a player actually feels:
 *
 *   assault  4 → 5 STK, flat to 30 m
 *   smg      4 → 6 STK, falls off hard past 18 m
 *   marksman 2 → 3 STK, flat to 60 m
 *   sniper   1-shot upper chest, 2-shot elsewhere
 *   lmg      4 → 5 STK but with a long flat range and heavy handling
 *   shotgun  1-shot inside 7 m, useless past 15 m
 *   pistol   5 → 7 STK, the fastest handling in the game
 */

import type {
  AudioProfile, BallisticsProfile, HandlingProfile, HitZoneMultipliers,
  ModelProfile, RecoilPattern, ReloadProfile, SpreadProfile, ViewProfile,
  WeaponDef,
} from './types';

/* ------------------------------------------------------------- shorthands */

const ZONES_RIFLE: HitZoneMultipliers = {
  head: 1.6, neck: 1.45, chest: 1.0, stomach: 1.05, arm: 0.85, leg: 0.8, none: 1.0,
};
const ZONES_SMG: HitZoneMultipliers = {
  head: 1.45, neck: 1.35, chest: 1.0, stomach: 1.0, arm: 0.9, leg: 0.85, none: 1.0,
};
const ZONES_SNIPER: HitZoneMultipliers = {
  head: 2.4, neck: 2.0, chest: 1.5, stomach: 1.2, arm: 0.95, leg: 0.9, none: 1.0,
};
const ZONES_SHOTGUN: HitZoneMultipliers = {
  head: 1.35, neck: 1.25, chest: 1.0, stomach: 1.0, arm: 0.95, leg: 0.9, none: 1.0,
};

function audio(o: Partial<AudioProfile>): AudioProfile {
  return {
    bodyHz: 78, bodyDecay: 0.16, crackHz: 1900, crackDecay: 0.055,
    snap: 1.0, tail: 0.55, mech: 0.5, loudnessDb: 0, audibleRange: 220,
    suppressedBody: 0.55, suppressedSnap: 0.22, pitchJitter: 0.35, ...o,
  };
}

function view(o: Partial<ViewProfile>): ViewProfile {
  return {
    hipPosition: [0.132, -0.104, -0.320],
    hipRotationDeg: [-1.6, 3.2, 1.4],
    adsDistance: 0.185,
    adsOffset: [0, 0, 0],
    sprintPosition: [0.170, -0.146, -0.240],
    sprintRotationDeg: [-13, 34, 22],
    lowReadyPosition: [0.120, -0.168, -0.240],
    lowReadyRotationDeg: [-26, 8, 4],
    bobScale: 1, swayScale: 1, adsFovScale: 0.78, scopeZoom: 1, ...o,
  };
}

function handling(o: Partial<HandlingProfile>): HandlingProfile {
  return {
    adsTime: 0.26, sprintOut: 0.20, sprintIn: 0.18,
    drawTime: 0.62, holsterTime: 0.42,
    meleeTime: 0.72, meleeHitAt: 0.28, meleeDamage: 135, meleeRange: 1.85,
    moveScale: 1, adsMoveScale: 0.62, mass: 3.4, semiRefire: 0.045,
    burstCount: 3, burstDelay: 0.24, cycleTime: 0, inspectTime: 2.6, ...o,
  };
}

function reload(o: Partial<ReloadProfile>): ReloadProfile {
  return {
    tactical: 1.95, empty: 2.55,
    magOut: 0.24, magIn: 0.52, magSeat: 0.66, boltRelease: 0.80,
    addAmmoAt: 0.70, ...o,
  };
}

function ballistics(o: Partial<BallisticsProfile>): BallisticsProfile {
  return {
    muzzleVelocity: 880, drag: 0.00042, gravityScale: 1,
    hitscanRange: 0, penetration: 1.0, penetrationDamage: 0.62,
    ricochet: 1, tracerEvery: 4, pellets: 1, pelletSpreadDeg: 0, ...o,
  };
}

function spread(o: Partial<SpreadProfile>): SpreadProfile {
  return {
    hip: 2.6, ads: 0.10, crouchScale: 0.82, moving: 1.5, movingAds: 0.28,
    jumping: 3.4, bloomPerShot: 0.12, bloomMax: 1.5, bloomDecay: 4.0,
    bloomAdsScale: 0.35, firstShotAccurate: true, ...o,
  };
}

function recoil(o: Partial<RecoilPattern>): RecoilPattern {
  return {
    vertical: [0.6], horizontal: [0],
    verticalJitter: 0.08, horizontalJitter: 0.10,
    firstShot: 1.15, recoverFraction: 0.72, resetTime: 0.35,
    adsScale: 0.78, crouchScale: 0.85,
    viewKickBack: 0.016, viewKickUp: 2.4, viewKickRoll: 1.2,
    viewFrequency: 9.5, viewDamping: 0.55, shake: 0.006, ...o,
  };
}

/* =========================================================================
 * 1. VKR-7 — assault rifle
 * ====================================================================== */

const VKR7: WeaponDef = {
  id: 'ar_vkr7',
  name: 'VKR-7',
  short: 'VKR-7',
  cls: 'assault',
  slot: 'primary',
  fireModes: ['auto', 'burst', 'semi'],
  defaultFireMode: 'auto',
  rpm: 720,
  magSize: 30,
  startReserve: 210,
  damage: [
    { distance: 0, damage: 32 },
    { distance: 28, damage: 32 },
    { distance: 48, damage: 25 },
    { distance: 80, damage: 21 },
    { distance: 140, damage: 18 },
  ],
  zones: ZONES_RIFLE,
  ballistics: ballistics({
    muzzleVelocity: 905, drag: 0.00040, penetration: 1.15,
    penetrationDamage: 0.66, tracerEvery: 4,
  }),
  recoil: recoil({
    // Shaped climb: hard for four, flattens, then drifts right.
    vertical: [0.98, 0.86, 0.74, 0.62, 0.52, 0.46, 0.42, 0.40, 0.38, 0.36, 0.34],
    horizontal: [0.02, -0.10, 0.16, 0.26, 0.20, -0.06, -0.22, -0.30, -0.18, 0.10, 0.24],
    verticalJitter: 0.09, horizontalJitter: 0.11,
    viewKickBack: 0.018, viewKickUp: 2.6, viewKickRoll: 1.3,
    shake: 0.0062,
  }),
  spread: spread({ hip: 2.4, ads: 0.07, moving: 1.4, bloomPerShot: 0.10, bloomMax: 1.3 }),
  handling: handling({ adsTime: 0.25, sprintOut: 0.19, mass: 3.4, moveScale: 1.0 }),
  reload: reload({ tactical: 1.92, empty: 2.60 }),
  audio: audio({ bodyHz: 84, crackHz: 2050, snap: 1.05, loudnessDb: 0, mech: 0.55 }),
  view: view({ adsDistance: 0.205, bobScale: 1.0, swayScale: 1.0, hipPosition: [0.132, -0.104, -0.325] }),
  model: {
    receiver: [0.048, 0.078, 0.255],
    railHeight: 0.0250,
    barrelLength: 0.395,
    barrelRadius: 0.0105,
    handguardLength: 0.270,
    handguardRadius: 0.0195,
    handguardStyle: 'mlok',
    stockStyle: 'collapsible',
    magStyle: 'stanag',
    magLength: 0.185,
    magCurve: 0.10,
    action: 'closedBolt',
    bodyMaterial: 'phosphate',
    furnitureMaterial: 'polymer',
    muzzle: [0, 0, -0.665],
    ejectPort: [0.026, 0.004, -0.135],
    sightHeight: 0.038,
    topRail: 0.530,
    flavour: 'ar',
  },
  attachments: ['optic_reddot'],
  slots: ['optic', 'muzzle', 'underbarrel', 'magazine', 'stock', 'laser'],
};

/* =========================================================================
 * 2. Hornet — SMG
 * ====================================================================== */

const HORNET: WeaponDef = {
  id: 'smg_hornet',
  name: 'Hornet MP',
  short: 'HORNET',
  cls: 'smg',
  slot: 'primary',
  fireModes: ['auto', 'semi'],
  defaultFireMode: 'auto',
  rpm: 900,
  magSize: 32,
  startReserve: 224,
  damage: [
    { distance: 0, damage: 28 },
    { distance: 14, damage: 28 },
    { distance: 24, damage: 21 },
    { distance: 40, damage: 16 },
    { distance: 70, damage: 13 },
  ],
  zones: ZONES_SMG,
  ballistics: ballistics({
    muzzleVelocity: 400, drag: 0.00150, penetration: 0.42,
    penetrationDamage: 0.48, hitscanRange: 55, tracerEvery: 5,
  }),
  recoil: recoil({
    vertical: [0.62, 0.58, 0.54, 0.50, 0.46, 0.44, 0.42, 0.40, 0.38],
    horizontal: [-0.06, 0.14, 0.24, 0.10, -0.16, -0.28, -0.20, 0.06, 0.22],
    verticalJitter: 0.10, horizontalJitter: 0.16,
    adsScale: 0.80, viewKickBack: 0.013, viewKickUp: 2.1, viewKickRoll: 1.6,
    shake: 0.0048, resetTime: 0.30,
  }),
  spread: spread({
    hip: 1.9, ads: 0.16, moving: 0.85, movingAds: 0.22, jumping: 2.8,
    bloomPerShot: 0.09, bloomMax: 1.5, bloomDecay: 5.0,
  }),
  handling: handling({
    adsTime: 0.19, sprintOut: 0.13, sprintIn: 0.14, drawTime: 0.50, holsterTime: 0.34,
    mass: 2.6, moveScale: 1.06, adsMoveScale: 0.72,
  }),
  reload: reload({ tactical: 1.62, empty: 2.20, magOut: 0.22, magIn: 0.48, magSeat: 0.62 }),
  audio: audio({ bodyHz: 96, crackHz: 1650, snap: 0.86, tail: 0.42, mech: 0.62, audibleRange: 160 }),
  view: view({
    adsDistance: 0.185, bobScale: 0.9, swayScale: 1.12,
    hipPosition: [0.126, -0.100, -0.292],
    sprintRotationDeg: [-15, 36, 24],
  }),
  model: {
    receiver: [0.046, 0.074, 0.215],
    railHeight: 0.0235,
    barrelLength: 0.230,
    barrelRadius: 0.0095,
    handguardLength: 0.155,
    handguardRadius: 0.0185,
    handguardStyle: 'rail',
    stockStyle: 'skeleton',
    magStyle: 'stick',
    magLength: 0.205,
    magCurve: 0.03,
    action: 'closedBolt',
    bodyMaterial: 'polymer',
    furnitureMaterial: 'polymer',
    muzzle: [0, 0, -0.465],
    ejectPort: [0.024, 0.004, -0.108],
    sightHeight: 0.036,
    topRail: 0.375,
    flavour: 'mp',
  },
  attachments: ['optic_holo'],
  slots: ['optic', 'muzzle', 'underbarrel', 'magazine', 'stock', 'laser'],
};

/* =========================================================================
 * 3. Breaker 12 — shotgun
 * ====================================================================== */

const BREAKER: WeaponDef = {
  id: 'sg_breaker',
  name: 'Breaker 12',
  short: 'BREAKER',
  cls: 'shotgun',
  slot: 'primary',
  fireModes: ['semi'],
  defaultFireMode: 'semi',
  rpm: 210,
  magSize: 7,
  startReserve: 42,
  damage: [
    { distance: 0, damage: 17 },
    { distance: 7, damage: 15 },
    { distance: 12, damage: 8 },
    { distance: 18, damage: 3 },
    { distance: 26, damage: 1 },
  ],
  zones: ZONES_SHOTGUN,
  ballistics: ballistics({
    muzzleVelocity: 380, drag: 0.0034, penetration: 0.20,
    penetrationDamage: 0.30, hitscanRange: 30,
    pellets: 8, pelletSpreadDeg: 3.1, tracerEvery: 0,
  }),
  recoil: recoil({
    vertical: [2.6, 2.5, 2.4],
    horizontal: [0.22, -0.28, 0.34],
    verticalJitter: 0.22, horizontalJitter: 0.24,
    firstShot: 1.0, recoverFraction: 0.66, adsScale: 0.85,
    viewKickBack: 0.048, viewKickUp: 6.2, viewKickRoll: 2.4,
    viewFrequency: 7.0, viewDamping: 0.62, shake: 0.019, resetTime: 0.6,
  }),
  spread: spread({
    hip: 0.6, ads: 0.35, moving: 0.4, movingAds: 0.2, jumping: 1.2,
    bloomPerShot: 0, bloomMax: 0, firstShotAccurate: false,
  }),
  handling: handling({
    adsTime: 0.30, sprintOut: 0.24, drawTime: 0.70, holsterTime: 0.46,
    mass: 3.9, moveScale: 0.96, adsMoveScale: 0.58, semiRefire: 0.10,
  }),
  reload: reload({
    tactical: 0.0, empty: 0.0, perShell: 0.42, shellIn: 0.34, shellOut: 0.30,
    magOut: 0, magIn: 0, magSeat: 0, boltRelease: 0, addAmmoAt: 0.55,
  }),
  audio: audio({
    bodyHz: 58, bodyDecay: 0.30, crackHz: 1180, crackDecay: 0.09,
    snap: 1.4, tail: 0.8, mech: 0.8, loudnessDb: 3, audibleRange: 260,
  }),
  view: view({
    adsDistance: 0.215, bobScale: 1.12, swayScale: 0.9,
    hipPosition: [0.136, -0.110, -0.348],
  }),
  model: {
    receiver: [0.050, 0.082, 0.245],
    railHeight: 0.0255,
    barrelLength: 0.470,
    barrelRadius: 0.0135,
    handguardLength: 0.230,
    handguardRadius: 0.0225,
    handguardStyle: 'rail',
    stockStyle: 'fixed',
    magStyle: 'tube',
    magLength: 0.430,
    magCurve: 0,
    action: 'tube',
    bodyMaterial: 'blued',
    furnitureMaterial: 'polymer',
    muzzle: [0, 0, -0.735],
    ejectPort: [0.026, 0.006, -0.140],
    sightHeight: 0.032,
    topRail: 0.250,
    flavour: 'shotgun',
  },
  attachments: [],
  slots: ['optic', 'muzzle', 'underbarrel', 'stock', 'laser'],
};

/* =========================================================================
 * 4. Longbow — bolt-action sniper
 * ====================================================================== */

const LONGBOW: WeaponDef = {
  id: 'sr_longbow',
  name: 'Longbow M700',
  short: 'LONGBOW',
  cls: 'sniper',
  slot: 'primary',
  fireModes: ['semi'],
  defaultFireMode: 'semi',
  rpm: 48,
  magSize: 5,
  startReserve: 30,
  damage: [
    { distance: 0, damage: 96 },
    { distance: 120, damage: 96 },
    { distance: 220, damage: 82 },
    { distance: 400, damage: 70 },
  ],
  zones: ZONES_SNIPER,
  ballistics: ballistics({
    muzzleVelocity: 840, drag: 0.00026, penetration: 2.6,
    penetrationDamage: 0.85, tracerEvery: 0, ricochet: 0.6,
  }),
  recoil: recoil({
    vertical: [4.4], horizontal: [0.32],
    verticalJitter: 0.35, horizontalJitter: 0.35,
    firstShot: 1.0, recoverFraction: 0.55, adsScale: 0.92,
    viewKickBack: 0.062, viewKickUp: 8.5, viewKickRoll: 2.0,
    viewFrequency: 6.0, viewDamping: 0.66, shake: 0.024, resetTime: 1.0,
  }),
  spread: spread({
    hip: 6.5, ads: 0.0, moving: 3.0, movingAds: 0.55, jumping: 8.0,
    bloomPerShot: 0, bloomMax: 0, firstShotAccurate: true,
  }),
  handling: handling({
    adsTime: 0.42, sprintOut: 0.32, sprintIn: 0.22, drawTime: 0.86, holsterTime: 0.56,
    mass: 5.6, moveScale: 0.90, adsMoveScale: 0.38, semiRefire: 0.02,
    cycleTime: 0.95, meleeTime: 0.80, meleeHitAt: 0.32,
  }),
  reload: reload({
    tactical: 2.85, empty: 3.30, magOut: 0.26, magIn: 0.55, magSeat: 0.68,
    boltRelease: 0.84, addAmmoAt: 0.72,
  }),
  audio: audio({
    bodyHz: 62, bodyDecay: 0.42, crackHz: 2400, crackDecay: 0.12,
    snap: 1.6, tail: 1.0, mech: 0.9, loudnessDb: 6, audibleRange: 420,
  }),
  view: view({
    adsDistance: 0.215, bobScale: 1.25, swayScale: 0.72,
    hipPosition: [0.140, -0.114, -0.372],
    adsFovScale: 0.55, scopeZoom: 0.34,
    sprintRotationDeg: [-12, 32, 20],
  }),
  model: {
    receiver: [0.044, 0.072, 0.300],
    railHeight: 0.0245,
    barrelLength: 0.620,
    barrelRadius: 0.0135,
    handguardLength: 0.300,
    handguardRadius: 0.0250,
    handguardStyle: 'none',
    stockStyle: 'thumbhole',
    magStyle: 'box',
    magLength: 0.095,
    magCurve: 0,
    action: 'boltAction',
    bodyMaterial: 'blued',
    furnitureMaterial: 'polymer',
    muzzle: [0, 0, -0.940],
    ejectPort: [0.024, 0.006, -0.170],
    sightHeight: 0.040,
    topRail: 0.340,
    flavour: 'sniper',
  },
  attachments: ['optic_sniper'],
  slots: ['optic', 'muzzle', 'underbarrel', 'magazine', 'stock'],
};

/* =========================================================================
 * 5. Vulcan-9 — LMG
 * ====================================================================== */

const VULCAN: WeaponDef = {
  id: 'lmg_vulcan',
  name: 'Vulcan-9',
  short: 'VULCAN',
  cls: 'lmg',
  slot: 'primary',
  fireModes: ['auto'],
  defaultFireMode: 'auto',
  rpm: 640,
  magSize: 100,
  startReserve: 300,
  damage: [
    { distance: 0, damage: 33 },
    { distance: 46, damage: 33 },
    { distance: 76, damage: 27 },
    { distance: 130, damage: 22 },
    { distance: 220, damage: 19 },
  ],
  zones: ZONES_RIFLE,
  ballistics: ballistics({
    muzzleVelocity: 860, drag: 0.00036, penetration: 1.9,
    penetrationDamage: 0.74, tracerEvery: 3,
  }),
  recoil: recoil({
    vertical: [1.10, 1.00, 0.92, 0.84, 0.78, 0.72, 0.66, 0.62, 0.58, 0.56, 0.54, 0.52],
    horizontal: [-0.08, 0.18, 0.34, 0.22, -0.14, -0.36, -0.44, -0.24, 0.12, 0.34, 0.42, 0.20],
    verticalJitter: 0.14, horizontalJitter: 0.20,
    adsScale: 0.72, crouchScale: 0.72,
    viewKickBack: 0.024, viewKickUp: 3.2, viewKickRoll: 1.5,
    viewFrequency: 8.0, viewDamping: 0.60, shake: 0.0095, resetTime: 0.45,
  }),
  spread: spread({
    hip: 4.2, ads: 0.12, moving: 2.2, movingAds: 0.44, jumping: 6.0,
    bloomPerShot: 0.06, bloomMax: 1.1, bloomDecay: 3.2,
  }),
  handling: handling({
    adsTime: 0.42, sprintOut: 0.36, sprintIn: 0.26, drawTime: 1.05, holsterTime: 0.68,
    mass: 8.2, moveScale: 0.84, adsMoveScale: 0.42,
  }),
  reload: reload({
    tactical: 4.20, empty: 5.10, magOut: 0.22, magIn: 0.52, magSeat: 0.66,
    boltRelease: 0.86, addAmmoAt: 0.76,
  }),
  audio: audio({
    bodyHz: 70, bodyDecay: 0.22, crackHz: 1800, crackDecay: 0.07,
    snap: 1.25, tail: 0.75, mech: 0.85, loudnessDb: 4, audibleRange: 320,
  }),
  view: view({
    adsDistance: 0.215, bobScale: 1.35, swayScale: 0.66,
    hipPosition: [0.146, -0.120, -0.362],
    sprintPosition: [0.188, -0.166, -0.256],
    sprintRotationDeg: [-16, 30, 26],
  }),
  model: {
    receiver: [0.058, 0.092, 0.330],
    railHeight: 0.0300,
    barrelLength: 0.520,
    barrelRadius: 0.0135,
    handguardLength: 0.230,
    handguardRadius: 0.0250,
    handguardStyle: 'shroud',
    stockStyle: 'fixed',
    magStyle: 'drum',
    magLength: 0.175,
    magCurve: 0,
    action: 'beltFed',
    bodyMaterial: 'phosphate',
    furnitureMaterial: 'polymer',
    muzzle: [0, 0, -0.890],
    ejectPort: [0.030, 0.000, -0.170],
    sightHeight: 0.048,
    topRail: 0.320,
    flavour: 'lmg',
  },
  attachments: ['optic_reddot', 'under_bipod'],
  slots: ['optic', 'muzzle', 'underbarrel', 'magazine', 'stock', 'laser'],
};

/* =========================================================================
 * 6. Kestrel — marksman rifle
 * ====================================================================== */

const KESTREL: WeaponDef = {
  id: 'dmr_kestrel',
  name: 'Kestrel MK14',
  short: 'KESTREL',
  cls: 'marksman',
  slot: 'primary',
  fireModes: ['semi'],
  defaultFireMode: 'semi',
  rpm: 340,
  magSize: 20,
  startReserve: 120,
  damage: [
    { distance: 0, damage: 55 },
    { distance: 62, damage: 55 },
    { distance: 110, damage: 44 },
    { distance: 190, damage: 36 },
  ],
  zones: ZONES_SNIPER,
  ballistics: ballistics({
    muzzleVelocity: 850, drag: 0.00030, penetration: 2.0,
    penetrationDamage: 0.80, tracerEvery: 6,
  }),
  recoil: recoil({
    vertical: [1.85, 1.70, 1.62, 1.56, 1.50],
    horizontal: [0.12, -0.26, 0.32, -0.18, 0.24],
    verticalJitter: 0.16, horizontalJitter: 0.20,
    firstShot: 1.0, recoverFraction: 0.68, adsScale: 0.85,
    viewKickBack: 0.030, viewKickUp: 4.4, viewKickRoll: 1.4,
    viewFrequency: 8.5, viewDamping: 0.58, shake: 0.011, resetTime: 0.55,
  }),
  spread: spread({
    hip: 3.6, ads: 0.02, moving: 2.0, movingAds: 0.40, jumping: 5.0,
    bloomPerShot: 0.26, bloomMax: 1.0, bloomDecay: 3.4, bloomAdsScale: 0.5,
  }),
  handling: handling({
    adsTime: 0.32, sprintOut: 0.24, drawTime: 0.76, holsterTime: 0.50,
    mass: 4.6, moveScale: 0.94, adsMoveScale: 0.50, semiRefire: 0.02,
  }),
  reload: reload({ tactical: 2.30, empty: 2.95 }),
  audio: audio({
    bodyHz: 68, bodyDecay: 0.30, crackHz: 2200, crackDecay: 0.09,
    snap: 1.35, tail: 0.82, mech: 0.7, loudnessDb: 4, audibleRange: 330,
  }),
  view: view({
    adsDistance: 0.205, bobScale: 1.1, swayScale: 0.82,
    hipPosition: [0.138, -0.112, -0.348],
    adsFovScale: 0.66, scopeZoom: 0.62,
  }),
  model: {
    receiver: [0.048, 0.082, 0.290],
    railHeight: 0.0255,
    barrelLength: 0.500,
    barrelRadius: 0.0125,
    handguardLength: 0.315,
    handguardRadius: 0.0200,
    handguardStyle: 'rail',
    stockStyle: 'fixed',
    magStyle: 'curved',
    magLength: 0.190,
    magCurve: 0.13,
    action: 'closedBolt',
    bodyMaterial: 'phosphate',
    furnitureMaterial: 'polymerTan',
    muzzle: [0, 0, -0.820],
    ejectPort: [0.026, 0.004, -0.150],
    sightHeight: 0.039,
    topRail: 0.620,
    flavour: 'ar',
  },
  attachments: ['optic_acog'],
  slots: ['optic', 'muzzle', 'underbarrel', 'magazine', 'stock', 'laser'],
};

/* =========================================================================
 * 7. Sidewinder — pistol
 * ====================================================================== */

const SIDEWINDER: WeaponDef = {
  id: 'pi_sidewinder',
  name: 'Sidewinder .45',
  short: 'SIDEWINDER',
  cls: 'pistol',
  slot: 'secondary',
  fireModes: ['semi'],
  defaultFireMode: 'semi',
  rpm: 420,
  magSize: 15,
  startReserve: 75,
  damage: [
    { distance: 0, damage: 26 },
    { distance: 18, damage: 26 },
    { distance: 32, damage: 19 },
    { distance: 55, damage: 15 },
  ],
  zones: ZONES_SMG,
  ballistics: ballistics({
    muzzleVelocity: 320, drag: 0.00180, penetration: 0.30,
    penetrationDamage: 0.40, hitscanRange: 55, tracerEvery: 0,
  }),
  recoil: recoil({
    vertical: [1.35, 1.25, 1.18, 1.12],
    horizontal: [-0.14, 0.22, -0.26, 0.18],
    verticalJitter: 0.14, horizontalJitter: 0.20,
    recoverFraction: 0.75, adsScale: 0.82,
    viewKickBack: 0.020, viewKickUp: 4.0, viewKickRoll: 2.4,
    viewFrequency: 12.0, viewDamping: 0.50, shake: 0.005, resetTime: 0.4,
  }),
  spread: spread({
    hip: 1.7, ads: 0.14, moving: 0.8, movingAds: 0.20, jumping: 2.4,
    bloomPerShot: 0.22, bloomMax: 1.6, bloomDecay: 5.5,
  }),
  handling: handling({
    adsTime: 0.155, sprintOut: 0.10, sprintIn: 0.12, drawTime: 0.38, holsterTime: 0.26,
    mass: 1.1, moveScale: 1.12, adsMoveScale: 0.82, semiRefire: 0.02,
    meleeTime: 0.58, meleeHitAt: 0.22, inspectTime: 2.1,
  }),
  reload: reload({
    tactical: 1.35, empty: 1.95, magOut: 0.20, magIn: 0.46, magSeat: 0.60,
    boltRelease: 0.78, addAmmoAt: 0.66,
  }),
  audio: audio({
    bodyHz: 110, bodyDecay: 0.13, crackHz: 1500, crackDecay: 0.05,
    snap: 0.95, tail: 0.4, mech: 0.7, loudnessDb: -1, audibleRange: 150,
  }),
  view: view({
    adsDistance: 0.255, bobScale: 0.72, swayScale: 1.35,
    hipPosition: [0.114, -0.116, -0.278],
    hipRotationDeg: [-2.4, 4.0, 1.0],
    sprintPosition: [0.142, -0.158, -0.218],
    sprintRotationDeg: [-20, 40, 18],
    adsFovScale: 0.86,
  }),
  model: {
    receiver: [0.030, 0.055, 0.150],
    railHeight: 0.0180,
    barrelLength: 0.058,
    barrelRadius: 0.0072,
    handguardLength: 0,
    handguardRadius: 0,
    handguardStyle: 'none',
    stockStyle: 'none',
    magStyle: 'pistol',
    magLength: 0.092,
    magCurve: 0,
    action: 'closedBolt',
    bodyMaterial: 'blued',
    furnitureMaterial: 'polymer',
    muzzle: [0, 0, -0.180],
    ejectPort: [0.015, 0.010, -0.058],
    sightHeight: 0.022,
    topRail: 0,
    flavour: 'pistol',
  },
  attachments: [],
  slots: ['optic', 'muzzle', 'magazine', 'laser'],
};

/* =========================================================================
 * 8. Ravager — rocket launcher
 * ====================================================================== */

const RAVAGER: WeaponDef = {
  id: 'lch_ravager',
  name: 'Ravager RPG',
  short: 'RAVAGER',
  cls: 'launcher',
  slot: 'secondary',
  fireModes: ['semi'],
  defaultFireMode: 'semi',
  rpm: 30,
  magSize: 1,
  startReserve: 4,
  damage: [
    { distance: 0, damage: 150 },
    { distance: 6, damage: 90 },
    { distance: 10, damage: 20 },
  ],
  zones: { head: 1, neck: 1, chest: 1, stomach: 1, arm: 1, leg: 1, none: 1 },
  ballistics: ballistics({
    muzzleVelocity: 90, drag: 0.00010, gravityScale: 0.35,
    penetration: 0.2, penetrationDamage: 0, tracerEvery: 0, ricochet: 0,
    explosive: { radius: 8.5, damage: 150, power: 34, kind: 'rocket' },
  }),
  recoil: recoil({
    vertical: [3.2], horizontal: [0.5],
    verticalJitter: 0.4, horizontalJitter: 0.5,
    firstShot: 1.0, recoverFraction: 0.6, adsScale: 0.9,
    viewKickBack: 0.055, viewKickUp: 6.0, viewKickRoll: 2.0,
    viewFrequency: 5.5, viewDamping: 0.7, shake: 0.03, resetTime: 1.5,
  }),
  spread: spread({
    hip: 1.2, ads: 0.0, moving: 0.5, movingAds: 0.1, jumping: 2.0,
    bloomPerShot: 0, bloomMax: 0, firstShotAccurate: true,
  }),
  handling: handling({
    adsTime: 0.42, sprintOut: 0.34, sprintIn: 0.26, drawTime: 1.10, holsterTime: 0.70,
    mass: 7.0, moveScale: 0.88, adsMoveScale: 0.5, semiRefire: 0.4,
    meleeTime: 0.86, meleeHitAt: 0.34, meleeDamage: 150,
  }),
  reload: reload({
    tactical: 3.60, empty: 3.60, magOut: 0.16, magIn: 0.58, magSeat: 0.74,
    boltRelease: 0.86, addAmmoAt: 0.80,
  }),
  audio: audio({
    bodyHz: 48, bodyDecay: 0.55, crackHz: 900, crackDecay: 0.25,
    snap: 1.2, tail: 1.0, mech: 0.5, loudnessDb: 6, audibleRange: 400,
  }),
  view: view({
    adsDistance: 0.205, bobScale: 1.3, swayScale: 0.7,
    hipPosition: [0.136, -0.106, -0.335],
    hipRotationDeg: [-2.0, 4.0, 3.0],
    sprintPosition: [0.176, -0.158, -0.246],
    sprintRotationDeg: [-14, 30, 24],
  }),
  model: {
    receiver: [0.050, 0.098, 0.240],
    railHeight: 0.0480,
    barrelLength: 0.320,
    barrelRadius: 0.0400,
    handguardLength: 0.180,
    handguardRadius: 0.0455,
    handguardStyle: 'wood',
    stockStyle: 'none',
    magStyle: 'none',
    magLength: 0,
    magCurve: 0,
    action: 'tube',
    bodyMaterial: 'phosphate',
    furnitureMaterial: 'wood',
    muzzle: [0, 0, -0.560],
    ejectPort: [0, 0, 0.16],
    sightHeight: 0.075,
    topRail: 0,
    flavour: 'launcher',
  },
  attachments: [],
  slots: ['optic'],
};

/* ------------------------------------------------------------------ index */

export const WEAPONS: WeaponDef[] = [
  VKR7, HORNET, BREAKER, LONGBOW, VULCAN, KESTREL, SIDEWINDER, RAVAGER,
];

const BY_ID = new Map<string, WeaponDef>(WEAPONS.map((w) => [w.id, w]));

export function weaponDef(id: string): WeaponDef {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`[weapons] unknown weapon "${id}"`);
  return d;
}

export function hasWeapon(id: string): boolean { return BY_ID.has(id); }

/** The default loadout: primary, secondary. */
export const DEFAULT_LOADOUT = ['ar_vkr7', 'pi_sidewinder'];

/** Damage at a distance, linearly interpolated between authored stops. */
export function damageAt(def: WeaponDef, distance: number): number {
  const c = def.damage;
  if (distance <= c[0].distance) return c[0].damage;
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1], b = c[i];
    if (distance <= b.distance) {
      const t = (distance - a.distance) / Math.max(1e-4, b.distance - a.distance);
      return a.damage + (b.damage - a.damage) * t;
    }
  }
  return c[c.length - 1].damage;
}

/** Shots to kill against `health` at a distance, for the balance pass. */
export function shotsToKill(def: WeaponDef, distance: number, zone: keyof WeaponDef['zones'] = 'chest', health = 100): number {
  const dmg = damageAt(def, distance) * def.zones[zone] * Math.max(1, def.ballistics.pellets);
  return Math.max(1, Math.ceil(health / Math.max(1e-3, dmg)));
}
