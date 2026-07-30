//#region src/session/loadout/types.ts
var LOADOUT_SLOTS = [
	"optic",
	"muzzle",
	"barrel",
	"underbarrel",
	"magazine",
	"stock",
	"laser"
];
var STAT_KEYS = [
	"adsTime",
	"sprintOut",
	"drawTime",
	"holsterTime",
	"reloadTime",
	"moveScale",
	"adsMoveScale",
	"sway",
	"flinch",
	"recoilVertical",
	"recoilHorizontal",
	"recoilFirstShot",
	"recoilRecovery",
	"hipSpread",
	"adsSpread",
	"bloomPerShot",
	"bloomDecay",
	"magSize",
	"reserveAmmo",
	"muzzleVelocity",
	"penetration",
	"falloffRange",
	"damage",
	"fireRate",
	"magnification"
];
//#endregion
//#region src/session/loadout/data/balance.ts
/**
* Per-stat rules.
*
* `soften` is lowest where stacking is most tempting and most damaging:
* hip-fire spread (laser + no-stock + short barrel) and recoil (comp + grip +
* heavy stock) are the two builds that historically break shooters.
*/
var STAT_RULES = {
	adsTime: {
		label: "ADS",
		unit: "s",
		better: "lower",
		soften: .72,
		minMul: .62,
		maxMul: 1.85,
		min: .08
	},
	sprintOut: {
		label: "Sprint-out",
		unit: "s",
		better: "lower",
		soften: .75,
		minMul: .55,
		maxMul: 1.7,
		min: .05
	},
	drawTime: {
		label: "Draw",
		unit: "s",
		better: "lower",
		soften: .8,
		minMul: .55,
		maxMul: 1.6,
		min: .12
	},
	holsterTime: {
		label: "Holster",
		unit: "s",
		better: "lower",
		soften: .8,
		minMul: .55,
		maxMul: 1.6,
		min: .08
	},
	reloadTime: {
		label: "Reload",
		unit: "×",
		better: "lower",
		soften: .7,
		minMul: .62,
		maxMul: 1.9
	},
	moveScale: {
		label: "Move",
		unit: "×",
		better: "higher",
		soften: .65,
		minMul: .86,
		maxMul: 1.14,
		min: .68,
		max: 1.15
	},
	adsMoveScale: {
		label: "ADS move",
		unit: "×",
		better: "higher",
		soften: .65,
		minMul: .8,
		maxMul: 1.6,
		min: .2,
		max: .95
	},
	sway: {
		label: "Sway",
		unit: "×",
		better: "lower",
		soften: .72,
		minMul: .5,
		maxMul: 2.2
	},
	flinch: {
		label: "Flinch",
		unit: "×",
		better: "lower",
		soften: .75,
		minMul: .5,
		maxMul: 1.6
	},
	recoilVertical: {
		label: "Recoil ↕",
		unit: "×",
		better: "lower",
		soften: .68,
		minMul: .45,
		maxMul: 1.8
	},
	recoilHorizontal: {
		label: "Recoil ↔",
		unit: "×",
		better: "lower",
		soften: .68,
		minMul: .45,
		maxMul: 1.8
	},
	recoilFirstShot: {
		label: "1st shot",
		unit: "×",
		better: "lower",
		soften: .8,
		minMul: .6,
		maxMul: 1.5
	},
	recoilRecovery: {
		label: "Recovery",
		unit: "",
		better: "higher",
		soften: .8,
		minMul: .8,
		maxMul: 1.45,
		max: .95
	},
	hipSpread: {
		label: "Hipfire",
		unit: "°",
		better: "lower",
		soften: .62,
		minMul: .45,
		maxMul: 1.9,
		min: .35
	},
	adsSpread: {
		label: "ADS spread",
		unit: "°",
		better: "lower",
		soften: .7,
		minMul: .35,
		maxMul: 1.6,
		min: .005
	},
	bloomPerShot: {
		label: "Bloom",
		unit: "°",
		better: "lower",
		soften: .7,
		minMul: .4,
		maxMul: 1.8
	},
	bloomDecay: {
		label: "Bloom decay",
		unit: "°/s",
		better: "higher",
		soften: .8,
		minMul: .7,
		maxMul: 1.6
	},
	magSize: {
		label: "Mag",
		unit: "",
		better: "higher",
		soften: .85,
		minMul: .5,
		maxMul: 2.5,
		min: 1,
		max: 250,
		integer: true
	},
	reserveAmmo: {
		label: "Reserve",
		unit: "",
		better: "higher",
		soften: .85,
		minMul: .5,
		maxMul: 2,
		min: 0,
		max: 900,
		integer: true
	},
	muzzleVelocity: {
		label: "Velocity",
		unit: "m/s",
		better: "higher",
		soften: .8,
		minMul: .85,
		maxMul: 1.35
	},
	penetration: {
		label: "Pierce",
		unit: "",
		better: "higher",
		soften: .8,
		minMul: .7,
		maxMul: 1.6
	},
	falloffRange: {
		label: "Range",
		unit: "×",
		better: "higher",
		soften: .7,
		minMul: .78,
		maxMul: 1.45
	},
	damage: {
		label: "Damage",
		unit: "×",
		better: "higher",
		soften: .9,
		minMul: .9,
		maxMul: 1.12
	},
	fireRate: {
		label: "RPM",
		unit: "×",
		better: "higher",
		soften: .9,
		minMul: .88,
		maxMul: 1.15
	},
	magnification: {
		label: "Zoom",
		unit: "×",
		better: "higher",
		soften: 1,
		minMul: 1,
		maxMul: 12,
		min: 1,
		max: 12
	}
};
var RELOAD_RAILS = {
	tactical: {
		min: .35,
		max: 5.6
	},
	empty: {
		min: .45,
		max: 7.2
	},
	perShell: {
		min: .12,
		max: 1
	}
};
/** Structural limits. A mode may widen these through `ValidationContext`. */
var LIMITS = {
	attachmentsPerWeapon: 5,
	savedClasses: 10,
	killstreaks: 3,
	nameMaxLength: 24
};
/**
* Whether a flag is an upside or a downside. The no-free-lunch audit counts a
* `con` flag as a real cost, which is how a laser (all upside numerically, but
* a beam that gives your position away) passes the audit honestly.
*/
var FLAG_SIDE = {
	suppressed: "pro",
	noFlash: "pro",
	loud: "con",
	laser: "pro",
	laserVisible: "con",
	bipod: "pro",
	thermal: "pro",
	scavenger: "pro",
	ghost: "pro",
	hardline: "pro",
	overkill: "pro",
	tacMask: "pro",
	silentMove: "pro"
};
var FLAG_LABEL = {
	suppressed: "Suppressed",
	noFlash: "No muzzle flash",
	loud: "Louder report",
	laser: "Laser",
	laserVisible: "Visible beam",
	bipod: "Bipod",
	thermal: "Thermal",
	scavenger: "Scavenger",
	ghost: "Ghost",
	hardline: "Hardline",
	overkill: "Overkill",
	tacMask: "Tac Mask",
	silentMove: "Silent movement"
};
/**
* Applies the stat-rule and limit halves of a patch in place. The attachment /
* perk halves are applied by `data/attachments.ts` and `data/perks.ts`, which
* own those tables; `applyTuningPatch` in `../Tuning.ts` drives all three.
*/
function applyStatTuning(patch) {
	const notes = [];
	if (patch.stats) for (const key of Object.keys(patch.stats)) {
		const over = patch.stats[key];
		const rule = STAT_RULES[key];
		if (!over || !rule) continue;
		for (const field of Object.keys(over)) {
			const v = over[field];
			if (v === void 0) continue;
			rule[field] = v;
			notes.push(`stat ${key}.${String(field)} = ${String(v)}`);
		}
	}
	if (patch.reload) for (const key of Object.keys(patch.reload)) {
		const over = patch.reload[key];
		const rail = RELOAD_RAILS[key];
		if (!over || !rail) continue;
		for (const side of ["min", "max"]) {
			const v = over[side];
			if (typeof v !== "number" || !Number.isFinite(v)) continue;
			rail[side] = v;
			notes.push(`reload ${key}.${side} = ${v}`);
		}
	}
	if (patch.limits) for (const field of Object.keys(patch.limits)) {
		const v = patch.limits[field];
		if (typeof v !== "number" || !Number.isFinite(v)) continue;
		LIMITS[field] = v;
		notes.push(`limit ${field} = ${v}`);
	}
	return notes;
}
//#endregion
//#region src/session/loadout/Modifiers.ts
var EPS = 1e-9;
/**
* Accumulates modifiers from any number of sources and folds them per stat.
*
* Sources are added by id so contributions stay attributable — the armoury can
* show "−18% recoil from the Compensator" without the resolver knowing what an
* armoury is.
*/
var ModifierStack = class {
	muls = /* @__PURE__ */ new Map();
	adds = /* @__PURE__ */ new Map();
	maxes = /* @__PURE__ */ new Map();
	flagSet = /* @__PURE__ */ new Set();
	flagOwner = /* @__PURE__ */ new Map();
	/** Adds every modifier of one source. Adding the same source twice doubles it. */
	add(source, mods, flags) {
		for (const mod of mods) {
			if (!Number.isFinite(mod.value)) continue;
			if (!STAT_RULES[mod.stat]) continue;
			const bucket = mod.mode === "mul" ? this.muls : mod.mode === "add" ? this.adds : this.maxes;
			let list = bucket.get(mod.stat);
			if (!list) {
				list = [];
				bucket.set(mod.stat, list);
			}
			list.push({
				source,
				value: mod.value
			});
		}
		for (const f of flags ?? []) {
			if (!this.flagSet.has(f)) this.flagOwner.set(f, source);
			this.flagSet.add(f);
		}
	}
	has(flag) {
		return this.flagSet.has(flag);
	}
	get flags() {
		return [...this.flagSet].sort();
	}
	/** Which source granted a flag first — for tooltips. */
	ownerOf(flag) {
		return this.flagOwner.get(flag) ?? null;
	}
	/** True when nothing at all touches this stat. */
	untouched(stat) {
		return !this.muls.has(stat) && !this.adds.has(stat) && !this.maxes.has(stat);
	}
	/** Folds one stat against a weapon's base value. Pure — safe to call repeatedly. */
	fold(stat, base) {
		const rule = STAT_RULES[stat];
		const contributions = [];
		const muls = this.muls.get(stat) ?? [];
		const good = [];
		let harm = 0;
		for (const e of muls) {
			const dev = e.value - 1;
			if (Math.abs(dev) < EPS) {
				contributions.push({
					source: e.source,
					mode: "mul",
					value: e.value,
					applied: 0,
					beneficial: false
				});
				continue;
			}
			if (rule.better === "higher" ? dev > 0 : dev < 0) good.push({
				...e,
				dev
			});
			else {
				harm += dev;
				contributions.push({
					source: e.source,
					mode: "mul",
					value: e.value,
					applied: dev,
					beneficial: false
				});
			}
		}
		good.sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
		let benefit = 0;
		for (let i = 0; i < good.length; i++) {
			const w = Math.pow(rule.soften, i);
			const applied = good[i].dev * w;
			benefit += applied;
			contributions.push({
				source: good[i].source,
				mode: "mul",
				value: good[i].value,
				applied,
				beneficial: true
			});
		}
		let factor = 1 + benefit + harm;
		if (factor < .05) factor = .05;
		let addend = 0;
		for (const e of this.adds.get(stat) ?? []) {
			addend += e.value;
			contributions.push({
				source: e.source,
				mode: "add",
				value: e.value,
				applied: e.value,
				beneficial: rule.better === "higher" ? e.value > 0 : e.value < 0
			});
		}
		let value = base * factor + addend;
		for (const e of this.maxes.get(stat) ?? []) {
			contributions.push({
				source: e.source,
				mode: "max",
				value: e.value,
				applied: e.value,
				beneficial: true
			});
			if (e.value > value) value = e.value;
		}
		const { lo, hi } = railBounds(base, rule);
		const raw = value;
		let out = value < lo ? lo : value > hi ? hi : value;
		let capped = Math.abs(out - raw) > Math.max(EPS, Math.abs(raw) * 1e-9);
		let rounded = false;
		if (rule.integer) {
			const whole = Math.round(out);
			rounded = Math.abs(whole - out) > EPS;
			if (whole > hi) {
				out = Math.floor(hi);
				capped = true;
			} else if (whole < lo) {
				out = Math.ceil(lo);
				capped = true;
			} else out = whole;
		}
		value = out;
		return {
			stat,
			base,
			value,
			factor,
			addend,
			capped,
			rounded,
			contributions
		};
	}
	/** Convenience: fold and return only the number. */
	value(stat, base) {
		return this.fold(stat, base).value;
	}
};
/**
* The concrete rails for one base value: the relative pair intersected with the
* absolute pair. A weapon whose base already sits on an absolute rail keeps a
* usable window rather than collapsing to a point.
*/
function railBounds(base, rule) {
	let lo = base > 0 ? base * rule.minMul : -Infinity;
	let hi = base > 0 ? base * rule.maxMul : Infinity;
	if (rule.min !== void 0) lo = Math.max(lo, Math.min(rule.min, base));
	if (rule.max !== void 0) hi = Math.min(hi, Math.max(rule.max, base));
	if (hi < lo) hi = lo;
	return {
		lo,
		hi
	};
}
/** Applies the relative rails, then the absolute ones. */
function clampToRule(value, base, rule) {
	const { lo, hi } = railBounds(base, rule);
	return value < lo ? lo : value > hi ? hi : value;
}
/**
* The rails a stat can reach for a given base, as concrete numbers. Used by the
* verification tool and by any UI that wants to draw a bar with real endpoints.
*/
function railsFor(stat, base) {
	return railBounds(base, STAT_RULES[stat]);
}
//#endregion
//#region src/weapons/Catalog.ts
var ZONES_RIFLE = {
	head: 1.6,
	neck: 1.45,
	chest: 1,
	stomach: 1.05,
	arm: .85,
	leg: .8,
	none: 1
};
var ZONES_SMG = {
	head: 1.45,
	neck: 1.35,
	chest: 1,
	stomach: 1,
	arm: .9,
	leg: .85,
	none: 1
};
var ZONES_SNIPER = {
	head: 2.4,
	neck: 2,
	chest: 1.5,
	stomach: 1.2,
	arm: .95,
	leg: .9,
	none: 1
};
var ZONES_SHOTGUN = {
	head: 1.35,
	neck: 1.25,
	chest: 1,
	stomach: 1,
	arm: .95,
	leg: .9,
	none: 1
};
function audio(o) {
	return {
		bodyHz: 78,
		bodyDecay: .16,
		crackHz: 1900,
		crackDecay: .055,
		snap: 1,
		tail: .55,
		mech: .5,
		loudnessDb: 0,
		audibleRange: 220,
		suppressedBody: .55,
		suppressedSnap: .22,
		pitchJitter: .35,
		...o
	};
}
function view(o) {
	return {
		hipPosition: [
			.132,
			-.104,
			-.32
		],
		hipRotationDeg: [
			-1.6,
			3.2,
			1.4
		],
		adsDistance: .185,
		adsOffset: [
			0,
			0,
			0
		],
		sprintPosition: [
			.17,
			-.146,
			-.24
		],
		sprintRotationDeg: [
			-13,
			34,
			22
		],
		lowReadyPosition: [
			.12,
			-.168,
			-.24
		],
		lowReadyRotationDeg: [
			-26,
			8,
			4
		],
		bobScale: 1,
		swayScale: 1,
		adsFovScale: .78,
		scopeZoom: 1,
		...o
	};
}
function handling(o) {
	return {
		adsTime: .26,
		sprintOut: .2,
		sprintIn: .18,
		drawTime: .62,
		holsterTime: .42,
		meleeTime: .72,
		meleeHitAt: .28,
		meleeDamage: 135,
		meleeRange: 1.85,
		moveScale: 1,
		adsMoveScale: .62,
		mass: 3.4,
		semiRefire: .045,
		burstCount: 3,
		burstDelay: .24,
		cycleTime: 0,
		inspectTime: 2.6,
		...o
	};
}
function reload(o) {
	return {
		tactical: 1.95,
		empty: 2.55,
		magOut: .24,
		magIn: .52,
		magSeat: .66,
		boltRelease: .8,
		addAmmoAt: .7,
		...o
	};
}
function ballistics(o) {
	return {
		muzzleVelocity: 880,
		drag: 42e-5,
		gravityScale: 1,
		hitscanRange: 0,
		penetration: 1,
		penetrationDamage: .62,
		ricochet: 1,
		tracerEvery: 4,
		pellets: 1,
		pelletSpreadDeg: 0,
		...o
	};
}
function spread(o) {
	return {
		hip: 2.6,
		ads: .1,
		crouchScale: .82,
		moving: 1.5,
		movingAds: .28,
		jumping: 3.4,
		bloomPerShot: .12,
		bloomMax: 1.5,
		bloomDecay: 4,
		bloomAdsScale: .35,
		firstShotAccurate: true,
		...o
	};
}
function recoil(o) {
	return {
		vertical: [.6],
		horizontal: [0],
		verticalJitter: .08,
		horizontalJitter: .1,
		firstShot: 1.15,
		recoverFraction: .72,
		resetTime: .35,
		adsScale: .78,
		crouchScale: .85,
		viewKickBack: .016,
		viewKickUp: 2.4,
		viewKickRoll: 1.2,
		viewFrequency: 9.5,
		viewDamping: .55,
		shake: .006,
		...o
	};
}
var WEAPONS = [
	{
		id: "ar_vkr7",
		name: "VKR-7",
		short: "VKR-7",
		cls: "assault",
		slot: "primary",
		fireModes: [
			"auto",
			"burst",
			"semi"
		],
		defaultFireMode: "auto",
		rpm: 720,
		magSize: 30,
		startReserve: 210,
		damage: [
			{
				distance: 0,
				damage: 32
			},
			{
				distance: 28,
				damage: 32
			},
			{
				distance: 48,
				damage: 25
			},
			{
				distance: 80,
				damage: 21
			},
			{
				distance: 140,
				damage: 18
			}
		],
		zones: ZONES_RIFLE,
		ballistics: ballistics({
			muzzleVelocity: 905,
			drag: 4e-4,
			penetration: 1.15,
			penetrationDamage: .66,
			tracerEvery: 4
		}),
		recoil: recoil({
			vertical: [
				.98,
				.86,
				.74,
				.62,
				.52,
				.46,
				.42,
				.4,
				.38,
				.36,
				.34
			],
			horizontal: [
				.02,
				-.1,
				.16,
				.26,
				.2,
				-.06,
				-.22,
				-.3,
				-.18,
				.1,
				.24
			],
			verticalJitter: .09,
			horizontalJitter: .11,
			viewKickBack: .018,
			viewKickUp: 2.6,
			viewKickRoll: 1.3,
			shake: .0062
		}),
		spread: spread({
			hip: 2.4,
			ads: .07,
			moving: 1.4,
			bloomPerShot: .1,
			bloomMax: 1.3
		}),
		handling: handling({
			adsTime: .25,
			sprintOut: .19,
			mass: 3.4,
			moveScale: 1
		}),
		reload: reload({
			tactical: 1.92,
			empty: 2.6
		}),
		audio: audio({
			bodyHz: 84,
			crackHz: 2050,
			snap: 1.05,
			loudnessDb: 0,
			mech: .55
		}),
		view: view({
			adsDistance: .205,
			bobScale: 1,
			swayScale: 1,
			hipPosition: [
				.132,
				-.104,
				-.325
			]
		}),
		model: {
			receiver: [
				.048,
				.078,
				.255
			],
			railHeight: .025,
			barrelLength: .395,
			barrelRadius: .0105,
			handguardLength: .27,
			handguardRadius: .0195,
			handguardStyle: "mlok",
			stockStyle: "collapsible",
			magStyle: "stanag",
			magLength: .185,
			magCurve: .1,
			action: "closedBolt",
			bodyMaterial: "phosphate",
			furnitureMaterial: "polymer",
			muzzle: [
				0,
				0,
				-.665
			],
			ejectPort: [
				.026,
				.004,
				-.135
			],
			sightHeight: .038,
			topRail: .53,
			flavour: "ar"
		},
		attachments: ["optic_reddot"],
		slots: [
			"optic",
			"muzzle",
			"underbarrel",
			"magazine",
			"stock",
			"laser"
		]
	},
	{
		id: "smg_hornet",
		name: "Hornet MP",
		short: "HORNET",
		cls: "smg",
		slot: "primary",
		fireModes: ["auto", "semi"],
		defaultFireMode: "auto",
		rpm: 900,
		magSize: 32,
		startReserve: 224,
		damage: [
			{
				distance: 0,
				damage: 28
			},
			{
				distance: 14,
				damage: 28
			},
			{
				distance: 24,
				damage: 21
			},
			{
				distance: 40,
				damage: 16
			},
			{
				distance: 70,
				damage: 13
			}
		],
		zones: ZONES_SMG,
		ballistics: ballistics({
			muzzleVelocity: 400,
			drag: .0015,
			penetration: .42,
			penetrationDamage: .48,
			hitscanRange: 42,
			tracerEvery: 5
		}),
		recoil: recoil({
			vertical: [
				.62,
				.58,
				.54,
				.5,
				.46,
				.44,
				.42,
				.4,
				.38
			],
			horizontal: [
				-.06,
				.14,
				.24,
				.1,
				-.16,
				-.28,
				-.2,
				.06,
				.22
			],
			verticalJitter: .1,
			horizontalJitter: .16,
			adsScale: .8,
			viewKickBack: .013,
			viewKickUp: 2.1,
			viewKickRoll: 1.6,
			shake: .0048,
			resetTime: .3
		}),
		spread: spread({
			hip: 1.9,
			ads: .16,
			moving: .85,
			movingAds: .22,
			jumping: 2.8,
			bloomPerShot: .09,
			bloomMax: 1.5,
			bloomDecay: 5
		}),
		handling: handling({
			adsTime: .19,
			sprintOut: .13,
			sprintIn: .14,
			drawTime: .5,
			holsterTime: .34,
			mass: 2.6,
			moveScale: 1.06,
			adsMoveScale: .72
		}),
		reload: reload({
			tactical: 1.62,
			empty: 2.2,
			magOut: .22,
			magIn: .48,
			magSeat: .62
		}),
		audio: audio({
			bodyHz: 96,
			crackHz: 1650,
			snap: .86,
			tail: .42,
			mech: .62,
			audibleRange: 160
		}),
		view: view({
			adsDistance: .185,
			bobScale: .9,
			swayScale: 1.12,
			hipPosition: [
				.126,
				-.1,
				-.292
			],
			sprintRotationDeg: [
				-15,
				36,
				24
			]
		}),
		model: {
			receiver: [
				.046,
				.074,
				.215
			],
			railHeight: .0235,
			barrelLength: .23,
			barrelRadius: .0095,
			handguardLength: .155,
			handguardRadius: .0185,
			handguardStyle: "rail",
			stockStyle: "skeleton",
			magStyle: "stick",
			magLength: .205,
			magCurve: .03,
			action: "closedBolt",
			bodyMaterial: "polymer",
			furnitureMaterial: "polymer",
			muzzle: [
				0,
				0,
				-.465
			],
			ejectPort: [
				.024,
				.004,
				-.108
			],
			sightHeight: .036,
			topRail: .375,
			flavour: "mp"
		},
		attachments: ["optic_holo"],
		slots: [
			"optic",
			"muzzle",
			"underbarrel",
			"magazine",
			"stock",
			"laser"
		]
	},
	{
		id: "sg_breaker",
		name: "Breaker 12",
		short: "BREAKER",
		cls: "shotgun",
		slot: "primary",
		fireModes: ["semi"],
		defaultFireMode: "semi",
		rpm: 210,
		magSize: 7,
		startReserve: 42,
		damage: [
			{
				distance: 0,
				damage: 17
			},
			{
				distance: 7,
				damage: 15
			},
			{
				distance: 12,
				damage: 8
			},
			{
				distance: 18,
				damage: 3
			},
			{
				distance: 26,
				damage: 1
			}
		],
		zones: ZONES_SHOTGUN,
		ballistics: ballistics({
			muzzleVelocity: 380,
			drag: .0034,
			penetration: .2,
			penetrationDamage: .3,
			hitscanRange: 30,
			pellets: 8,
			pelletSpreadDeg: 3.1,
			tracerEvery: 0
		}),
		recoil: recoil({
			vertical: [
				2.6,
				2.5,
				2.4
			],
			horizontal: [
				.22,
				-.28,
				.34
			],
			verticalJitter: .22,
			horizontalJitter: .24,
			firstShot: 1,
			recoverFraction: .66,
			adsScale: .85,
			viewKickBack: .048,
			viewKickUp: 6.2,
			viewKickRoll: 2.4,
			viewFrequency: 7,
			viewDamping: .62,
			shake: .019,
			resetTime: .6
		}),
		spread: spread({
			hip: .6,
			ads: .35,
			moving: .4,
			movingAds: .2,
			jumping: 1.2,
			bloomPerShot: 0,
			bloomMax: 0,
			firstShotAccurate: false
		}),
		handling: handling({
			adsTime: .3,
			sprintOut: .24,
			drawTime: .7,
			holsterTime: .46,
			mass: 3.9,
			moveScale: .96,
			adsMoveScale: .58,
			semiRefire: .1
		}),
		reload: reload({
			tactical: 0,
			empty: 0,
			perShell: .42,
			shellIn: .34,
			shellOut: .3,
			magOut: 0,
			magIn: 0,
			magSeat: 0,
			boltRelease: 0,
			addAmmoAt: .55
		}),
		audio: audio({
			bodyHz: 58,
			bodyDecay: .3,
			crackHz: 1180,
			crackDecay: .09,
			snap: 1.4,
			tail: .8,
			mech: .8,
			loudnessDb: 3,
			audibleRange: 260
		}),
		view: view({
			adsDistance: .215,
			bobScale: 1.12,
			swayScale: .9,
			hipPosition: [
				.136,
				-.11,
				-.348
			]
		}),
		model: {
			receiver: [
				.05,
				.082,
				.245
			],
			railHeight: .0255,
			barrelLength: .47,
			barrelRadius: .0135,
			handguardLength: .23,
			handguardRadius: .0225,
			handguardStyle: "rail",
			stockStyle: "fixed",
			magStyle: "tube",
			magLength: .43,
			magCurve: 0,
			action: "tube",
			bodyMaterial: "blued",
			furnitureMaterial: "polymer",
			muzzle: [
				0,
				0,
				-.735
			],
			ejectPort: [
				.026,
				.006,
				-.14
			],
			sightHeight: .032,
			topRail: .25,
			flavour: "shotgun"
		},
		attachments: [],
		slots: [
			"optic",
			"muzzle",
			"underbarrel",
			"stock",
			"laser"
		]
	},
	{
		id: "sr_longbow",
		name: "Longbow M700",
		short: "LONGBOW",
		cls: "sniper",
		slot: "primary",
		fireModes: ["semi"],
		defaultFireMode: "semi",
		rpm: 48,
		magSize: 5,
		startReserve: 30,
		damage: [
			{
				distance: 0,
				damage: 96
			},
			{
				distance: 120,
				damage: 96
			},
			{
				distance: 220,
				damage: 82
			},
			{
				distance: 400,
				damage: 70
			}
		],
		zones: ZONES_SNIPER,
		ballistics: ballistics({
			muzzleVelocity: 840,
			drag: 26e-5,
			penetration: 2.6,
			penetrationDamage: .85,
			tracerEvery: 0,
			ricochet: .6
		}),
		recoil: recoil({
			vertical: [4.4],
			horizontal: [.32],
			verticalJitter: .35,
			horizontalJitter: .35,
			firstShot: 1,
			recoverFraction: .55,
			adsScale: .92,
			viewKickBack: .062,
			viewKickUp: 8.5,
			viewKickRoll: 2,
			viewFrequency: 6,
			viewDamping: .66,
			shake: .024,
			resetTime: 1
		}),
		spread: spread({
			hip: 6.5,
			ads: 0,
			moving: 3,
			movingAds: .55,
			jumping: 8,
			bloomPerShot: 0,
			bloomMax: 0,
			firstShotAccurate: true
		}),
		handling: handling({
			adsTime: .42,
			sprintOut: .32,
			sprintIn: .22,
			drawTime: .86,
			holsterTime: .56,
			mass: 5.6,
			moveScale: .9,
			adsMoveScale: .38,
			semiRefire: .02,
			cycleTime: .95,
			meleeTime: .8,
			meleeHitAt: .32
		}),
		reload: reload({
			tactical: 2.85,
			empty: 3.3,
			magOut: .26,
			magIn: .55,
			magSeat: .68,
			boltRelease: .84,
			addAmmoAt: .72
		}),
		audio: audio({
			bodyHz: 62,
			bodyDecay: .42,
			crackHz: 2400,
			crackDecay: .12,
			snap: 1.6,
			tail: 1,
			mech: .9,
			loudnessDb: 6,
			audibleRange: 420
		}),
		view: view({
			adsDistance: .215,
			bobScale: 1.25,
			swayScale: .72,
			hipPosition: [
				.14,
				-.114,
				-.372
			],
			adsFovScale: .55,
			scopeZoom: .34,
			sprintRotationDeg: [
				-12,
				32,
				20
			]
		}),
		model: {
			receiver: [
				.044,
				.072,
				.3
			],
			railHeight: .0245,
			barrelLength: .62,
			barrelRadius: .0135,
			handguardLength: .3,
			handguardRadius: .025,
			handguardStyle: "none",
			stockStyle: "thumbhole",
			magStyle: "box",
			magLength: .095,
			magCurve: 0,
			action: "boltAction",
			bodyMaterial: "blued",
			furnitureMaterial: "polymer",
			muzzle: [
				0,
				0,
				-.94
			],
			ejectPort: [
				.024,
				.006,
				-.17
			],
			sightHeight: .04,
			topRail: .34,
			flavour: "sniper"
		},
		attachments: ["optic_sniper"],
		slots: [
			"optic",
			"muzzle",
			"underbarrel",
			"magazine",
			"stock"
		]
	},
	{
		id: "lmg_vulcan",
		name: "Vulcan-9",
		short: "VULCAN",
		cls: "lmg",
		slot: "primary",
		fireModes: ["auto"],
		defaultFireMode: "auto",
		rpm: 640,
		magSize: 100,
		startReserve: 300,
		damage: [
			{
				distance: 0,
				damage: 33
			},
			{
				distance: 46,
				damage: 33
			},
			{
				distance: 76,
				damage: 27
			},
			{
				distance: 130,
				damage: 22
			},
			{
				distance: 220,
				damage: 19
			}
		],
		zones: ZONES_RIFLE,
		ballistics: ballistics({
			muzzleVelocity: 860,
			drag: 36e-5,
			penetration: 1.9,
			penetrationDamage: .74,
			tracerEvery: 3
		}),
		recoil: recoil({
			vertical: [
				1.1,
				1,
				.92,
				.84,
				.78,
				.72,
				.66,
				.62,
				.58,
				.56,
				.54,
				.52
			],
			horizontal: [
				-.08,
				.18,
				.34,
				.22,
				-.14,
				-.36,
				-.44,
				-.24,
				.12,
				.34,
				.42,
				.2
			],
			verticalJitter: .14,
			horizontalJitter: .2,
			adsScale: .72,
			crouchScale: .72,
			viewKickBack: .024,
			viewKickUp: 3.2,
			viewKickRoll: 1.5,
			viewFrequency: 8,
			viewDamping: .6,
			shake: .0095,
			resetTime: .45
		}),
		spread: spread({
			hip: 4.2,
			ads: .12,
			moving: 2.2,
			movingAds: .44,
			jumping: 6,
			bloomPerShot: .06,
			bloomMax: 1.1,
			bloomDecay: 3.2
		}),
		handling: handling({
			adsTime: .42,
			sprintOut: .36,
			sprintIn: .26,
			drawTime: 1.05,
			holsterTime: .68,
			mass: 8.2,
			moveScale: .84,
			adsMoveScale: .42
		}),
		reload: reload({
			tactical: 4.2,
			empty: 5.1,
			magOut: .22,
			magIn: .52,
			magSeat: .66,
			boltRelease: .86,
			addAmmoAt: .76
		}),
		audio: audio({
			bodyHz: 70,
			bodyDecay: .22,
			crackHz: 1800,
			crackDecay: .07,
			snap: 1.25,
			tail: .75,
			mech: .85,
			loudnessDb: 4,
			audibleRange: 320
		}),
		view: view({
			adsDistance: .215,
			bobScale: 1.35,
			swayScale: .66,
			hipPosition: [
				.146,
				-.12,
				-.362
			],
			sprintPosition: [
				.188,
				-.166,
				-.256
			],
			sprintRotationDeg: [
				-16,
				30,
				26
			]
		}),
		model: {
			receiver: [
				.058,
				.092,
				.33
			],
			railHeight: .03,
			barrelLength: .52,
			barrelRadius: .0135,
			handguardLength: .23,
			handguardRadius: .025,
			handguardStyle: "shroud",
			stockStyle: "fixed",
			magStyle: "drum",
			magLength: .175,
			magCurve: 0,
			action: "beltFed",
			bodyMaterial: "phosphate",
			furnitureMaterial: "polymer",
			muzzle: [
				0,
				0,
				-.89
			],
			ejectPort: [
				.03,
				0,
				-.17
			],
			sightHeight: .048,
			topRail: .32,
			flavour: "lmg"
		},
		attachments: ["optic_reddot", "under_bipod"],
		slots: [
			"optic",
			"muzzle",
			"underbarrel",
			"magazine",
			"stock",
			"laser"
		]
	},
	{
		id: "dmr_kestrel",
		name: "Kestrel MK14",
		short: "KESTREL",
		cls: "marksman",
		slot: "primary",
		fireModes: ["semi"],
		defaultFireMode: "semi",
		rpm: 340,
		magSize: 20,
		startReserve: 120,
		damage: [
			{
				distance: 0,
				damage: 55
			},
			{
				distance: 62,
				damage: 55
			},
			{
				distance: 110,
				damage: 44
			},
			{
				distance: 190,
				damage: 36
			}
		],
		zones: ZONES_SNIPER,
		ballistics: ballistics({
			muzzleVelocity: 850,
			drag: 3e-4,
			penetration: 2,
			penetrationDamage: .8,
			tracerEvery: 6
		}),
		recoil: recoil({
			vertical: [
				1.85,
				1.7,
				1.62,
				1.56,
				1.5
			],
			horizontal: [
				.12,
				-.26,
				.32,
				-.18,
				.24
			],
			verticalJitter: .16,
			horizontalJitter: .2,
			firstShot: 1,
			recoverFraction: .68,
			adsScale: .85,
			viewKickBack: .03,
			viewKickUp: 4.4,
			viewKickRoll: 1.4,
			viewFrequency: 8.5,
			viewDamping: .58,
			shake: .011,
			resetTime: .55
		}),
		spread: spread({
			hip: 3.6,
			ads: .02,
			moving: 2,
			movingAds: .4,
			jumping: 5,
			bloomPerShot: .26,
			bloomMax: 1,
			bloomDecay: 3.4,
			bloomAdsScale: .5
		}),
		handling: handling({
			adsTime: .32,
			sprintOut: .24,
			drawTime: .76,
			holsterTime: .5,
			mass: 4.6,
			moveScale: .94,
			adsMoveScale: .5,
			semiRefire: .02
		}),
		reload: reload({
			tactical: 2.3,
			empty: 2.95
		}),
		audio: audio({
			bodyHz: 68,
			bodyDecay: .3,
			crackHz: 2200,
			crackDecay: .09,
			snap: 1.35,
			tail: .82,
			mech: .7,
			loudnessDb: 4,
			audibleRange: 330
		}),
		view: view({
			adsDistance: .205,
			bobScale: 1.1,
			swayScale: .82,
			hipPosition: [
				.138,
				-.112,
				-.348
			],
			adsFovScale: .66,
			scopeZoom: .62
		}),
		model: {
			receiver: [
				.048,
				.082,
				.29
			],
			railHeight: .0255,
			barrelLength: .5,
			barrelRadius: .0125,
			handguardLength: .315,
			handguardRadius: .02,
			handguardStyle: "rail",
			stockStyle: "fixed",
			magStyle: "curved",
			magLength: .19,
			magCurve: .13,
			action: "closedBolt",
			bodyMaterial: "phosphate",
			furnitureMaterial: "polymerTan",
			muzzle: [
				0,
				0,
				-.82
			],
			ejectPort: [
				.026,
				.004,
				-.15
			],
			sightHeight: .039,
			topRail: .62,
			flavour: "ar"
		},
		attachments: ["optic_acog"],
		slots: [
			"optic",
			"muzzle",
			"underbarrel",
			"magazine",
			"stock",
			"laser"
		]
	},
	{
		id: "pi_sidewinder",
		name: "Sidewinder .45",
		short: "SIDEWINDER",
		cls: "pistol",
		slot: "secondary",
		fireModes: ["semi"],
		defaultFireMode: "semi",
		rpm: 420,
		magSize: 15,
		startReserve: 75,
		damage: [
			{
				distance: 0,
				damage: 26
			},
			{
				distance: 18,
				damage: 26
			},
			{
				distance: 32,
				damage: 19
			},
			{
				distance: 55,
				damage: 15
			}
		],
		zones: ZONES_SMG,
		ballistics: ballistics({
			muzzleVelocity: 320,
			drag: .0018,
			penetration: .3,
			penetrationDamage: .4,
			hitscanRange: 45,
			tracerEvery: 0
		}),
		recoil: recoil({
			vertical: [
				1.35,
				1.25,
				1.18,
				1.12
			],
			horizontal: [
				-.14,
				.22,
				-.26,
				.18
			],
			verticalJitter: .14,
			horizontalJitter: .2,
			recoverFraction: .75,
			adsScale: .82,
			viewKickBack: .02,
			viewKickUp: 4,
			viewKickRoll: 2.4,
			viewFrequency: 12,
			viewDamping: .5,
			shake: .005,
			resetTime: .4
		}),
		spread: spread({
			hip: 1.7,
			ads: .14,
			moving: .8,
			movingAds: .2,
			jumping: 2.4,
			bloomPerShot: .22,
			bloomMax: 1.6,
			bloomDecay: 5.5
		}),
		handling: handling({
			adsTime: .155,
			sprintOut: .1,
			sprintIn: .12,
			drawTime: .38,
			holsterTime: .26,
			mass: 1.1,
			moveScale: 1.12,
			adsMoveScale: .82,
			semiRefire: .02,
			meleeTime: .58,
			meleeHitAt: .22,
			inspectTime: 2.1
		}),
		reload: reload({
			tactical: 1.35,
			empty: 1.95,
			magOut: .2,
			magIn: .46,
			magSeat: .6,
			boltRelease: .78,
			addAmmoAt: .66
		}),
		audio: audio({
			bodyHz: 110,
			bodyDecay: .13,
			crackHz: 1500,
			crackDecay: .05,
			snap: .95,
			tail: .4,
			mech: .7,
			loudnessDb: -1,
			audibleRange: 150
		}),
		view: view({
			adsDistance: .255,
			bobScale: .72,
			swayScale: 1.35,
			hipPosition: [
				.114,
				-.116,
				-.278
			],
			hipRotationDeg: [
				-2.4,
				4,
				1
			],
			sprintPosition: [
				.142,
				-.158,
				-.218
			],
			sprintRotationDeg: [
				-20,
				40,
				18
			],
			adsFovScale: .86
		}),
		model: {
			receiver: [
				.03,
				.055,
				.15
			],
			railHeight: .018,
			barrelLength: .058,
			barrelRadius: .0072,
			handguardLength: 0,
			handguardRadius: 0,
			handguardStyle: "none",
			stockStyle: "none",
			magStyle: "pistol",
			magLength: .092,
			magCurve: 0,
			action: "closedBolt",
			bodyMaterial: "blued",
			furnitureMaterial: "polymer",
			muzzle: [
				0,
				0,
				-.18
			],
			ejectPort: [
				.015,
				.01,
				-.058
			],
			sightHeight: .022,
			topRail: 0,
			flavour: "pistol"
		},
		attachments: [],
		slots: [
			"optic",
			"muzzle",
			"magazine",
			"laser"
		]
	},
	{
		id: "lch_ravager",
		name: "Ravager RPG",
		short: "RAVAGER",
		cls: "launcher",
		slot: "secondary",
		fireModes: ["semi"],
		defaultFireMode: "semi",
		rpm: 30,
		magSize: 1,
		startReserve: 4,
		damage: [
			{
				distance: 0,
				damage: 150
			},
			{
				distance: 6,
				damage: 90
			},
			{
				distance: 10,
				damage: 20
			}
		],
		zones: {
			head: 1,
			neck: 1,
			chest: 1,
			stomach: 1,
			arm: 1,
			leg: 1,
			none: 1
		},
		ballistics: ballistics({
			muzzleVelocity: 90,
			drag: 1e-4,
			gravityScale: .35,
			penetration: .2,
			penetrationDamage: 0,
			tracerEvery: 0,
			ricochet: 0,
			explosive: {
				radius: 8.5,
				damage: 150,
				power: 34,
				kind: "rocket"
			}
		}),
		recoil: recoil({
			vertical: [3.2],
			horizontal: [.5],
			verticalJitter: .4,
			horizontalJitter: .5,
			firstShot: 1,
			recoverFraction: .6,
			adsScale: .9,
			viewKickBack: .055,
			viewKickUp: 6,
			viewKickRoll: 2,
			viewFrequency: 5.5,
			viewDamping: .7,
			shake: .03,
			resetTime: 1.5
		}),
		spread: spread({
			hip: 1.2,
			ads: 0,
			moving: .5,
			movingAds: .1,
			jumping: 2,
			bloomPerShot: 0,
			bloomMax: 0,
			firstShotAccurate: true
		}),
		handling: handling({
			adsTime: .42,
			sprintOut: .34,
			sprintIn: .26,
			drawTime: 1.1,
			holsterTime: .7,
			mass: 7,
			moveScale: .88,
			adsMoveScale: .5,
			semiRefire: .4,
			meleeTime: .86,
			meleeHitAt: .34,
			meleeDamage: 150
		}),
		reload: reload({
			tactical: 3.6,
			empty: 3.6,
			magOut: .16,
			magIn: .58,
			magSeat: .74,
			boltRelease: .86,
			addAmmoAt: .8
		}),
		audio: audio({
			bodyHz: 48,
			bodyDecay: .55,
			crackHz: 900,
			crackDecay: .25,
			snap: 1.2,
			tail: 1,
			mech: .5,
			loudnessDb: 6,
			audibleRange: 400
		}),
		view: view({
			adsDistance: .205,
			bobScale: 1.3,
			swayScale: .7,
			hipPosition: [
				.136,
				-.106,
				-.335
			],
			hipRotationDeg: [
				-2,
				4,
				3
			],
			sprintPosition: [
				.176,
				-.158,
				-.246
			],
			sprintRotationDeg: [
				-14,
				30,
				24
			]
		}),
		model: {
			receiver: [
				.05,
				.098,
				.24
			],
			railHeight: .048,
			barrelLength: .32,
			barrelRadius: .04,
			handguardLength: .18,
			handguardRadius: .0455,
			handguardStyle: "wood",
			stockStyle: "none",
			magStyle: "none",
			magLength: 0,
			magCurve: 0,
			action: "tube",
			bodyMaterial: "phosphate",
			furnitureMaterial: "wood",
			muzzle: [
				0,
				0,
				-.56
			],
			ejectPort: [
				0,
				0,
				.16
			],
			sightHeight: .075,
			topRail: 0,
			flavour: "launcher"
		},
		attachments: [],
		slots: ["optic"]
	}
];
var BY_ID$3 = new Map(WEAPONS.map((w) => [w.id, w]));
function weaponDef(id) {
	const d = BY_ID$3.get(id);
	if (!d) throw new Error(`[weapons] unknown weapon "${id}"`);
	return d;
}
function hasWeapon(id) {
	return BY_ID$3.has(id);
}
/** Damage at a distance, linearly interpolated between authored stops. */
function damageAt(def, distance) {
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
//#endregion
//#region src/session/loadout/data/attachments.ts
/** `m('adsTime', 1.08)` — a multiplicative modifier. */
function m$1(stat, value) {
	return {
		stat,
		mode: "mul",
		value
	};
}
/** A "largest wins" modifier — optic magnification only. */
function max(stat, value) {
	return {
		stat,
		mode: "max",
		value
	};
}
var ALL = "all";
var LONG_GUNS = [
	"assault",
	"smg",
	"lmg",
	"marksman",
	"sniper",
	"shotgun"
];
var OPTICS$1 = [
	{
		id: "optic_irons",
		name: "Iron Sights",
		slot: "optic",
		classes: ALL,
		minRank: 0,
		baseline: true,
		mesh: "optic_irons",
		mods: [],
		pros: ["Nothing to snag"],
		cons: [],
		description: "Factory irons. The baseline every optic is measured against."
	},
	{
		id: "optic_reddot",
		name: "RD-2 Reflex",
		slot: "optic",
		classes: ALL,
		minRank: 3,
		mesh: "optic_reddot",
		mods: [
			m$1("adsTime", 1.03),
			m$1("adsSpread", .92),
			max("magnification", 1)
		],
		pros: ["Clean sight picture"],
		cons: ["Marginally slower ADS"],
		description: "Compact enclosed red dot. Fast, unobtrusive, no magnification."
	},
	{
		id: "optic_holo",
		name: "HS-1 Holographic",
		slot: "optic",
		classes: ALL,
		minRank: 12,
		mesh: "optic_holo",
		mods: [
			m$1("adsTime", 1.05),
			m$1("adsSpread", .9),
			m$1("hipSpread", .97),
			max("magnification", 1)
		],
		pros: ["Widest window", "Tightens hipfire"],
		cons: ["Slower ADS"],
		description: "Wide-window holographic sight. Best peripheral view of any optic."
	},
	{
		id: "optic_acog",
		name: "TA-4 Combat Scope",
		slot: "optic",
		classes: [
			"assault",
			"marksman",
			"lmg",
			"sniper"
		],
		minRank: 18,
		mesh: "optic_acog",
		mods: [
			m$1("adsTime", 1.16),
			m$1("adsSpread", .72),
			m$1("falloffRange", 1.1),
			m$1("moveScale", .98),
			m$1("sway", 1.12),
			m$1("flinch", 1.05),
			max("magnification", 4)
		],
		pros: ["4× magnification", "Extends effective range"],
		cons: [
			"Much slower ADS",
			"More sway",
			"Heavier"
		],
		description: "4× prism scope with an illuminated chevron. Trades handling for reach."
	},
	{
		id: "optic_sniper",
		name: "LR-9 Variable Scope",
		slot: "optic",
		classes: ["sniper", "marksman"],
		minRank: 22,
		mesh: "optic_sniper",
		mods: [
			m$1("adsTime", 1.3),
			m$1("adsSpread", .5),
			m$1("falloffRange", 1.2),
			m$1("moveScale", .96),
			m$1("sway", 1.28),
			m$1("flinch", 1.1),
			max("magnification", 9)
		],
		pros: ["9× magnification", "Best static accuracy"],
		cons: [
			"Glacial ADS",
			"Heavy sway",
			"Punishing flinch"
		],
		description: "9× variable scope. Enormous reach, glacial target acquisition."
	}
];
var MUZZLES$1 = [
	{
		id: "muzzle_none",
		name: "No Muzzle Device",
		slot: "muzzle",
		classes: ALL,
		minRank: 0,
		baseline: true,
		mesh: null,
		mods: [],
		pros: [],
		cons: [],
		description: "Bare crown."
	},
	{
		id: "muzzle_suppressor",
		name: "Suppressor",
		slot: "muzzle",
		classes: ALL,
		minRank: 8,
		mesh: "muzzle_suppressor",
		flags: ["suppressed", "noFlash"],
		mods: [
			m$1("muzzleVelocity", .92),
			m$1("adsTime", 1.08),
			m$1("recoilVertical", .94),
			m$1("falloffRange", .9),
			m$1("sprintOut", 1.06)
		],
		pros: [
			"Off the minimap",
			"No muzzle flash",
			"Slightly softer recoil"
		],
		cons: [
			"Loses range",
			"Loses velocity",
			"Slower ADS and sprint-out"
		],
		description: "Removes the flash and keeps you off the minimap. Costs velocity and reach."
	},
	{
		id: "muzzle_comp",
		name: "Compensator",
		slot: "muzzle",
		classes: ALL,
		minRank: 26,
		mesh: "muzzle_comp",
		flags: ["loud"],
		mods: [
			m$1("recoilVertical", .82),
			m$1("recoilHorizontal", 1.06),
			m$1("adsTime", 1.02)
		],
		pros: ["Kills muzzle climb"],
		cons: ["More horizontal wander", "Very visible flash"],
		description: "Ports gas upward. Flattens the climb, throws a wide flash."
	},
	{
		id: "muzzle_brake",
		name: "Muzzle Brake",
		slot: "muzzle",
		classes: [
			"sniper",
			"marksman",
			"lmg",
			"shotgun"
		],
		minRank: 20,
		mesh: "muzzle_brake",
		flags: ["loud"],
		mods: [
			m$1("recoilVertical", .74),
			m$1("recoilHorizontal", .86),
			m$1("adsTime", 1.06),
			m$1("moveScale", .99)
		],
		pros: ["Best raw recoil control"],
		cons: [
			"Slower ADS",
			"Deafening",
			"Adds weight"
		],
		description: "Redirects gas sideways. Tames heavy calibres at the cost of noise."
	},
	{
		id: "muzzle_flash",
		name: "Flash Hider",
		slot: "muzzle",
		classes: ALL,
		minRank: 5,
		mesh: "muzzle_flash",
		flags: ["noFlash"],
		mods: [m$1("recoilVertical", .96), m$1("sprintOut", 1.02)],
		pros: ["Hides your position when firing"],
		cons: ["Slightly slower sprint-out"],
		description: "Breaks up the flash signature without the weight of a can."
	}
];
var BARRELS = [
	{
		id: "barrel_stock",
		name: "Standard Barrel",
		slot: "barrel",
		classes: ALL,
		minRank: 0,
		baseline: true,
		mesh: null,
		mods: [],
		pros: [],
		cons: [],
		description: "The barrel the weapon shipped with."
	},
	{
		id: "barrel_long",
		name: "Extended Barrel",
		slot: "barrel",
		classes: LONG_GUNS,
		minRank: 16,
		mesh: null,
		mods: [
			m$1("falloffRange", 1.18),
			m$1("muzzleVelocity", 1.12),
			m$1("penetration", 1.08),
			m$1("adsTime", 1.1),
			m$1("moveScale", .97),
			m$1("sway", 1.15),
			m$1("sprintOut", 1.05)
		],
		pros: [
			"Big range gain",
			"Faster bullets",
			"Better wall pierce"
		],
		cons: [
			"Slower ADS",
			"Slower movement",
			"More sway"
		],
		description: "A longer tube buys reach and velocity. You feel every centimetre of it."
	},
	{
		id: "barrel_short",
		name: "Short Barrel",
		slot: "barrel",
		classes: LONG_GUNS,
		minRank: 11,
		mesh: null,
		mods: [
			m$1("adsTime", .9),
			m$1("moveScale", 1.02),
			m$1("sprintOut", .92),
			m$1("hipSpread", .95),
			m$1("falloffRange", .86),
			m$1("muzzleVelocity", .93),
			m$1("recoilVertical", 1.08)
		],
		pros: ["Fastest handling barrel", "Tighter hipfire"],
		cons: [
			"Range falls off early",
			"Slower bullets",
			"More climb"
		],
		description: "Chopped and crowned. Everything close-range gets better, everything past 25 m gets worse."
	},
	{
		id: "barrel_heavy",
		name: "Heavy Barrel",
		slot: "barrel",
		classes: LONG_GUNS,
		minRank: 30,
		mesh: null,
		mods: [
			m$1("recoilVertical", .88),
			m$1("recoilHorizontal", .9),
			m$1("sway", .88),
			m$1("adsSpread", .92),
			m$1("adsTime", 1.09),
			m$1("moveScale", .96),
			m$1("sprintOut", 1.06)
		],
		pros: ["Steady in the shoulder", "Tighter aimed cone"],
		cons: ["Heavy", "Slower ADS and sprint-out"],
		description: "Thick profile that soaks up harmonics. Rock steady, and you carry the weight."
	},
	{
		id: "barrel_ported",
		name: "Ported Barrel",
		slot: "barrel",
		classes: [
			"assault",
			"smg",
			"lmg"
		],
		minRank: 36,
		mesh: null,
		flags: ["loud"],
		mods: [
			m$1("recoilVertical", .86),
			m$1("bloomPerShot", .88),
			m$1("muzzleVelocity", .95),
			m$1("falloffRange", .94),
			m$1("adsTime", 1.03)
		],
		pros: ["Flattens sustained fire", "Less bloom"],
		cons: ["Bleeds velocity and range", "Loud"],
		description: "Gas ports cut into the top of the barrel. Sprays flatten out; the round pays for it."
	}
];
var UNDERBARREL$1 = [
	{
		id: "under_none",
		name: "No Underbarrel",
		slot: "underbarrel",
		classes: ALL,
		minRank: 0,
		baseline: true,
		mesh: null,
		mods: [],
		pros: [],
		cons: [],
		description: "Bare handguard."
	},
	{
		id: "under_grip",
		name: "Vertical Grip",
		slot: "underbarrel",
		classes: ALL,
		minRank: 6,
		mesh: "under_grip",
		mods: [
			m$1("recoilVertical", .86),
			m$1("adsTime", 1.04),
			m$1("hipSpread", 1.02)
		],
		pros: ["Straightforward vertical control"],
		cons: ["Slower ADS", "Slightly wider hipfire"],
		description: "Straight foregrip. Vertical recoil control, slightly slower into the shoulder."
	},
	{
		id: "under_angled",
		name: "Angled Grip",
		slot: "underbarrel",
		classes: ALL,
		minRank: 14,
		mesh: "under_angled",
		mods: [
			m$1("recoilHorizontal", .8),
			m$1("adsTime", .95),
			m$1("sprintOut", .94),
			m$1("recoilVertical", 1.05)
		],
		pros: ["Faster into the shoulder", "Kills horizontal wander"],
		cons: ["Slightly more climb"],
		description: "Canted grip. Speed and lateral control, at the price of vertical."
	},
	{
		id: "under_bipod",
		name: "Folding Bipod",
		slot: "underbarrel",
		classes: [
			"lmg",
			"sniper",
			"marksman"
		],
		minRank: 24,
		mesh: "under_bipod",
		flags: ["bipod"],
		mods: [
			m$1("recoilVertical", .9),
			m$1("recoilHorizontal", .92),
			m$1("moveScale", .97),
			m$1("adsTime", 1.05)
		],
		pros: ["Huge stability when deployed"],
		cons: ["Dead weight when moving"],
		description: "Deployable legs. Enormous stability when static, dead weight when not."
	}
];
var LASERS$1 = [{
	id: "laser_none",
	name: "No Laser",
	slot: "laser",
	classes: ALL,
	minRank: 0,
	baseline: true,
	mesh: null,
	mods: [],
	pros: [],
	cons: [],
	description: "Nothing on the side rail."
}, {
	id: "laser_visible",
	name: "Tactical Laser",
	slot: "laser",
	classes: ALL,
	minRank: 34,
	mesh: "laser_visible",
	flags: ["laser", "laserVisible"],
	mods: [
		m$1("hipSpread", .62),
		m$1("sprintOut", .9),
		m$1("bloomPerShot", .94)
	],
	pros: ["Transforms hipfire", "Faster sprint-out"],
	cons: ["The beam shows enemies exactly where you are"],
	description: "Tightens hip fire dramatically. The beam gives your position away."
}];
var MAGAZINES$1 = [
	{
		id: "mag_standard",
		name: "Standard Mag",
		slot: "magazine",
		classes: ALL,
		minRank: 0,
		baseline: true,
		mesh: null,
		mods: [],
		pros: [],
		cons: [],
		description: "Issue magazine."
	},
	{
		id: "mag_extended",
		name: "Extended Mag",
		slot: "magazine",
		classes: ALL,
		minRank: 15,
		mesh: "mag_extended",
		mods: [
			m$1("magSize", 1.5),
			m$1("reloadTime", 1.12),
			m$1("adsTime", 1.02),
			m$1("moveScale", .99)
		],
		pros: ["+50% capacity"],
		cons: ["Slower reload", "Slightly slower handling"],
		description: "Fifty percent more rounds, and you feel the weight on every reload."
	},
	{
		id: "mag_quick",
		name: "Quickdraw Mag",
		slot: "magazine",
		classes: ALL,
		minRank: 9,
		mesh: "mag_quick",
		mods: [
			m$1("reloadTime", .78),
			m$1("drawTime", .94),
			m$1("magSize", .9)
		],
		pros: ["Far faster reloads", "Faster draw"],
		cons: ["Holds fewer rounds"],
		description: "Tapered well and a grip tab. You get the gun back much faster with a little less in it."
	},
	{
		id: "mag_drum",
		name: "Drum Mag",
		slot: "magazine",
		classes: [
			"assault",
			"smg",
			"lmg"
		],
		minRank: 28,
		mesh: "mag_drum",
		mods: [
			m$1("magSize", 2),
			m$1("reloadTime", 1.45),
			m$1("moveScale", .94),
			m$1("adsTime", 1.1),
			m$1("sway", 1.2)
		],
		pros: ["Double capacity", "Never stop firing"],
		cons: [
			"Ruins mobility",
			"Very slow reload",
			"Swings badly"
		],
		description: "Doubles capacity. Ruins mobility and reload speed."
	},
	{
		id: "mag_ap",
		name: "AP Rounds",
		slot: "magazine",
		classes: ALL,
		minRank: 40,
		mesh: null,
		mods: [
			m$1("penetration", 1.45),
			m$1("muzzleVelocity", 1.06),
			m$1("damage", .96),
			m$1("falloffRange", .95)
		],
		pros: ["Shoots through cover", "Faster bullets"],
		cons: ["Slightly less damage on flesh", "Marginally shorter range"],
		description: "Hardened core. Defeats walls that stop everything else, at a small cost on soft targets."
	}
];
var STOCKS$1 = [
	{
		id: "stock_standard",
		name: "Standard Stock",
		slot: "stock",
		classes: ALL,
		minRank: 0,
		baseline: true,
		mesh: null,
		mods: [],
		pros: [],
		cons: [],
		description: "Issue stock."
	},
	{
		id: "stock_light",
		name: "Skeleton Stock",
		slot: "stock",
		classes: ALL,
		minRank: 7,
		mesh: "stock_light",
		mods: [
			m$1("adsTime", .88),
			m$1("sprintOut", .86),
			m$1("moveScale", 1.03),
			m$1("recoilVertical", 1.14),
			m$1("sway", 1.1)
		],
		pros: ["Faster everything"],
		cons: ["Noticeably more climb", "More sway"],
		description: "Stripped stock. Faster everything, worse recoil."
	},
	{
		id: "stock_heavy",
		name: "Precision Stock",
		slot: "stock",
		classes: ALL,
		minRank: 21,
		mesh: "stock_heavy",
		mods: [
			m$1("recoilVertical", .8),
			m$1("recoilHorizontal", .86),
			m$1("sway", .85),
			m$1("recoilRecovery", 1.1),
			m$1("adsTime", 1.1),
			m$1("moveScale", .97),
			m$1("sprintOut", 1.06)
		],
		pros: ["Best recoil control in the slot", "Steady hold"],
		cons: ["Slow to swing", "Slower ADS"],
		description: "Weighted cheek riser and recoil pad. Rock steady, slow to swing."
	},
	{
		id: "stock_none",
		name: "No Stock",
		slot: "stock",
		classes: [
			"smg",
			"assault",
			"shotgun"
		],
		minRank: 32,
		mesh: "stock_none",
		mods: [
			m$1("adsTime", .8),
			m$1("sprintOut", .7),
			m$1("moveScale", 1.05),
			m$1("hipSpread", .9),
			m$1("recoilVertical", 1.35),
			m$1("recoilHorizontal", 1.2),
			m$1("sway", 1.3),
			m$1("adsSpread", 1.1)
		],
		pros: ["Best mobility in the game", "Tighter hipfire"],
		cons: ["Recoil becomes a real problem", "Aimed cone opens up"],
		description: "Removed entirely. Sprint-out and movement are best in class; hold the trigger at your peril."
	}
];
var ATTACHMENT_TABLE = [
	...OPTICS$1,
	...MUZZLES$1,
	...BARRELS,
	...UNDERBARREL$1,
	...LASERS$1,
	...MAGAZINES$1,
	...STOCKS$1
];
var BY_ID$2 = new Map(ATTACHMENT_TABLE.map((a) => [a.id, a]));
function attachmentEntry(id) {
	return BY_ID$2.get(id) ?? null;
}
/** Every attachment a weapon class may mount, optionally filtered to one slot. */
function attachmentsFor(cls, slot) {
	return ATTACHMENT_TABLE.filter((a) => {
		if (slot && a.slot !== slot) return false;
		return a.classes === "all" || a.classes.includes(cls);
	});
}
/** True when the entry does not count against the attachment limit. */
function isBaseline(a) {
	return a.baseline === true;
}
/**
* Proves the "nothing is free" rule over the whole table: every non-baseline
* attachment must pay for its upside with a stat that moves the wrong way or a
* drawback flag. Returns the offenders — empty means the table is honest.
*/
function auditAttachments(side, flagSide) {
	const issues = [];
	for (const a of ATTACHMENT_TABLE) {
		if (a.baseline) continue;
		let pros = 0;
		let cons = 0;
		for (const mod of a.mods) {
			if (mod.mode !== "mul") continue;
			const better = side(mod.stat);
			const good = better === "lower" ? mod.value < 1 : mod.value > 1;
			const bad = better === "lower" ? mod.value > 1 : mod.value < 1;
			if (good) pros++;
			if (bad) cons++;
		}
		for (const f of a.flags ?? []) if (flagSide(f) === "pro") pros++;
		else cons++;
		if (pros === 0) issues.push({
			id: a.id,
			problem: "no upside at all"
		});
		if (cons === 0) issues.push({
			id: a.id,
			problem: "no drawback — free upgrade"
		});
		if (a.pros.length === 0 && pros > 0) issues.push({
			id: a.id,
			problem: "undocumented upside"
		});
		if (a.cons.length === 0 && cons > 0) issues.push({
			id: a.id,
			problem: "undocumented drawback"
		});
	}
	return issues;
}
/** Applies the `attachments` half of a tuning patch in place. */
function applyAttachmentTuning(patch) {
	const notes = [];
	if (!patch.attachments) return notes;
	for (const id of Object.keys(patch.attachments)) {
		const entry = BY_ID$2.get(id);
		const over = patch.attachments[id];
		if (!entry || !over) continue;
		const mods = entry.mods;
		for (const stat of Object.keys(over)) {
			const value = over[stat];
			if (typeof value !== "number" || !Number.isFinite(value)) continue;
			const existing = mods.find((x) => x.stat === stat && x.mode === "mul");
			if (existing) existing.value = value;
			else mods.push(m$1(stat, value));
			notes.push(`attachment ${id}.${stat} = ${value}`);
		}
	}
	return notes;
}
//#endregion
//#region src/session/loadout/data/perks.ts
function m(stat, value) {
	return {
		stat,
		mode: "mul",
		value
	};
}
var PERK_TABLE = [
	{
		id: "perk_double_time",
		name: "Double Time",
		row: 1,
		minRank: 0,
		group: "sprint",
		mods: [m("moveScale", 1.05), m("sprintOut", .95)],
		description: "Longer tactical sprint and a quicker recovery out of it."
	},
	{
		id: "perk_scavenger",
		name: "Scavenger",
		row: 1,
		minRank: 4,
		group: "ammo",
		mods: [m("reserveAmmo", 1.15)],
		flags: ["scavenger"],
		description: "Resupply from fallen players. Start with a deeper reserve."
	},
	{
		id: "perk_bandolier",
		name: "Bandolier",
		row: 1,
		minRank: 7,
		group: "ammo",
		mods: [m("reserveAmmo", 1.5), m("moveScale", .99)],
		description: "Half again the reserve ammunition, and the weight to go with it."
	},
	{
		id: "perk_overkill",
		name: "Overkill",
		row: 1,
		minRank: 42,
		mods: [],
		flags: ["overkill"],
		description: "Carry a second primary weapon instead of a sidearm."
	},
	{
		id: "perk_ghost",
		name: "Ghost",
		row: 2,
		minRank: 10,
		mods: [],
		flags: ["ghost"],
		description: "Undetectable by UAVs and radar sweeps while moving."
	},
	{
		id: "perk_hardline",
		name: "Hardline",
		row: 2,
		minRank: 18,
		mods: [],
		flags: ["hardline"],
		description: "Killstreaks cost one kill less."
	},
	{
		id: "perk_sleight",
		name: "Sleight of Hand",
		row: 2,
		minRank: 13,
		group: "reload",
		mods: [m("reloadTime", .75)],
		description: "Reload substantially faster."
	},
	{
		id: "perk_stalker",
		name: "Stalker",
		row: 2,
		minRank: 28,
		mods: [m("adsMoveScale", 1.35)],
		description: "Move much faster while aiming down sights."
	},
	{
		id: "perk_marksman",
		name: "Marksman",
		row: 3,
		minRank: 16,
		mods: [m("sway", .7), m("flinch", .65)],
		description: "Steadier hold and far less flinch when taking fire."
	},
	{
		id: "perk_fasthands",
		name: "Fast Hands",
		row: 3,
		minRank: 25,
		group: "reload",
		mods: [
			m("reloadTime", .85),
			m("drawTime", .8),
			m("holsterTime", .75)
		],
		description: "Swap weapons and reload noticeably faster."
	},
	{
		id: "perk_lightweight",
		name: "Lightweight",
		row: 3,
		minRank: 30,
		group: "sprint",
		mods: [m("moveScale", 1.06), m("sprintOut", .9)],
		description: "Move faster on foot at the cost of nothing but the slot."
	},
	{
		id: "perk_tacmask",
		name: "Tac Mask",
		row: 3,
		minRank: 55,
		mods: [],
		flags: ["tacMask"],
		description: "Greatly reduced effect from flash and stun."
	}
];
var BY_ID$1 = new Map(PERK_TABLE.map((p) => [p.id, p]));
function perkDef(id) {
	return BY_ID$1.get(id) ?? null;
}
function perksInRow(row) {
	return PERK_TABLE.filter((p) => p.row === row);
}
/** Ids that cannot be run alongside `id` because they share an exclusivity group. */
function perkConflicts(id) {
	const def = BY_ID$1.get(id);
	if (!def || !def.group) return [];
	return PERK_TABLE.filter((p) => p.id !== id && p.group === def.group).map((p) => p.id);
}
/** Applies the `perks` half of a tuning patch in place. */
function applyPerkTuning(patch) {
	const notes = [];
	if (!patch.perks) return notes;
	for (const id of Object.keys(patch.perks)) {
		const def = BY_ID$1.get(id);
		const over = patch.perks[id];
		if (!def || !over) continue;
		const mods = def.mods;
		for (const stat of Object.keys(over)) {
			const value = over[stat];
			if (typeof value !== "number" || !Number.isFinite(value)) continue;
			const existing = mods.find((x) => x.stat === stat && x.mode === "mul");
			if (existing) existing.value = value;
			else mods.push(m(stat, value));
			notes.push(`perk ${id}.${stat} = ${value}`);
		}
	}
	return notes;
}
//#endregion
//#region src/session/loadout/Effective.ts
/**
* Resolution: weapon + attachments + perks → `EffectiveWeaponStats`.
*
* This is the object the rest of the game reads. Nothing downstream should ever
* look at an attachment id again:
*
* ```ts
* import { resolveWeapon, toResolvedStats } from '@/session/loadout';
*
* const eff = resolveWeapon('ar_vkr7', ['optic_holo', 'muzzle_comp', 'stock_light']);
* eff.adsTime      // 0.243  (base 0.26)
* eff.magSize      // 30
* eff.damage       // falloff stops with distances already scaled
* weapons.applyEffective(toResolvedStats(eff));   // one-line adoption
* ```
*
* Determinism is a hard requirement: the same inputs in any order give the same
* output, because the algebra in `Modifiers.ts` sums deviations rather than
* multiplying them in list order. `tools/session-loadout.mjs` proves it by
* shuffling every combination with a seeded RNG.
*/
var SLOT_ORDER = new Map(LOADOUT_SLOTS.map((s, i) => [s, i]));
/**
* Resolves attachment ids against a weapon: drops unknown ids, ids the class
* cannot mount, baseline ("none") entries and duplicate slots, then sorts into
* canonical slot order so the result is independent of input order.
*/
function resolveAttachments(def, ids) {
	const fitted = [];
	const used = /* @__PURE__ */ new Set();
	const warnings = [];
	const seen = /* @__PURE__ */ new Set();
	for (const id of ids) {
		if (typeof id !== "string" || id.length === 0) continue;
		if (seen.has(id)) {
			warnings.push(`duplicate attachment "${id}"`);
			continue;
		}
		seen.add(id);
		const entry = attachmentEntry(id);
		if (!entry) {
			warnings.push(`unknown attachment "${id}"`);
			continue;
		}
		if (isBaseline(entry)) continue;
		if (!mountable(def, entry)) {
			warnings.push(`"${id}" does not fit a ${def.cls}`);
			continue;
		}
		if (used.has(entry.slot)) {
			warnings.push(`slot "${entry.slot}" already filled, dropped "${id}"`);
			continue;
		}
		used.add(entry.slot);
		fitted.push(entry);
	}
	fitted.sort((a, b) => (SLOT_ORDER.get(a.slot) ?? 99) - (SLOT_ORDER.get(b.slot) ?? 99));
	return {
		fitted,
		warnings
	};
}
/**
* Whether a weapon can take an attachment.
*
* The weapon module's `WeaponDef.slots` is the source of truth for the slots it
* models; `barrel` is a loadout-layer slot every long gun and pistol accepts
* until the mesh builder grows one.
*/
function mountable(def, entry) {
	if (entry.classes !== "all" && !entry.classes.includes(def.cls)) return false;
	if (entry.slot === "barrel") return def.cls !== "launcher";
	return def.slots.includes(entry.slot);
}
/** Slots this weapon can actually use, in canonical order. */
function slotsFor(def) {
	const out = [];
	for (const slot of LOADOUT_SLOTS) {
		if (slot === "barrel") {
			if (def.cls !== "launcher") out.push(slot);
			continue;
		}
		if (def.slots.includes(slot)) out.push(slot);
	}
	return out;
}
/**
* Folds a weapon's base numbers with everything fitted to it.
*
* `weapon` may be an id or a `WeaponDef`. An unknown id is not an exception —
* the host must survive a hostile client — it resolves the default weapon and
* records a warning.
*/
function resolveWeapon(weapon, attachmentIds = [], options = {}) {
	const warnings = [];
	let def;
	if (typeof weapon === "string") if (!hasWeapon(weapon)) {
		warnings.push(`unknown weapon "${weapon}" — resolved as ar_vkr7`);
		def = weaponDef("ar_vkr7");
	} else def = weaponDef(weapon);
	else def = weapon;
	const { fitted, warnings: attachWarnings } = resolveAttachments(def, attachmentIds);
	warnings.push(...attachWarnings);
	const stack = new ModifierStack();
	for (const a of fitted) stack.add(a.id, a.mods, a.flags);
	for (const id of options.perks ?? []) {
		const p = perkDef(id);
		if (!p) {
			warnings.push(`unknown perk "${id}"`);
			continue;
		}
		stack.add(p.id, p.mods, p.flags);
	}
	for (const e of options.extra ?? []) stack.add(e.id, e.mods, e.flags);
	const capped = [];
	const fold = (stat, base) => {
		const f = stack.fold(stat, base);
		if (f.capped) capped.push(stat);
		return f.value;
	};
	/**
	* Reload timings are railed in seconds, not in multiples — see
	* `RELOAD_RAILS`. A weapon with no such reload (base 0) stays at 0.
	*/
	const reloadSeconds = (base, scale, rail) => {
		if (!(base > 0)) return 0;
		const v = base * scale;
		if (v > rail.max) {
			capped.push("reloadTime");
			return rail.max;
		}
		if (v < rail.min) {
			capped.push("reloadTime");
			return rail.min;
		}
		return v;
	};
	const h = def.handling;
	const r = def.recoil;
	const s = def.spread;
	const recoilVerticalScale = fold("recoilVertical", 1);
	const recoilHorizontalScale = fold("recoilHorizontal", 1);
	const falloffScale = fold("falloffRange", 1);
	const damageScale = fold("damage", 1);
	const reloadScale = fold("reloadTime", 1);
	const damage = def.damage.map((stop) => ({
		distance: round(stop.distance * falloffScale, 3),
		damage: round(stop.damage * damageScale, 3)
	}));
	const flags = stack.flags;
	return {
		weaponId: def.id,
		weaponName: def.name,
		cls: def.cls,
		attachments: fitted.map((a) => a.id),
		meshAttachments: fitted.map((a) => a.mesh).filter((x) => typeof x === "string"),
		adsTime: round(fold("adsTime", h.adsTime), 4),
		sprintOut: round(fold("sprintOut", h.sprintOut), 4),
		drawTime: round(fold("drawTime", h.drawTime), 4),
		holsterTime: round(fold("holsterTime", h.holsterTime), 4),
		reloadTactical: round(reloadSeconds(def.reload.tactical, reloadScale, RELOAD_RAILS.tactical), 4),
		reloadEmpty: round(reloadSeconds(def.reload.empty, reloadScale, RELOAD_RAILS.empty), 4),
		shellReload: def.reload.tactical <= 0 && (def.reload.perShell ?? 0) > 0,
		reloadPerShell: round(reloadSeconds(def.reload.perShell ?? 0, reloadScale, RELOAD_RAILS.perShell), 4),
		reloadShellIn: round((def.reload.shellIn ?? 0) * reloadScale, 4),
		reloadShellOut: round((def.reload.shellOut ?? 0) * reloadScale, 4),
		reloadScale: round(reloadScale, 4),
		moveScale: round(fold("moveScale", h.moveScale), 4),
		adsMoveScale: round(fold("adsMoveScale", h.adsMoveScale), 4),
		swayScale: round(fold("sway", def.view.swayScale), 4),
		flinchScale: round(fold("flinch", 1), 4),
		recoilVerticalScale: round(recoilVerticalScale, 4),
		recoilHorizontalScale: round(recoilHorizontalScale, 4),
		recoilFirstShotScale: round(fold("recoilFirstShot", 1), 4),
		recoilRecoverFraction: round(fold("recoilRecovery", r.recoverFraction), 4),
		patternVertical: r.vertical.map((v) => round(v * recoilVerticalScale, 4)),
		patternHorizontal: r.horizontal.map((v) => round(v * recoilHorizontalScale, 4)),
		hipSpreadDeg: round(fold("hipSpread", s.hip), 4),
		adsSpreadDeg: round(fold("adsSpread", s.ads), 4),
		bloomPerShotDeg: round(fold("bloomPerShot", s.bloomPerShot), 4),
		bloomMaxDeg: round(s.bloomMax, 4),
		bloomDecayDegPerSec: round(fold("bloomDecay", s.bloomDecay), 4),
		rpm: round(fold("fireRate", def.rpm), 2),
		magSize: fold("magSize", def.magSize),
		reserve: fold("reserveAmmo", def.startReserve),
		muzzleVelocity: round(fold("muzzleVelocity", def.ballistics.muzzleVelocity), 2),
		penetration: round(fold("penetration", def.ballistics.penetration), 4),
		damage,
		falloffScale: round(falloffScale, 4),
		damageScale: round(damageScale, 4),
		magnification: round(fold("magnification", 1), 3),
		suppressed: stack.has("suppressed"),
		laser: stack.has("laser"),
		flags,
		capped: [...new Set(capped)].sort(),
		warnings
	};
}
/** Damage at a distance from an already-resolved weapon. */
function effectiveDamageAt(eff, distance) {
	const c = eff.damage;
	if (c.length === 0) return 0;
	if (distance <= c[0].distance) return c[0].damage;
	for (let i = 1; i < c.length; i++) {
		const a = c[i - 1];
		const b = c[i];
		if (distance <= b.distance) {
			const t = (distance - a.distance) / Math.max(1e-4, b.distance - a.distance);
			return a.damage + (b.damage - a.damage) * t;
		}
	}
	return c[c.length - 1].damage;
}
/** Shots to kill at a distance — the only balance number players actually feel. */
function effectiveShotsToKill(eff, distance, zone = "chest", health = 100) {
	const def = hasWeapon(eff.weaponId) ? weaponDef(eff.weaponId) : null;
	const zoneMul = def ? def.zones[zone] : zone === "head" ? 1.5 : 1;
	const pellets = def ? Math.max(1, def.ballistics.pellets) : 1;
	const dmg = effectiveDamageAt(eff, distance) * zoneMul * pellets;
	return Math.max(1, Math.ceil(health / Math.max(.001, dmg)));
}
/**
* Bridges to the weapon module's own `ResolvedStats`, so `WeaponSystem` can
* consume a loadout-resolved gun without changing a single call site:
*
* ```ts
* // in WeaponSystem.give()
* const stats = loadout ? toResolvedStats(loadout) : resolveStats(def, attachments);
* ```
*
* Everything `ResolvedStats` carries is present in `EffectiveWeaponStats`; the
* scales it wants relative to base are recovered by dividing out the base.
*/
function toResolvedStats(eff) {
	const def = hasWeapon(eff.weaponId) ? weaponDef(eff.weaponId) : weaponDef("ar_vkr7");
	const safe = (a, b) => b > 1e-6 ? a / b : 1;
	return {
		adsTime: eff.adsTime,
		sprintOut: eff.sprintOut,
		drawTime: eff.drawTime,
		recoilScale: eff.recoilVerticalScale,
		recoilHorizontalScale: eff.recoilHorizontalScale,
		hipSpreadScale: safe(eff.hipSpreadDeg, def.spread.hip),
		adsSpreadScale: safe(eff.adsSpreadDeg, def.spread.ads),
		bloomScale: safe(eff.bloomPerShotDeg, def.spread.bloomPerShot),
		moveScale: eff.moveScale,
		adsMoveScale: eff.adsMoveScale,
		magSize: eff.magSize,
		reloadScale: eff.reloadScale,
		muzzleVelocity: eff.muzzleVelocity,
		penetration: eff.penetration,
		rangeScale: eff.falloffScale,
		suppressed: eff.suppressed,
		magnification: eff.magnification,
		laser: eff.laser
	};
}
/**
* Normalised 0..1 bars for the create-a-class screen.
*
* The ranges are absolute across the whole armoury, not per weapon, so a pistol
* genuinely reads as short-ranged next to an LMG. `src/ui/menus/LoadoutMenu.ts`
* already draws exactly this shape (`LoadoutStats`) — wiring it up is assigning
* the result of this function to its `stats` field.
*/
function statBars(eff) {
	const closeDamage = effectiveDamageAt(eff, 0);
	const lastStop = eff.damage.length ? eff.damage[eff.damage.length - 1].distance : 30;
	const patternMean = eff.patternVertical.length ? eff.patternVertical.reduce((a, b) => a + Math.abs(b), 0) / eff.patternVertical.length : .5;
	return {
		damage: norm(closeDamage * Math.max(1, pelletsOf(eff)), 12, 110),
		accuracy: norm(eff.adsSpreadDeg, .55, .02),
		range: norm(lastStop, 12, 110),
		fireRate: norm(eff.rpm, 40, 950),
		mobility: clamp01(.5 * norm(eff.moveScale, .75, 1.12) + .5 * norm(eff.adsTime, .75, .15)),
		control: clamp01(.6 * norm(patternMean, 1.6, .18) + .4 * norm(eff.swayScale, 1.8, .6))
	};
}
function pelletsOf(eff) {
	return hasWeapon(eff.weaponId) ? Math.max(1, weaponDef(eff.weaponId).ballistics.pellets) : 1;
}
/** Maps `v` from [lo,hi] to [0,1]; `lo > hi` inverts, which is how "lower is better" reads. */
function norm(v, lo, hi) {
	if (Math.abs(hi - lo) < 1e-9) return 0;
	return clamp01((v - lo) / (hi - lo));
}
function clamp01(v) {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}
function round(v, digits) {
	const p = Math.pow(10, digits);
	return Math.round(v * p) / p;
}
//#endregion
//#region src/session/loadout/data/equipment.ts
var LETHALS = [
	{
		id: "eq_frag",
		name: "Frag Grenade",
		kind: "lethal",
		minRank: 0,
		count: 1,
		grenade: "frag",
		description: "Cookable fragmentation grenade. Bounces, so learn the geometry."
	},
	{
		id: "eq_semtex",
		name: "Semtex",
		kind: "lethal",
		minRank: 6,
		count: 1,
		grenade: null,
		fallback: "frag",
		description: "Sticks where it lands. No cook, no roll, no second chance."
	},
	{
		id: "eq_thermite",
		name: "Thermite",
		kind: "lethal",
		minRank: 17,
		count: 1,
		grenade: null,
		fallback: "frag",
		description: "Burns through anything it touches over several seconds."
	},
	{
		id: "eq_claymore",
		name: "Claymore",
		kind: "lethal",
		minRank: 23,
		count: 2,
		grenade: null,
		fallback: "frag",
		description: "Directional proximity mine. Covers the flank you cannot watch."
	},
	{
		id: "eq_knife",
		name: "Throwing Knife",
		kind: "lethal",
		minRank: 35,
		count: 1,
		grenade: null,
		fallback: "frag",
		description: "Silent, lethal, recoverable. One chance per throw."
	}
];
var TACTICALS = [
	{
		id: "eq_flash",
		name: "Flashbang",
		kind: "tactical",
		minRank: 0,
		count: 2,
		grenade: "flash",
		description: "Blinds and deafens through the blast cone. The entry tool."
	},
	{
		id: "eq_smoke",
		name: "Smoke Screen",
		kind: "tactical",
		minRank: 3,
		count: 1,
		grenade: "smoke",
		description: "Dense screen that breaks sightlines for twenty seconds."
	},
	{
		id: "eq_stun",
		name: "Stun Grenade",
		kind: "tactical",
		minRank: 9,
		count: 2,
		grenade: null,
		fallback: "flash",
		description: "Slows movement and turn speed rather than blinding."
	},
	{
		id: "eq_snapshot",
		name: "Snapshot Grenade",
		kind: "tactical",
		minRank: 27,
		count: 1,
		grenade: null,
		fallback: "flash",
		description: "Paints a momentary silhouette of everyone in the blast."
	},
	{
		id: "eq_decoy",
		name: "Decoy Grenade",
		kind: "tactical",
		minRank: 19,
		count: 2,
		grenade: null,
		fallback: "smoke",
		description: "Fake gunfire and radar pings for eight seconds."
	}
];
var FIELD_UPGRADES = [
	{
		id: "fu_deadsilence",
		name: "Dead Silence",
		minRank: 0,
		chargeSeconds: 180,
		uses: 1,
		description: "Footsteps go silent for a short window. Refreshes on a kill."
	},
	{
		id: "fu_trophy",
		name: "Trophy System",
		minRank: 8,
		chargeSeconds: 140,
		uses: 1,
		description: "Destroys up to three pieces of incoming equipment or projectiles."
	},
	{
		id: "fu_munitions",
		name: "Munitions Box",
		minRank: 14,
		chargeSeconds: 165,
		uses: 1,
		description: "Resupplies ammunition and equipment for you and your squad."
	},
	{
		id: "fu_recon_drone",
		name: "Recon Drone",
		minRank: 21,
		chargeSeconds: 190,
		uses: 1,
		description: "Pilotable drone that marks every enemy it can see."
	},
	{
		id: "fu_cover",
		name: "Deployable Cover",
		minRank: 12,
		chargeSeconds: 120,
		uses: 1,
		description: "Ballistic shield that creates a firing position anywhere."
	},
	{
		id: "fu_insertion",
		name: "Tactical Insertion",
		minRank: 26,
		chargeSeconds: 150,
		uses: 1,
		description: "Marks your next respawn point."
	}
];
/** Mirrors `KILLSTREAK_DEFS` in `src/game/Killstreaks.ts`. */
var KILLSTREAK_OPTIONS = [
	{
		id: "uav",
		name: "UAV Recon",
		cost: 3,
		minRank: 6
	},
	{
		id: "counteruav",
		name: "Counter-UAV",
		cost: 4,
		minRank: 16
	},
	{
		id: "carepackage",
		name: "Care Package",
		cost: 5,
		minRank: 11
	},
	{
		id: "airstrike",
		name: "Precision Airstrike",
		cost: 7,
		minRank: 24
	},
	{
		id: "sentry",
		name: "Sentry Turret",
		cost: 9,
		minRank: 32
	}
];
var LETHAL_BY_ID = new Map(LETHALS.map((e) => [e.id, e]));
var TACTICAL_BY_ID = new Map(TACTICALS.map((e) => [e.id, e]));
var FU_BY_ID = new Map(FIELD_UPGRADES.map((e) => [e.id, e]));
var KS_BY_ID = new Map(KILLSTREAK_OPTIONS.map((e) => [e.id, e]));
function lethalDef(id) {
	return LETHAL_BY_ID.get(id) ?? null;
}
function tacticalDef(id) {
	return TACTICAL_BY_ID.get(id) ?? null;
}
function fieldUpgradeDef(id) {
	return FU_BY_ID.get(id) ?? null;
}
function killstreakOption(id) {
	return KS_BY_ID.get(id) ?? null;
}
/**
* The grenade kind the game should actually spawn for a piece of equipment,
* honouring the fallback for anything not implemented yet.
*/
function grenadeKindFor(def) {
	return def.grenade ?? def.fallback ?? (def.kind === "lethal" ? "frag" : "flash");
}
//#endregion
//#region src/session/loadout/data/weapons.ts
/**
* Weapon meta the loadout layer owns: unlock rank and the one-line role the
* armoury prints under the name.
*
* The *stats* stay where they belong — `src/weapons/Catalog.ts` — and this
* table is keyed by the ids in it. `assertWeaponMetaCoverage()` fails loudly if
* the catalogue grows a weapon nobody gave a rank to, so a new gun cannot
* silently ship as either locked forever or free at rank 1.
*/
var WEAPON_META = {
	ar_vkr7: {
		minRank: 0,
		role: "Balanced 5.56 platform. The measuring stick."
	},
	pi_sidewinder: {
		minRank: 0,
		role: "Fast-handling sidearm. Never the wrong answer up close."
	},
	smg_hornet: {
		minRank: 2,
		role: "Highest cyclic rate in the armoury. Owns the first ten metres."
	},
	sg_breaker: {
		minRank: 5,
		role: "Pump twelve-gauge. One-shot inside seven metres."
	},
	dmr_kestrel: {
		minRank: 9,
		role: "Semi-auto marksman rifle. Two-shot to sixty metres."
	},
	lmg_vulcan: {
		minRank: 14,
		role: "Belt-fed suppression. A hundred rounds of area denial."
	},
	sr_longbow: {
		minRank: 20,
		role: "Bolt-action .338. Upper-chest one-shot at any range."
	},
	lch_ravager: {
		minRank: 30,
		role: "Single-shot launcher. Anti-vehicle, anti-killstreak."
	}
};
var DEFAULT_META = {
	minRank: 0,
	role: ""
};
function weaponMeta(id) {
	return WEAPON_META[id] ?? DEFAULT_META;
}
function weaponMinRank(id) {
	return weaponMeta(id).minRank;
}
/** Catalogue ids with no meta entry. Empty is the only acceptable answer. */
function assertWeaponMetaCoverage() {
	return WEAPONS.filter((w) => !WEAPON_META[w.id]).map((w) => w.id);
}
//#endregion
//#region src/session/loadout/Validate.ts
/**
* The trust boundary.
*
* A loadout arrives from a client. That client may be a stock build, a modified
* build, or a script that has never run the game. `validateLoadout` therefore
* takes `unknown` — not `Loadout` — and is written so that *every* path returns
* a loadout the host is willing to run:
*
*   - Structurally broken input (not an object, arrays where records belong,
*     `NaN`, absurd string lengths, prototype keys) → default class.
*   - Individually illegal elements (locked content, over the attachment limit,
*     two perks from the same exclusivity group, a primary in the secondary
*     slot) → that element is dropped or replaced, everything else survives.
*
* `ok === false` means the request was not honoured verbatim. The host should
* still *run* `result.loadout` — the repaired one — and send the errors back so
* the client can show the player what was refused. Silently running a different
* gun than the one on screen is worse than refusing.
*
* Nothing here mutates the input, and nothing reads a key off the input object
* that it does not explicitly ask for, so a `__proto__`-laden payload cannot
* leak into the result.
*/
var DEFAULT_PRIMARY = "ar_vkr7";
var DEFAULT_SECONDARY = "pi_sidewinder";
var DEFAULT_LETHAL = "eq_frag";
var DEFAULT_TACTICAL = "eq_flash";
var DEFAULT_FIELD_UPGRADE = "fu_deadsilence";
/** Ids are content keys, not free text: strict charset, strict length. */
var ID_RE = /^[a-z0-9_]{2,48}$/;
function defaultLoadout(name = "CLASS 1", id = "class-1") {
	return {
		version: 1,
		id,
		name,
		primary: {
			weaponId: DEFAULT_PRIMARY,
			attachments: []
		},
		secondary: {
			weaponId: DEFAULT_SECONDARY,
			attachments: []
		},
		lethal: DEFAULT_LETHAL,
		tactical: DEFAULT_TACTICAL,
		perks: [
			"perk_double_time",
			"",
			""
		],
		fieldUpgrade: DEFAULT_FIELD_UPGRADE,
		killstreaks: [
			"uav",
			"carepackage",
			"airstrike"
		]
	};
}
/** Deep structural copy. Used everywhere a loadout crosses an ownership line. */
function cloneLoadout(l) {
	return {
		version: 1,
		id: l.id,
		name: l.name,
		primary: {
			weaponId: l.primary.weaponId,
			attachments: [...l.primary.attachments]
		},
		secondary: {
			weaponId: l.secondary.weaponId,
			attachments: [...l.secondary.attachments]
		},
		lethal: l.lethal,
		tactical: l.tactical,
		perks: [
			l.perks[0],
			l.perks[1],
			l.perks[2]
		],
		fieldUpgrade: l.fieldUpgrade,
		killstreaks: [...l.killstreaks]
	};
}
/** Byte-stable comparison — cheap enough to gate a network send on. */
function loadoutsEqual(a, b) {
	return serialiseLoadout(a) === serialiseLoadout(b);
}
/** Canonical serialisation: key order is fixed, so equal loadouts hash equal. */
function serialiseLoadout(l) {
	return JSON.stringify([
		l.version,
		l.id,
		l.name,
		l.primary.weaponId,
		[...l.primary.attachments].sort(),
		l.secondary.weaponId,
		[...l.secondary.attachments].sort(),
		l.lethal,
		l.tactical,
		l.perks,
		l.fieldUpgrade,
		[...l.killstreaks].sort()
	]);
}
function validateLoadout(input, ctx = {}) {
	const limits = {
		...LIMITS,
		...ctx.limits ?? {}
	};
	const errors = [];
	const repairs = [];
	const fail = (code, path, message, id) => {
		errors.push(id === void 0 ? {
			code,
			path,
			message
		} : {
			code,
			path,
			message,
			id
		});
	};
	const src = isRecord(input) ? input : null;
	if (!src) {
		fail("malformed", "", "loadout must be an object");
		return {
			ok: false,
			loadout: defaultLoadout(),
			errors,
			repairs: ["replaced with the default class"]
		};
	}
	const out = defaultLoadout();
	const rawId = src["id"];
	if (typeof rawId === "string" && rawId.length > 0 && rawId.length <= 64) out.id = rawId;
	else if (rawId !== void 0) repairs.push("class id replaced");
	const rawName = src["name"];
	if (typeof rawName === "string") {
		const clean = sanitiseName(rawName, limits.nameMaxLength);
		if (clean.length === 0) {
			fail("name_invalid", "name", "class name is empty after sanitising");
			repairs.push("name replaced with the default");
		} else {
			if (clean !== rawName) repairs.push("name sanitised");
			out.name = clean;
		}
	} else if (rawName !== void 0) fail("name_invalid", "name", "class name must be a string");
	const rawVersion = src["version"];
	if (rawVersion !== void 0 && rawVersion !== 1) {
		fail("malformed", "version", `unsupported loadout version ${String(rawVersion)}`);
		repairs.push("version forced to 1");
	}
	const rawPerks = Array.isArray(src["perks"]) ? src["perks"] : null;
	if (src["perks"] !== void 0 && !rawPerks) fail("malformed", "perks", "perks must be an array");
	const perks = [
		"",
		"",
		""
	];
	const groupsUsed = /* @__PURE__ */ new Map();
	const perkIdsSeen = /* @__PURE__ */ new Set();
	for (let i = 0; i < 3; i++) {
		const row = i + 1;
		const raw = rawPerks ? rawPerks[i] : void 0;
		if (raw === void 0 || raw === null || raw === "") continue;
		if (typeof raw !== "string" || !ID_RE.test(raw)) {
			fail("perk_unknown", `perks[${i}]`, "perk id must be a content id string");
			continue;
		}
		const def = perkDef(raw);
		if (!def) {
			fail("perk_unknown", `perks[${i}]`, `unknown perk "${raw}"`, raw);
			continue;
		}
		if (def.row !== row) {
			fail("perk_row", `perks[${i}]`, `"${raw}" is a row-${def.row} perk, offered in row ${row}`, raw);
			continue;
		}
		if (perkIdsSeen.has(raw)) {
			fail("perk_duplicate", `perks[${i}]`, `"${raw}" equipped twice`, raw);
			continue;
		}
		if (def.group) {
			const owner = groupsUsed.get(def.group);
			if (owner) {
				fail("perk_conflict", `perks[${i}]`, `"${raw}" conflicts with "${owner}" (both "${def.group}")`, raw);
				continue;
			}
		}
		if (isLocked(raw, def.minRank, ctx)) {
			fail("locked", `perks[${i}]`, `"${raw}" unlocks at rank ${def.minRank}`, raw);
			continue;
		}
		perkIdsSeen.add(raw);
		if (def.group) groupsUsed.set(def.group, raw);
		perks[i] = raw;
	}
	if (rawPerks) {
		out.perks = perks;
		if (rawPerks.length > 3) fail("malformed", "perks", "at most three perks, one per row");
	}
	const overkill = perks.some((p) => perkDef(p)?.flags?.includes("overkill"));
	out.primary = readWeapon(src["primary"], "primary", "primary", limits, ctx, fail, repairs, false);
	out.secondary = readWeapon(src["secondary"], "secondary", "secondary", limits, ctx, fail, repairs, overkill);
	if (out.primary.weaponId === out.secondary.weaponId) {
		fail("duplicate_weapon", "secondary.weaponId", `"${out.secondary.weaponId}" cannot fill both slots`, out.secondary.weaponId);
		out.secondary = {
			weaponId: DEFAULT_SECONDARY,
			attachments: []
		};
		repairs.push("secondary replaced with the default sidearm");
	}
	out.lethal = readEquipment(src["lethal"], "lethal", ctx, fail, repairs);
	out.tactical = readEquipment(src["tactical"], "tactical", ctx, fail, repairs);
	const rawFu = src["fieldUpgrade"];
	if (typeof rawFu === "string" && ID_RE.test(rawFu)) {
		const def = fieldUpgradeDef(rawFu);
		if (!def) {
			fail("field_upgrade_unknown", "fieldUpgrade", `unknown field upgrade "${rawFu}"`, rawFu);
			repairs.push("field upgrade replaced with the default");
		} else if (isLocked(rawFu, def.minRank, ctx)) {
			fail("locked", "fieldUpgrade", `"${rawFu}" unlocks at rank ${def.minRank}`, rawFu);
			repairs.push("field upgrade replaced with the default");
		} else out.fieldUpgrade = rawFu;
	} else if (rawFu !== void 0) fail("field_upgrade_unknown", "fieldUpgrade", "field upgrade must be a content id string");
	const rawKs = src["killstreaks"];
	if (Array.isArray(rawKs)) {
		const picked = [];
		const seen = /* @__PURE__ */ new Set();
		for (let i = 0; i < rawKs.length; i++) {
			const id = rawKs[i];
			if (typeof id !== "string" || !ID_RE.test(id)) {
				fail("killstreak_unknown", `killstreaks[${i}]`, "killstreak id must be a content id string");
				continue;
			}
			const def = killstreakOption(id);
			if (!def) {
				fail("killstreak_unknown", `killstreaks[${i}]`, `unknown killstreak "${id}"`, id);
				continue;
			}
			if (seen.has(id)) {
				fail("killstreak_duplicate", `killstreaks[${i}]`, `"${id}" selected twice`, id);
				continue;
			}
			if (isLocked(id, def.minRank, ctx)) {
				fail("locked", `killstreaks[${i}]`, `"${id}" unlocks at rank ${def.minRank}`, id);
				continue;
			}
			if (picked.length >= limits.killstreaks) {
				fail("killstreak_limit", `killstreaks[${i}]`, `at most ${limits.killstreaks} killstreaks, dropped "${id}"`, id);
				continue;
			}
			seen.add(id);
			picked.push(id);
		}
		picked.sort((a, b) => (killstreakOption(a)?.cost ?? 0) - (killstreakOption(b)?.cost ?? 0));
		out.killstreaks = picked;
	} else if (rawKs !== void 0) fail("malformed", "killstreaks", "killstreaks must be an array");
	return {
		ok: errors.length === 0,
		loadout: out,
		errors,
		repairs
	};
}
/**
* Repairs without complaining — the client-side call. Use this to keep a menu's
* state legal as the player edits it; use `validateLoadout` on the host.
*/
function repairLoadout(input, ctx = {}) {
	return validateLoadout(input, ctx).loadout;
}
function readWeapon(raw, path, slot, limits, ctx, fail, repairs, allowPrimaryInSecondary) {
	const fallback = slot === "primary" ? DEFAULT_PRIMARY : DEFAULT_SECONDARY;
	if (!isRecord(raw)) {
		if (raw !== void 0) fail("malformed", path, `${path} must be an object`);
		return {
			weaponId: fallback,
			attachments: []
		};
	}
	let weaponId = fallback;
	const rawId = raw["weaponId"];
	if (typeof rawId !== "string" || !ID_RE.test(rawId) || !hasWeapon(rawId)) {
		fail("unknown_weapon", `${path}.weaponId`, `unknown weapon "${String(rawId)}"`, typeof rawId === "string" ? rawId : void 0);
		repairs.push(`${path} replaced with ${fallback}`);
	} else {
		const def = weaponDef(rawId);
		if (!(def.slot === slot || slot === "secondary" && allowPrimaryInSecondary && def.slot === "primary")) {
			fail("slot_mismatch", `${path}.weaponId`, `"${rawId}" is a ${def.slot} weapon${slot === "secondary" ? " — Overkill is required to carry it here" : ""}`, rawId);
			repairs.push(`${path} replaced with ${fallback}`);
		} else if (isLocked(rawId, weaponMinRank(rawId), ctx)) {
			fail("locked", `${path}.weaponId`, `"${rawId}" unlocks at rank ${weaponMinRank(rawId)}`, rawId);
			repairs.push(`${path} replaced with ${fallback}`);
		} else weaponId = rawId;
	}
	const def = weaponDef(weaponId);
	const attachments = [];
	const usedSlots = /* @__PURE__ */ new Map();
	const seen = /* @__PURE__ */ new Set();
	const rawList = raw["attachments"];
	if (Array.isArray(rawList)) for (let i = 0; i < rawList.length; i++) {
		const id = rawList[i];
		const at = `${path}.attachments[${i}]`;
		if (typeof id !== "string" || !ID_RE.test(id)) {
			fail("attachment_unknown", at, "attachment id must be a content id string");
			continue;
		}
		const entry = attachmentEntry(id);
		if (!entry) {
			fail("attachment_unknown", at, `unknown attachment "${id}"`, id);
			continue;
		}
		if (seen.has(id)) {
			fail("attachment_duplicate", at, `"${id}" fitted twice`, id);
			continue;
		}
		seen.add(id);
		if (isBaseline(entry)) continue;
		if (!mountable(def, entry)) {
			fail("attachment_incompatible", at, `"${id}" cannot be fitted to a ${def.cls} (${weaponId})`, id);
			continue;
		}
		const owner = usedSlots.get(entry.slot);
		if (owner) {
			fail("attachment_slot_conflict", at, `slot "${entry.slot}" already holds "${owner}"`, id);
			continue;
		}
		const clash = (entry.conflicts ?? []).find((c) => attachments.includes(c));
		if (clash) {
			fail("attachment_conflict", at, `"${id}" conflicts with "${clash}"`, id);
			continue;
		}
		if (isLocked(id, entry.minRank, ctx)) {
			fail("locked", at, `"${id}" unlocks at rank ${entry.minRank}`, id);
			continue;
		}
		if (attachments.length >= limits.attachmentsPerWeapon) {
			fail("attachment_limit", at, `at most ${limits.attachmentsPerWeapon} attachments, dropped "${id}"`, id);
			continue;
		}
		usedSlots.set(entry.slot, id);
		attachments.push(id);
	}
	else if (rawList !== void 0) fail("malformed", `${path}.attachments`, "attachments must be an array");
	return {
		weaponId,
		attachments
	};
}
function readEquipment(raw, kind, ctx, fail, repairs) {
	const fallback = kind === "lethal" ? DEFAULT_LETHAL : DEFAULT_TACTICAL;
	if (raw === void 0) return fallback;
	if (typeof raw !== "string" || !ID_RE.test(raw)) {
		fail("equipment_unknown", kind, `${kind} must be a content id string`);
		return fallback;
	}
	const def = kind === "lethal" ? lethalDef(raw) : tacticalDef(raw);
	if (!def) {
		fail("equipment_unknown", kind, `unknown ${kind} "${raw}"`, raw);
		repairs.push(`${kind} replaced with the default`);
		return fallback;
	}
	if (isLocked(raw, def.minRank, ctx)) {
		fail("locked", kind, `"${raw}" unlocks at rank ${def.minRank}`, raw);
		repairs.push(`${kind} replaced with the default`);
		return fallback;
	}
	return raw;
}
/** The rank gate. Explicit grants (challenges, care packages) bypass it. */
function isLocked(id, minRank, ctx) {
	if (ctx.enforceUnlocks === false) return false;
	const u = ctx.unlocks;
	if (!u) return false;
	if (u.isUnlocked && u.isUnlocked(id)) return false;
	return u.rank < minRank;
}
/**
* Class names are shown in the HUD, the scoreboard and the killfeed, so they are
* treated as hostile: control characters stripped, markup characters removed,
* length capped, whitespace collapsed.
*/
function sanitiseName(raw, maxLength) {
	let out = "";
	for (const ch of raw) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 32 || code >= 127 && code <= 159) continue;
		if (code >= 8203 && code <= 8207) continue;
		if (code >= 8234 && code <= 8238) continue;
		if (code === 8232 || code === 8233) continue;
		if (ch === "<" || ch === ">" || ch === "&") continue;
		out += ch;
	}
	return out.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
function isRecord(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Everything the armoury can offer, for building menus without a data import. */
function contentIndex() {
	return {
		lethals: LETHALS,
		tacticals: TACTICALS,
		fieldUpgrades: FIELD_UPGRADES,
		killstreaks: KILLSTREAK_OPTIONS
	};
}
//#endregion
//#region src/session/loadout/data/presets.ts
function cls(id, name, primary, secondary, lethal, tactical, perks, fieldUpgrade, killstreaks) {
	return {
		version: 1,
		id,
		name,
		primary: {
			weaponId: primary[0],
			attachments: primary[1]
		},
		secondary: {
			weaponId: secondary[0],
			attachments: secondary[1]
		},
		lethal,
		tactical,
		perks,
		fieldUpgrade,
		killstreaks
	};
}
var PRESET_CLASSES = [
	cls("preset-rifleman", "RIFLEMAN", ["ar_vkr7", [
		"optic_reddot",
		"muzzle_flash",
		"under_grip",
		"mag_extended",
		"stock_heavy"
	]], ["pi_sidewinder", ["laser_visible"]], "eq_frag", "eq_flash", [
		"perk_double_time",
		"perk_sleight",
		"perk_marksman"
	], "fu_deadsilence", [
		"uav",
		"carepackage",
		"airstrike"
	]),
	cls("preset-assaulter", "ASSAULTER", ["smg_hornet", [
		"optic_holo",
		"barrel_short",
		"laser_visible",
		"mag_quick",
		"stock_none"
	]], ["pi_sidewinder", []], "eq_semtex", "eq_stun", [
		"perk_double_time",
		"perk_stalker",
		"perk_lightweight"
	], "fu_deadsilence", [
		"uav",
		"counteruav",
		"carepackage"
	]),
	cls("preset-marksman", "MARKSMAN", ["dmr_kestrel", [
		"optic_acog",
		"barrel_long",
		"muzzle_suppressor",
		"under_bipod",
		"stock_heavy"
	]], ["pi_sidewinder", ["mag_quick"]], "eq_claymore", "eq_smoke", [
		"perk_scavenger",
		"perk_ghost",
		"perk_marksman"
	], "fu_trophy", [
		"uav",
		"airstrike",
		"sentry"
	]),
	cls("preset-breacher", "BREACHER", ["sg_breaker", [
		"optic_reddot",
		"barrel_short",
		"laser_visible",
		"stock_none"
	]], ["pi_sidewinder", ["laser_visible"]], "eq_thermite", "eq_flash", [
		"perk_double_time",
		"perk_stalker",
		"perk_fasthands"
	], "fu_cover", [
		"uav",
		"carepackage",
		"sentry"
	]),
	cls("preset-gunner", "GUNNER", ["lmg_vulcan", [
		"optic_acog",
		"muzzle_brake",
		"under_bipod",
		"mag_drum",
		"barrel_heavy"
	]], ["pi_sidewinder", []], "eq_frag", "eq_decoy", [
		"perk_bandolier",
		"perk_hardline",
		"perk_marksman"
	], "fu_munitions", [
		"uav",
		"counteruav",
		"sentry"
	])
];
//#endregion
//#region src/session/loadout/Classes.ts
/**
* `LoadoutBook` — the saved custom classes and the editing API behind them.
*
* This is the *client's* model. It is deliberately allowed to hold a loadout the
* host has not seen: the player edits here, and `Service.ts` is what asks the
* authority to actually run it. Every mutation repairs itself against the same
* validator the host uses, so the menu can never get into a state that the host
* will later refuse — the edit simply does not take, and the caller gets the
* errors to show.
*
* Persistence is a `localStorage`-shaped interface, injected, defaulting to real
* `localStorage` when there is one and to memory when there is not (node tools,
* private mode, dedicated servers).
*
* ## What the UI should render
*
* `src/ui/menus/LoadoutMenu.ts` owns the screen; this owns the data. The screen
* needs, per class: the name, both weapons with their fitted attachments, the
* three perk rows, lethal / tactical / field upgrade / killstreaks, and — for
* the bars — `statBars(book.effective(i).primary)`. Every setter returns the
* validation result so the UI can flash the row red and print the message.
*/
var STORAGE_KEY = "blackout.loadouts.v1";
var LoadoutBook = class {
	classes = [];
	selectedIndex = 0;
	storage;
	key;
	ctx;
	listeners = /* @__PURE__ */ new Set();
	/** Bumped on every mutation — cheap dirty check for the UI and the netcode. */
	revision = 0;
	constructor(opts = {}) {
		this.storage = opts.storage !== void 0 ? opts.storage : defaultStorage();
		this.key = opts.storageKey ?? STORAGE_KEY;
		this.ctx = opts.context ?? {};
		this.resetToPresets();
	}
	/** Swap the unlock context (rank up mid-session) and re-validate everything. */
	setContext(ctx) {
		this.ctx = ctx;
		this.classes = this.classes.map((l) => validateLoadout(l, this.ctx).loadout);
		this.emit("edited");
	}
	get context() {
		return this.ctx;
	}
	get count() {
		return this.classes.length;
	}
	get selected() {
		return this.selectedIndex;
	}
	list() {
		return this.classes;
	}
	at(index) {
		return this.classes[index] ?? null;
	}
	current() {
		return this.classes[this.selectedIndex] ?? defaultLoadout();
	}
	/** Resolved stats for a class — what the bars and the weapon system read. */
	effective(index = this.selectedIndex) {
		const l = this.classes[index] ?? defaultLoadout();
		const perks = l.perks.filter((p) => p.length > 0);
		return {
			loadout: l,
			primary: resolveWeapon(l.primary.weaponId, l.primary.attachments, { perks }),
			secondary: resolveWeapon(l.secondary.weaponId, l.secondary.attachments, { perks })
		};
	}
	/** Slots the given class's weapon exposes, for drawing the attachment rail. */
	slots(index = this.selectedIndex, which = "primary") {
		const l = this.classes[index];
		if (!l) return [];
		const id = which === "primary" ? l.primary.weaponId : l.secondary.weaponId;
		return hasWeapon(id) ? slotsFor(weaponDef(id)) : [];
	}
	resetToPresets() {
		this.classes = PRESET_CLASSES.map((p) => validateLoadout(cloneLoadout(p), this.ctx).loadout);
		this.selectedIndex = 0;
		this.emit("reset");
	}
	/** Reads the store. Corrupt or absent data yields the presets, never a throw. */
	load() {
		if (!this.storage) return false;
		let raw = null;
		try {
			raw = this.storage.getItem(this.key);
		} catch {
			return false;
		}
		if (!raw) return false;
		try {
			const data = JSON.parse(raw);
			if (!data || typeof data !== "object") return false;
			const rec = data;
			if (!Array.isArray(rec.classes) || rec.classes.length === 0) return false;
			const limit = this.limit();
			this.classes = rec.classes.slice(0, limit).map((c) => validateLoadout(c, this.ctx).loadout);
			const sel = typeof rec.selected === "number" ? Math.floor(rec.selected) : 0;
			this.selectedIndex = Math.max(0, Math.min(this.classes.length - 1, sel));
			this.emit("loaded");
			return true;
		} catch {
			return false;
		}
	}
	save() {
		if (!this.storage) return;
		try {
			this.storage.setItem(this.key, JSON.stringify({
				version: 1,
				selected: this.selectedIndex,
				classes: this.classes
			}));
		} catch {}
	}
	limit() {
		return this.ctx.limits?.savedClasses ?? LIMITS.savedClasses;
	}
	/** Adds a class. Returns its index, or −1 when the book is full. */
	create(name) {
		if (this.classes.length >= this.limit()) return -1;
		const n = this.classes.length + 1;
		const l = defaultLoadout(name ?? `CUSTOM ${n}`, `custom-${n}-${this.revision}`);
		this.classes.push(validateLoadout(l, this.ctx).loadout);
		this.emit("created");
		return this.classes.length - 1;
	}
	duplicate(index) {
		const src = this.classes[index];
		if (!src || this.classes.length >= this.limit()) return -1;
		const copy = cloneLoadout(src);
		copy.id = `${src.id}-copy-${this.revision}`;
		copy.name = `${src.name} B`.slice(0, LIMITS.nameMaxLength);
		this.classes.push(copy);
		this.emit("duplicated");
		return this.classes.length - 1;
	}
	remove(index) {
		if (this.classes.length <= 1 || !this.classes[index]) return false;
		this.classes.splice(index, 1);
		if (this.selectedIndex >= this.classes.length) this.selectedIndex = this.classes.length - 1;
		this.emit("removed");
		return true;
	}
	rename(index, name) {
		return this.edit(index, (l) => {
			l.name = name;
		}, "renamed");
	}
	select(index) {
		if (!this.classes[index]) return false;
		this.selectedIndex = index;
		this.emit("selected");
		return true;
	}
	/** Replaces a class wholesale — used when the host hands back a repaired one. */
	replace(index, loadout) {
		const res = validateLoadout(loadout, this.ctx);
		if (this.classes[index]) this.classes[index] = res.loadout;
		this.emit("edited");
		return res;
	}
	/**
	* Fits (or, with `null`, removes) an attachment.
	*
	* Fitting into an occupied slot swaps — that is what the player means when
	* they click a second optic, and making them un-equip first is the kind of
	* friction that makes a menu feel cheap.
	*/
	setAttachment(index, which, slot, attachmentId) {
		return this.edit(index, (l) => {
			const spec = which === "primary" ? l.primary : l.secondary;
			spec.attachments = spec.attachments.filter((id) => attachmentEntry(id)?.slot !== slot);
			if (attachmentId) spec.attachments.push(attachmentId);
		}, "edited");
	}
	/** Swaps a weapon and drops any attachment the new weapon cannot mount. */
	setWeapon(index, which, weaponId) {
		return this.edit(index, (l) => {
			const spec = which === "primary" ? l.primary : l.secondary;
			spec.weaponId = weaponId;
			if (hasWeapon(weaponId)) {
				const def = weaponDef(weaponId);
				const legal = new Set(slotsFor(def));
				spec.attachments = spec.attachments.filter((id) => {
					const e = attachmentEntry(id);
					if (!e || !legal.has(e.slot)) return false;
					return e.classes === "all" || e.classes.includes(def.cls);
				});
			}
		}, "edited");
	}
	setPerk(index, row, perkId) {
		return this.edit(index, (l) => {
			l.perks[row - 1] = perkId;
		}, "edited");
	}
	setLethal(index, id) {
		return this.edit(index, (l) => {
			l.lethal = id;
		}, "edited");
	}
	setTactical(index, id) {
		return this.edit(index, (l) => {
			l.tactical = id;
		}, "edited");
	}
	setFieldUpgrade(index, id) {
		return this.edit(index, (l) => {
			l.fieldUpgrade = id;
		}, "edited");
	}
	setKillstreaks(index, ids) {
		return this.edit(index, (l) => {
			l.killstreaks = [...ids];
		}, "edited");
	}
	/**
	* Applies a mutation to a copy, validates it, and keeps it only if the result
	* is legal *or* repairable. The stored class is always the repaired one, so
	* the book cannot hold something the host would refuse.
	*/
	edit(index, mutate, change) {
		const src = this.classes[index];
		if (!src) return {
			ok: false,
			loadout: defaultLoadout(),
			repairs: [],
			errors: [{
				code: "malformed",
				path: "",
				message: `no class at index ${index}`
			}]
		};
		const draft = cloneLoadout(src);
		mutate(draft);
		const res = validateLoadout(draft, this.ctx);
		const before = serialiseLoadout(src);
		this.classes[index] = res.loadout;
		if (serialiseLoadout(res.loadout) !== before) this.emit(change);
		return res;
	}
	/** Subscribe to mutations. Returns the unsubscribe function. */
	onChange(fn) {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}
	emit(change) {
		this.revision++;
		for (const fn of this.listeners) try {
			fn(change, this);
		} catch (err) {
			console.error("[loadout] listener threw", err);
		}
	}
};
/** In-memory storage — the default outside a browser. */
var MemoryStorage = class {
	map = /* @__PURE__ */ new Map();
	getItem(key) {
		return this.map.get(key) ?? null;
	}
	setItem(key, value) {
		this.map.set(key, value);
	}
	removeItem(key) {
		this.map.delete(key);
	}
};
function defaultStorage() {
	try {
		const s = globalThis.localStorage;
		if (s) {
			s.setItem("blackout.loadout.probe", "1");
			s.removeItem("blackout.loadout.probe");
			return s;
		}
	} catch {}
	return new MemoryStorage();
}
//#endregion
//#region src/session/loadout/Service.ts
/**
* `LoadoutService` — the authority-aware half.
*
* The rule the whole file is built around: **the host decides, clients request
* and display.** A client never resolves a loadout into gameplay numbers and
* applies them; it sends the ids, the host validates them, and what comes back
* is what everyone runs. That is the only arrangement that survives a modified
* client, and it is also the arrangement that makes killcam and replay honest,
* since the resolved stats are a pure function of the granted ids.
*
* ```
*   client                       authority (host)
*   ------                       ----------------
*   book.setAttachment(...)
*   service.request(id, loadout) ──► validateLoadout(untrusted)
*                                    ├─ ok      → grant, effective stats cached
*                                    └─ illegal → repair, grant the repair + errors
*   grant ◄──────────────────────────┘
*   UI shows the granted build
* ```
*
* ## The netcode seam
*
* `src/net/` does not exist as a contract yet, so this module codes against
* `LoadoutAuthority` (in `types.ts`) and ships `LocalAuthority`, which validates
* in-process. When the netcode layer lands it needs to provide two things and
* nothing else:
*
*   1. a `LoadoutAuthority` whose `request()` serialises the `Loadout` (it is
*      plain JSON by construction) to the host and resolves with the host's
*      `LoadoutGrant`;
*   2. on the host, a call to `LoadoutService.grant()` per received request, and
*      a broadcast of the returned grant to every peer.
*
* Nothing else in the loadout layer needs to change for it to be networked.
*
* ## Respawn semantics
*
* Changing class mid-life does not swap the gun in your hands — it queues. The
* first request for a player (they have not spawned yet) applies immediately;
* later ones are `pending` until `notifySpawn()`. This is the shipped-shooter
* rule and it is also what keeps the host from having to reconcile a weapon
* swap in the middle of a burst.
*/
/** Resolves a validated loadout into everything a spawn needs. Pure. */
function activate(playerId, loadout) {
	const perkIds = loadout.perks.filter((p) => p.length > 0);
	const perks = perkIds.map((id) => perkDef(id)).filter((p) => p !== null);
	const primary = resolveWeapon(loadout.primary.weaponId, loadout.primary.attachments, { perks: perkIds });
	const secondary = resolveWeapon(loadout.secondary.weaponId, loadout.secondary.attachments, { perks: perkIds });
	const lethal = lethalDef(loadout.lethal) ?? lethalDef("eq_frag");
	const tactical = tacticalDef(loadout.tactical) ?? tacticalDef("eq_flash");
	const fieldUpgrade = fieldUpgradeDef(loadout.fieldUpgrade) ?? fieldUpgradeDef("fu_deadsilence");
	const flags = [.../* @__PURE__ */ new Set([
		...primary.flags,
		...secondary.flags,
		...perks.flatMap((p) => p.flags ?? [])
	])].sort();
	const hardline = flags.includes("hardline");
	const killstreaks = loadout.killstreaks.map((id) => ({
		id,
		cost: Math.max(1, killstreakCost(id) - (hardline ? 1 : 0))
	}));
	return {
		playerId,
		loadout,
		primary,
		secondary,
		perks,
		lethal,
		tactical,
		fieldUpgrade,
		lethalGrenade: grenadeKindFor(lethal),
		tacticalGrenade: grenadeKindFor(tactical),
		flags,
		killstreaks
	};
}
function killstreakCost(id) {
	switch (id) {
		case "uav": return 3;
		case "counteruav": return 4;
		case "carepackage": return 5;
		case "airstrike": return 7;
		case "sentry": return 9;
		default: return 5;
	}
}
/**
* The offline / listen-host authority: validates in-process and grants
* immediately. This is what runs in single player and what the host runs behind
* a networked authority.
*/
var LocalAuthority = class {
	contextFor;
	isHost = true;
	listeners = /* @__PURE__ */ new Set();
	tick = 0;
	/** `contextFor` lets the host apply per-player unlock state. */
	constructor(contextFor = () => ({})) {
		this.contextFor = contextFor;
	}
	/** Advance the authoritative tick — the netcode layer will drive this. */
	setTick(tick) {
		this.tick = tick;
	}
	async request(playerId, loadout) {
		return this.decide(playerId, loadout, false);
	}
	/** Synchronous host-side decision. `request()` is the async wrapper. */
	decide(playerId, loadout, pending) {
		const res = validateLoadout(loadout, this.contextFor(playerId));
		const grant = {
			playerId,
			accepted: res.ok,
			loadout: res.loadout,
			errors: res.errors,
			tick: this.tick,
			pending
		};
		for (const fn of this.listeners) try {
			fn(grant);
		} catch (err) {
			console.error("[loadout] grant listener threw", err);
		}
		return grant;
	}
	onGrant(fn) {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}
};
var LoadoutService = class {
	authority;
	active = /* @__PURE__ */ new Map();
	pending = /* @__PURE__ */ new Map();
	spawned = /* @__PURE__ */ new Set();
	listeners = /* @__PURE__ */ new Set();
	unsubscribe;
	constructor(opts = {}) {
		this.authority = opts.authority ?? new LocalAuthority(opts.contextFor ?? (() => ({})));
		this.unsubscribe = this.authority.onGrant((g) => this.applyGrant(g));
	}
	dispose() {
		this.unsubscribe();
		this.listeners.clear();
		this.active.clear();
		this.pending.clear();
		this.spawned.clear();
	}
	/**
	* Ask the authority to run `loadout` for `playerId`.
	*
	* The returned grant is authoritative: if `accepted` is false the host still
	* granted `grant.loadout` (the repair), and the UI must show that build.
	*/
	async request(playerId, loadout) {
		const grant = await this.authority.request(playerId, cloneLoadout(loadout));
		this.applyGrant(grant);
		return grant;
	}
	/** Host-side entry point for a request that arrived over the wire. */
	grant(playerId, untrusted, context = {}) {
		const res = validateLoadout(untrusted, context);
		const grant = {
			playerId,
			accepted: res.ok,
			loadout: res.loadout,
			errors: res.errors,
			tick: 0,
			pending: this.spawned.has(playerId)
		};
		this.applyGrant(grant);
		return grant;
	}
	applyGrant(grant) {
		if ((grant.pending || this.spawned.has(grant.playerId)) && this.active.has(grant.playerId)) {
			this.pending.set(grant.playerId, grant.loadout);
			return;
		}
		this.install(grant.playerId, grant.loadout);
	}
	install(playerId, loadout) {
		const a = activate(playerId, loadout);
		this.active.set(playerId, a);
		this.pending.delete(playerId);
		for (const fn of this.listeners) try {
			fn(a);
		} catch (err) {
			console.error("[loadout] active listener threw", err);
		}
		return a;
	}
	/**
	* Call on every respawn. Promotes a queued class and returns what the player
	* should spawn with — the weapon system reads `primary`/`secondary` from it.
	*/
	notifySpawn(playerId) {
		const queued = this.pending.get(playerId);
		const result = queued ? this.install(playerId, queued) : this.active.get(playerId) ?? this.install(playerId, defaultLoadout());
		this.spawned.add(playerId);
		return result;
	}
	/** Forget a player entirely (disconnect, match end). */
	release(playerId) {
		this.active.delete(playerId);
		this.pending.delete(playerId);
		this.spawned.delete(playerId);
	}
	/** Everyone starts unspawned again — call between matches. */
	resetSpawnState() {
		this.spawned.clear();
	}
	activeFor(playerId) {
		return this.active.get(playerId) ?? null;
	}
	pendingFor(playerId) {
		return this.pending.get(playerId) ?? null;
	}
	hasPending(playerId) {
		return this.pending.has(playerId);
	}
	/** Fires whenever a player's active loadout actually changes. */
	onActive(fn) {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}
};
/** The errors a UI should surface, formatted for a one-line toast. */
function describeErrors(errors) {
	return errors.map((e) => e.id ? `${e.message}` : e.message);
}
//#endregion
//#region src/session/loadout/Tuning.ts
/**
* Live balance tuning.
*
* A balance pass should be a data change, not a rebuild. `applyTuningPatch`
* takes a sparse JSON object — stat rails, structural limits, individual
* attachment and perk multipliers — and folds it into the tables the resolver
* reads. Everything resolved *after* the call uses the new numbers; nothing
* caches, so a designer can retune between rounds.
*
* ```ts
* applyTuningPatch({
*   attachments: { stock_none: { recoilVertical: 1.45 } },
*   stats: { hipSpread: { minMul: 0.5 } },
* });
* ```
*
* The patch is validated the same way a loadout is: unknown ids and non-finite
* numbers are ignored rather than trusted, because a tuning blob can arrive
* from the same places a loadout can.
*/
/** Applies a patch. Returns a note per field that actually changed. */
function applyTuningPatch(patch) {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return [];
	const p = patch;
	return [
		...applyStatTuning(p),
		...applyAttachmentTuning(p),
		...applyPerkTuning(p)
	];
}
//#endregion
//#region src/core/Rand.ts
/**
* Deterministic RNG. Every gameplay/VFX system must draw from a seeded stream so
* capture runs are byte-reproducible frame to frame.
*/
/** xoshiro128** — fast, good statistical quality, 128-bit state. */
var Rand = class Rand {
	s0 = 0;
	s1 = 0;
	s2 = 0;
	s3 = 0;
	constructor(seed = 1337) {
		this.seed(seed);
	}
	seed(seed) {
		let h = typeof seed === "string" ? hashString(seed) : seed >>> 0 || 1;
		const next = () => {
			h = h + 2654435769 | 0;
			let z = h;
			z = Math.imul(z ^ z >>> 16, 569420461);
			z = Math.imul(z ^ z >>> 15, 1935289751);
			return (z ^ z >>> 15) >>> 0;
		};
		this.s0 = next();
		this.s1 = next();
		this.s2 = next();
		this.s3 = next();
		if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
	}
	/** Uniform uint32. */
	u32() {
		const r = Math.imul(this.s1 * 5, 1) >>> 0;
		const result = (r << 7 | r >>> 25) * 9 >>> 0;
		const t = this.s1 << 9 >>> 0;
		this.s2 ^= this.s0;
		this.s3 ^= this.s1;
		this.s1 ^= this.s2;
		this.s0 ^= this.s3;
		this.s2 = (this.s2 ^ t) >>> 0;
		this.s3 = (this.s3 << 11 | this.s3 >>> 21) >>> 0;
		return result;
	}
	/** Uniform in [0,1). */
	next() {
		return this.u32() / 4294967296;
	}
	/** Uniform in [min,max). */
	range(min, max) {
		return min + this.next() * (max - min);
	}
	/** Uniform integer in [min,max]. */
	int(min, max) {
		return min + Math.floor(this.next() * (max - min + 1));
	}
	/** Uniform in [-1,1]. */
	signed() {
		return this.next() * 2 - 1;
	}
	bool(p = .5) {
		return this.next() < p;
	}
	pick(arr) {
		return arr[Math.floor(this.next() * arr.length)];
	}
	/** Box–Muller normal, mean 0 stddev 1. */
	normal() {
		let u = 0, v = 0;
		while (u === 0) u = this.next();
		while (v === 0) v = this.next();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	}
	/** Uniform point in a unit disc — used for spread cones and bokeh. */
	disc(out) {
		const r = Math.sqrt(this.next());
		const a = this.next() * Math.PI * 2;
		out.x = r * Math.cos(a);
		out.y = r * Math.sin(a);
	}
	shuffle(arr) {
		for (let i = arr.length - 1; i > 0; i--) {
			const j = this.int(0, i);
			const t = arr[i];
			arr[i] = arr[j];
			arr[j] = t;
		}
		return arr;
	}
	fork(tag) {
		return new Rand(this.u32() ^ hashString(tag));
	}
};
function hashString(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}
new Rand(Number(new URLSearchParams(globalThis.location?.search ?? "").get("seed")) || 1337);
//#endregion
//#region src/weapons/Attachments.ts
var OPTICS = [
	{
		id: "optic_reddot",
		name: "RD-2 Reflex",
		slot: "optic",
		classes: "all",
		description: "Compact enclosed red dot. Fast, unobtrusive, no magnification.",
		stats: {
			adsTimeScale: 1.03,
			adsSpreadScale: .92,
			magnification: 1
		},
		build: {
			kind: "reddot",
			length: .062,
			radius: .0175,
			sightHeight: .036,
			material: "black"
		}
	},
	{
		id: "optic_holo",
		name: "HS-1 Holographic",
		slot: "optic",
		classes: "all",
		description: "Wide-window holographic sight. Best peripheral view of any optic.",
		stats: {
			adsTimeScale: 1.05,
			adsSpreadScale: .9,
			hipSpreadScale: .97,
			magnification: 1
		},
		build: {
			kind: "holo",
			length: .086,
			radius: .023,
			sightHeight: .04,
			material: "black"
		}
	},
	{
		id: "optic_acog",
		name: "TA-4 Combat Scope",
		slot: "optic",
		classes: [
			"assault",
			"marksman",
			"lmg",
			"sniper"
		],
		description: "4× prism scope with an illuminated chevron. Trades handling for reach.",
		stats: {
			adsTimeScale: 1.16,
			adsSpreadScale: .72,
			rangeScale: 1.1,
			moveScale: .98,
			magnification: 4
		},
		build: {
			kind: "acog",
			length: .135,
			radius: .024,
			sightHeight: .048,
			material: "black"
		}
	},
	{
		id: "optic_sniper",
		name: "LR-9 Variable Scope",
		slot: "optic",
		classes: ["sniper", "marksman"],
		description: "9× variable scope. Enormous reach, glacial target acquisition.",
		stats: {
			adsTimeScale: 1.3,
			adsSpreadScale: .5,
			rangeScale: 1.2,
			moveScale: .96,
			magnification: 9
		},
		build: {
			kind: "sniperScope",
			length: .29,
			radius: .028,
			sightHeight: .056,
			material: "black"
		}
	},
	{
		id: "optic_irons",
		name: "Iron Sights",
		slot: "optic",
		classes: "all",
		description: "Factory irons. Nothing to snag, nothing to fail.",
		stats: {
			adsTimeScale: .96,
			magnification: 1
		},
		build: { kind: "ironsOnly" }
	}
];
var MUZZLES = [
	{
		id: "muzzle_suppressor",
		name: "Suppressor",
		slot: "muzzle",
		classes: "all",
		description: "Removes the flash and keeps you off the minimap. Costs velocity and handling.",
		stats: {
			suppressed: true,
			muzzleVelocityScale: .92,
			adsTimeScale: 1.08,
			recoilScale: .94,
			rangeScale: .9,
			sprintOutScale: 1.06
		},
		build: {
			kind: "suppressor",
			length: .175,
			radius: .0215,
			material: "phosphate"
		}
	},
	{
		id: "muzzle_comp",
		name: "Compensator",
		slot: "muzzle",
		classes: "all",
		description: "Ports gas upward. Kills muzzle climb, adds a very visible flash.",
		stats: {
			recoilScale: .82,
			recoilHorizontalScale: 1.06,
			adsTimeScale: 1.02
		},
		build: {
			kind: "compensator",
			length: .058,
			radius: .017,
			material: "phosphate"
		}
	},
	{
		id: "muzzle_brake",
		name: "Muzzle Brake",
		slot: "muzzle",
		classes: [
			"sniper",
			"marksman",
			"lmg",
			"shotgun"
		],
		description: "Redirects gas sideways. Tames heavy calibres at the cost of noise.",
		stats: {
			recoilScale: .74,
			recoilHorizontalScale: .86,
			adsTimeScale: 1.06,
			moveScale: .99
		},
		build: {
			kind: "brake",
			length: .072,
			radius: .019,
			material: "phosphate"
		}
	},
	{
		id: "muzzle_flash",
		name: "Flash Hider",
		slot: "muzzle",
		classes: "all",
		description: "Breaks up the flash signature without the weight of a can.",
		stats: {
			recoilScale: .96,
			adsTimeScale: 1
		},
		build: {
			kind: "flashHider",
			length: .052,
			radius: .0135,
			material: "phosphate"
		}
	}
];
var UNDERBARREL = [
	{
		id: "under_grip",
		name: "Vertical Grip",
		slot: "underbarrel",
		classes: "all",
		description: "Straight foregrip. Vertical recoil control, slightly slower ADS.",
		stats: {
			recoilScale: .86,
			adsTimeScale: 1.04,
			hipSpreadScale: 1.02
		},
		build: {
			kind: "foregrip",
			length: .088,
			radius: .0135,
			material: "polymer"
		}
	},
	{
		id: "under_angled",
		name: "Angled Grip",
		slot: "underbarrel",
		classes: "all",
		description: "Canted grip. Faster into the shoulder, better horizontal control.",
		stats: {
			recoilHorizontalScale: .8,
			adsTimeScale: .95,
			sprintOutScale: .94
		},
		build: {
			kind: "angledGrip",
			length: .078,
			radius: .014,
			material: "polymer"
		}
	},
	{
		id: "under_bipod",
		name: "Folding Bipod",
		slot: "underbarrel",
		classes: [
			"lmg",
			"sniper",
			"marksman"
		],
		description: "Deployable legs. Enormous stability when static, dead weight when moving.",
		stats: {
			recoilScale: .9,
			moveScale: .97,
			adsTimeScale: 1.05
		},
		build: {
			kind: "bipod",
			length: .15,
			radius: .006,
			material: "phosphate"
		}
	}
];
var LASERS = [{
	id: "laser_visible",
	name: "Tactical Laser",
	slot: "laser",
	classes: "all",
	description: "Tightens hip fire dramatically. The beam gives your position away.",
	stats: {
		laser: true,
		hipSpreadScale: .62,
		sprintOutScale: .9
	},
	build: {
		kind: "laser",
		length: .048,
		radius: .01,
		material: "alu",
		tint: 16722462
	}
}];
var MAGAZINES = [
	{
		id: "mag_extended",
		name: "Extended Mag",
		slot: "magazine",
		classes: "all",
		description: "+50% capacity. Longer to reload, heavier to carry.",
		stats: {
			magSizeScale: 1.5,
			reloadScale: 1.12,
			adsTimeScale: 1.02,
			moveScale: .99
		},
		build: { kind: "extMag" }
	},
	{
		id: "mag_quick",
		name: "Quickdraw Mag",
		slot: "magazine",
		classes: "all",
		description: "Tapered mag well and a grip tab. Much faster reloads.",
		stats: {
			reloadScale: .78,
			drawScale: .94
		},
		build: { kind: "quickMag" }
	},
	{
		id: "mag_drum",
		name: "Drum Mag",
		slot: "magazine",
		classes: [
			"assault",
			"smg",
			"lmg"
		],
		description: "Doubles capacity. Ruins mobility and reload speed.",
		stats: {
			magSizeScale: 2,
			reloadScale: 1.45,
			moveScale: .94,
			adsTimeScale: 1.1
		},
		build: { kind: "drum" }
	}
];
var STOCKS = [
	{
		id: "stock_light",
		name: "Skeleton Stock",
		slot: "stock",
		classes: "all",
		description: "Stripped stock. Faster everything, worse recoil.",
		stats: {
			adsTimeScale: .88,
			sprintOutScale: .86,
			moveScale: 1.04,
			recoilScale: 1.14
		},
		build: { kind: "lightStock" }
	},
	{
		id: "stock_heavy",
		name: "Precision Stock",
		slot: "stock",
		classes: "all",
		description: "Weighted cheek riser and recoil pad. Rock steady, slow to swing.",
		stats: {
			recoilScale: .8,
			recoilHorizontalScale: .86,
			adsTimeScale: 1.1,
			moveScale: .97
		},
		build: { kind: "heavyStock" }
	},
	{
		id: "stock_none",
		name: "No Stock",
		slot: "stock",
		classes: [
			"smg",
			"assault",
			"shotgun"
		],
		description: "Removed entirely. Sprint-out and movement are best in class.",
		stats: {
			adsTimeScale: .8,
			sprintOutScale: .7,
			moveScale: 1.08,
			recoilScale: 1.35,
			hipSpreadScale: .9
		},
		build: { kind: "noStock" }
	}
];
var ATTACHMENTS = [
	...OPTICS,
	...MUZZLES,
	...UNDERBARREL,
	...LASERS,
	...MAGAZINES,
	...STOCKS
];
new Map(ATTACHMENTS.map((a) => [a.id, a]));
//#endregion
export { ATTACHMENT_TABLE, FIELD_UPGRADES, FLAG_LABEL, FLAG_SIDE, KILLSTREAK_OPTIONS, LETHALS, LIMITS, LOADOUT_SLOTS, LoadoutBook, LoadoutService, LocalAuthority, MemoryStorage, ModifierStack, PERK_TABLE, PRESET_CLASSES, RELOAD_RAILS, Rand, STAT_KEYS, STAT_RULES, TACTICALS, WEAPONS, ATTACHMENTS as WEAPON_ATTACHMENTS, WEAPON_META, activate, applyTuningPatch, assertWeaponMetaCoverage, attachmentEntry, attachmentsFor, auditAttachments, clampToRule, cloneLoadout, contentIndex, damageAt, defaultLoadout, describeErrors, effectiveDamageAt, effectiveShotsToKill, fieldUpgradeDef, grenadeKindFor, isBaseline, isLocked, killstreakOption, lethalDef, loadoutsEqual, mountable, perkConflicts, perkDef, perksInRow, railBounds, railsFor, repairLoadout, resolveAttachments, resolveWeapon, sanitiseName, serialiseLoadout, slotsFor, statBars, tacticalDef, toResolvedStats, validateLoadout, weaponDef, weaponMeta, weaponMinRank };
