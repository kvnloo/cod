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
//#region src/session/matchmaking/BotFill.ts
const CALLSIGNS = [
	"Hawke",
	"Vega",
	"Rook",
	"Sable",
	"Cobalt",
	"Ridge",
	"Talon",
	"Marrow",
	"Fenn",
	"Kestrel",
	"Brisk",
	"Nomad",
	"Ash",
	"Quill",
	"Drover",
	"Pike",
	"Sorrel",
	"Vandal",
	"Coyle",
	"Halden",
	"Priest",
	"Rasp",
	"Tundra",
	"Wren",
	"Slate",
	"Barrow",
	"Crane",
	"Dax",
	"Ember",
	"Flint",
	"Gault",
	"Hollow"
];
/**
* Rating bands. The bottom band is wide because everything under ~1250 plays
* the same from the receiving end, and the top band is open-ended because
* `veteran` is already at the edge of fair.
*/
const TIERS = [
	{
		id: "recruit",
		lo: 0,
		hi: 1250
	},
	{
		id: "regular",
		lo: 1250,
		hi: 1550
	},
	{
		id: "hardened",
		lo: 1550,
		hi: 1850
	},
	{
		id: "veteran",
		lo: 1850,
		hi: 2400
	}
];
function difficultyForRating(rating) {
	for (const t of TIERS) if (rating < t.hi) return t.id;
	return "veteran";
}
/** Where inside its tier a rating sits, 0..1. Drives the trim multipliers. */
function tierFraction(rating) {
	for (const t of TIERS) if (rating < t.hi) return clamp$2((rating - t.lo) / (t.hi - t.lo), 0, 1);
	return 1;
}
/**
* Loadout mix for a filled team. Weighted so a bot team reads like a squad:
* mostly riflemen and assaulters, one marksman holding a lane, an occasional
* gunner. No juggernauts — that archetype is a boss, not a teammate.
*/
const FILL_WEIGHTS = [
	["rifleman", .42],
	["smg", .26],
	["shotgun", .12],
	["sniper", .11],
	["lmg", .09]
];
/** Per-team concurrency caps, so a filled team is not five snipers. */
const FILL_CAPS = {
	sniper: 1,
	lmg: 1,
	shotgun: 2
};
function pickArchetype(taken, rng) {
	let total = 0;
	const weights = [];
	for (const [id, w] of FILL_WEIGHTS) {
		const cap = FILL_CAPS[id];
		const used = taken.get(id) ?? 0;
		const eff = cap !== void 0 && used >= cap ? 0 : w;
		weights.push(eff);
		total += eff;
	}
	if (total <= 0) return "rifleman";
	let r = rng.next() * total;
	for (let i = 0; i < FILL_WEIGHTS.length; i++) {
		r -= weights[i];
		if (r <= 0) return FILL_WEIGHTS[i][0];
	}
	return "rifleman";
}
/** Humans currently on a team. */
function humansOn(roster, team) {
	return roster.slots.filter((s) => s.kind === "human" && s.team === team);
}
function botsOn(roster, team) {
	return roster.slots.filter((s) => s.kind === "bot" && s.team === team);
}
function slotRating(s) {
	return s.kind === "human" ? s.rating.rating : s.rating;
}
function teamStrength(roster, team) {
	const slots = roster.slots.filter((s) => s.team === team);
	if (slots.length === 0) return 0;
	return slots.reduce((a, s) => a + slotRating(s), 0) / slots.length;
}
/** Mean rating of every human in the roster, or 1500 when there are none. */
function lobbyHumanMean(roster) {
	const humans = roster.slots.filter((s) => s.kind === "human");
	if (humans.length === 0) return 1500;
	return humans.reduce((a, h) => a + h.rating.rating, 0) / humans.length;
}
let botSeq = 0;
/** Test hook — makes bot ids reproducible across simulation runs. */
function resetBotIds() {
	botSeq = 0;
}
/**
* Fills every empty slot in `roster` with a bot. Bots are added to the weaker
* team first and drawn slightly above/below the target so the two sides end up
* within a few rating points of each other.
*/
function fillRoster(roster, def, rng, now, opts = {}) {
	const added = [];
	if (!def.allowBots) {
		let missing = 0;
		for (let t = 0; t < def.teams; t++) missing += def.teamSize - roster.slots.filter((s) => s.team === t).length;
		return {
			added,
			shortfall: Math.max(0, missing)
		};
	}
	const target = opts.targetRating ?? lobbyHumanMean(roster);
	const spread = opts.spread ?? 110;
	const maxPerTeam = opts.maxPerTeam ?? def.teamSize;
	const takenByTeam = /* @__PURE__ */ new Map();
	for (let t = 0; t < def.teams; t++) {
		const m = /* @__PURE__ */ new Map();
		for (const b of botsOn(roster, t)) m.set(b.archetype, (m.get(b.archetype) ?? 0) + 1);
		takenByTeam.set(t, m);
	}
	let shortfall = 0;
	for (;;) {
		let bestTeam = -1;
		let bestKey = Infinity;
		for (let t = 0; t < def.teams; t++) {
			const filled = roster.slots.filter((s) => s.team === t).length;
			if (filled >= def.teamSize) continue;
			if (botsOn(roster, t).length >= maxPerTeam) {
				shortfall += def.teamSize - filled;
				continue;
			}
			const key = filled * 1e4 + teamStrength(roster, t) / 1e3;
			if (key < bestKey) {
				bestKey = key;
				bestTeam = t;
			}
		}
		if (bestTeam < 0) break;
		const other = def.teams === 2 ? 1 - bestTeam : bestTeam;
		const mine = teamStrength(roster, bestTeam);
		const theirs = def.teams === 2 ? teamStrength(roster, other) : mine;
		const rating = clamp$2(target + (def.teams === 2 && mine > 0 && theirs > 0 ? clamp$2(theirs - mine, -160, 160) * .5 : 0) + rng.normal() * spread, 900, 2300);
		const taken = takenByTeam.get(bestTeam);
		const archetype = pickArchetype(taken, rng);
		taken.set(archetype, (taken.get(archetype) ?? 0) + 1);
		const bot = makeBot(rating, archetype, bestTeam, now, rng);
		roster.slots.push(bot);
		added.push(bot);
	}
	return {
		added,
		shortfall
	};
}
function makeBot(rating, archetype, team, now, rng) {
	const difficulty = difficultyForRating(rating);
	const f = tierFraction(rating);
	return {
		kind: "bot",
		botId: `bot:${++botSeq}`,
		name: `${rng.pick(CALLSIGNS)}-${botSeq % 90 + 10}`,
		team,
		rating,
		difficulty,
		archetype,
		accuracyScale: .85 + f * .3,
		aggressionScale: .8 + f * .4,
		seed: rng.u32(),
		joinedAt: now,
		yieldPriority: botSeq
	};
}
/**
* Chooses which bot gives up its slot for an incoming human.
*
* Two rules, in order:
*  1. Prefer the bot whose removal leaves the two teams closest in strength
*     after the human is added — replacing a 1900 bot with a 1200 human on the
*     strong team is how a backfill turns into a stomp.
*  2. Break ties toward the newest bot (highest `yieldPriority`), so bots that
*     have been fighting for a while — and that the players have been
*     reacting to — are the last to blink out.
*/
function chooseBotToYield(roster, team, incomingRating) {
	const candidates = botsOn(roster, team);
	if (candidates.length === 0) return null;
	const otherTeam = [...new Set(roster.slots.map((s) => s.team))].find((t) => t !== team);
	const otherStrength = otherTeam === void 0 ? null : teamStrength(roster, otherTeam);
	let best = null;
	let bestCost = Infinity;
	for (const bot of candidates) {
		let cost;
		if (otherStrength === null) cost = Math.abs(bot.rating - incomingRating);
		else {
			const mine = roster.slots.filter((s) => s.team === team);
			const sum = mine.reduce((a, s) => a + slotRating(s), 0) - bot.rating + incomingRating;
			cost = Math.abs(sum / Math.max(1, mine.length) - otherStrength);
		}
		const key = cost - bot.yieldPriority * .001;
		if (key < bestCost) {
			bestCost = key;
			best = bot;
		}
	}
	return best;
}
/** Removes a bot from the roster. Returns false when it was already gone. */
function removeBot(roster, botId) {
	const i = roster.slots.findIndex((s) => s.kind === "bot" && s.botId === botId);
	if (i < 0) return false;
	roster.slots.splice(i, 1);
	return true;
}
/** Which team a new human should join: the emptiest, then the weakest. */
function teamForIncoming(roster, def) {
	let best = 0;
	let bestKey = Infinity;
	for (let t = 0; t < def.teams; t++) {
		const key = humansOn(roster, t).length * 1e4 + teamStrength(roster, t) / 1e3;
		if (key < bestKey) {
			bestKey = key;
			best = t;
		}
	}
	return best;
}
function toAgentOptions(slot, faction = "pmc") {
	return {
		loadout: slot.archetype,
		difficulty: slot.difficulty,
		seed: slot.seed,
		name: slot.name,
		faction
	};
}
/**
* `localTeam` is the team index the local player is on, so bots on it become
* `friendly` and everything else becomes `hostile` — the only two teams the
* game layer models today.
*/
function toSpawnParams(slot, localTeam, faction = "pmc") {
	return {
		archetype: slot.archetype,
		faction,
		team: slot.team === localTeam ? "friendly" : "hostile",
		seed: slot.seed,
		health: 1,
		accuracy: slot.accuracyScale,
		aggression: slot.aggressionScale,
		tag: `mmbot:${slot.botId}`
	};
}
function clamp$2(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}
//#endregion
//#region src/session/matchmaking/types.ts
const REGIONS = [
	"na-east",
	"na-west",
	"eu-west",
	"eu-east",
	"apac",
	"oce",
	"sa"
];
//#endregion
//#region src/session/matchmaking/Connection.ts
/** Backbone RTT in ms. Symmetric; the diagonal is intra-region. */
const RTT_TABLE = build({
	"na-east": {
		"na-east": 16,
		"na-west": 62,
		"eu-west": 78,
		"eu-east": 112,
		apac: 190,
		oce: 205,
		sa: 118
	},
	"na-west": {
		"na-west": 16,
		"eu-west": 142,
		"eu-east": 168,
		apac: 118,
		oce: 150,
		sa: 176
	},
	"eu-west": {
		"eu-west": 14,
		"eu-east": 36,
		apac: 198,
		oce: 268,
		sa: 182
	},
	"eu-east": {
		"eu-east": 18,
		apac: 188,
		oce: 288,
		sa: 214
	},
	apac: {
		apac: 20,
		oce: 108,
		sa: 302
	},
	oce: {
		oce: 18,
		sa: 318
	},
	sa: { sa: 22 }
});
function build(partial) {
	const out = {};
	for (const a of REGIONS) out[a] = {};
	for (const a of REGIONS) for (const b of REGIONS) {
		const v = partial[a]?.[b] ?? partial[b]?.[a] ?? 250;
		out[a][b] = v;
		out[b][a] = v;
	}
	return out;
}
function backboneRtt(a, b) {
	return RTT_TABLE[a]?.[b] ?? 250;
}
/** Round-trip estimate between two players, in ms. */
function estimateRtt(a, b) {
	return backboneRtt(a.region, b.region) + a.lastMileMs + b.lastMileMs;
}
/**
* What the ping *feels* like. Jitter is charged at 2× because a variable 40 ms
* is worse to play against than a steady 60 ms, and loss is charged brutally
* because every dropped packet is a rewound kill.
*/
function effectiveRtt(a, b) {
	return estimateRtt(a, b) + (a.jitterMs + b.jitterMs) * 2 + (a.lossPct + b.lossPct) * 22;
}
const NAT_PENALTY = {
	open: 0,
	moderate: 26,
	strict: 120
};
/** Upstream a host needs per connected client, in kbit/s, at 20 Hz snapshot rate. */
const UPSTREAM_PER_CLIENT = 190;
/** 0..1 quality score for one connection, used for coarse bucketing. */
function connectionQuality(c) {
	const jitter = 1 - clamp01(c.jitterMs / 40);
	const loss = 1 - clamp01(c.lossPct / 3);
	const lastMile = 1 - clamp01((c.lastMileMs - 5) / 75);
	const nat = c.nat === "open" ? 1 : c.nat === "moderate" ? .8 : .5;
	return clamp01(jitter * .28 + loss * .3 + lastMile * .27 + nat * .15);
}
/**
* Picks the authority. Cost is dominated by the *worst* member ping rather
* than the mean — a host is only as good as the unhappiest player behind it —
* with penalties for NAT, jitter and insufficient upstream.
*/
function selectHost(members, clients) {
	let best = {
		hostId: null,
		worstPing: Infinity,
		meanPing: Infinity,
		cost: Infinity
	};
	for (const cand of members) {
		if (!cand.connection.hostCapable) continue;
		let worst = 0;
		let sum = 0;
		let n = 0;
		for (const m of members) {
			if (m.playerId === cand.playerId) continue;
			const rtt = effectiveRtt(m.connection, cand.connection);
			worst = Math.max(worst, rtt);
			sum += rtt;
			n++;
		}
		const mean = n > 0 ? sum / n : 0;
		const needed = UPSTREAM_PER_CLIENT * Math.max(1, clients);
		const upstreamShort = Math.max(0, needed - cand.connection.upstreamKbps) / needed;
		const cost = worst + mean * .35 + NAT_PENALTY[cand.connection.nat] + cand.connection.jitterMs * 3 + upstreamShort * 260;
		if (cost < best.cost) best = {
			hostId: cand.playerId,
			worstPing: worst,
			meanPing: mean,
			cost
		};
	}
	if (best.hostId === null && members.length > 0) {
		let fallback = members[0];
		for (const m of members) if (connectionQuality(m.connection) > connectionQuality(fallback.connection)) fallback = m;
		const pings = members.filter((m) => m.playerId !== fallback.playerId).map((m) => effectiveRtt(m.connection, fallback.connection));
		best = {
			hostId: fallback.playerId,
			worstPing: pings.length ? Math.max(...pings) : 0,
			meanPing: pings.length ? pings.reduce((a, b) => a + b, 0) / pings.length : 0,
			cost: Infinity
		};
	}
	if (best.worstPing === Infinity) best = {
		...best,
		worstPing: 0,
		meanPing: 0
	};
	return best;
}
/** Ping of every member to a chosen host. */
function pingsToHost(members, hostId) {
	if (!hostId) return [];
	const host = members.find((m) => m.playerId === hostId);
	if (!host) return [];
	return members.filter((m) => m.playerId !== hostId).map((m) => effectiveRtt(m.connection, host.connection));
}
function defaultConnection(region = "na-east") {
	return {
		region,
		lastMileMs: 18,
		jitterMs: 4,
		lossPct: .1,
		nat: "open",
		upstreamKbps: 4e3,
		hostCapable: true
	};
}
function clamp01(v) {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}
//#endregion
//#region src/session/matchmaking/Widening.ts
const DEFAULT_WIDENING = {
	skillWindow0: 75,
	skillDoubleEvery: 25,
	skillWindowMax: 900,
	rdWeight: 1,
	pingWindow0: 45,
	pingWidenRate: 1.6,
	pingWindowMax: 220,
	crossRegionAfter: 40,
	botFillAfter: 25,
	botFillFloor: .5,
	hardTimeout: 120
};
/** Ranked: fairness beats speed. Slower widening, no cross-region until late. */
const RANKED_WIDENING = {
	skillWindow0: 45,
	skillDoubleEvery: 45,
	skillWindowMax: 420,
	rdWeight: .6,
	pingWindow0: 40,
	pingWidenRate: .9,
	pingWindowMax: 140,
	crossRegionAfter: 90,
	botFillAfter: Infinity,
	botFillFloor: 1,
	hardTimeout: 300
};
/** Private / party lobbies: start almost immediately, bots make up the rest. */
const PRIVATE_WIDENING = {
	skillWindow0: 400,
	skillDoubleEvery: 10,
	skillWindowMax: 2e3,
	botFillAfter: 6,
	botFillFloor: 0,
	crossRegionAfter: 0,
	hardTimeout: 20
};
function wideningFor(playlist) {
	return {
		...DEFAULT_WIDENING,
		...playlist.widening ?? {}
	};
}
/** Evaluates the curve for one ticket at time `now`. */
function windowsAt(waited, rd, p) {
	const t = Math.max(0, waited);
	return {
		skill: Math.min(p.skillWindowMax, p.skillWindow0 * Math.pow(2, t / p.skillDoubleEvery)) + p.rdWeight * rd,
		ping: Math.min(p.pingWindowMax, p.pingWindow0 + p.pingWidenRate * t),
		crossRegion: t >= p.crossRegionAfter,
		botFill: t >= p.botFillAfter,
		desperate: t >= p.hardTimeout,
		waited: t
	};
}
function windowsForTicket(ticket, now, p) {
	return windowsAt(now - ticket.joinedAt, ticket.rd, p);
}
/**
* How many of the lobby's `capacity` slots must be filled by humans before the
* queue is willing to launch, given the seed has waited `waited` seconds.
*
* Above `botFillAfter` this decays linearly from `botFillFloor × capacity` down
* to `minHumans`, reaching it at the hard timeout. Below it the answer is
* `capacity` — bots are not permitted at all yet, so nothing short of a full
* lobby launches.
*
* This is a *demand-side* floor only. The queue caps it by what the population
* can actually supply (`Queue.tryForm`), because waiting for humans who do not
* exist is the other way to make a queue feel broken.
*/
function humansRequired(waited, capacity, minHumans, p) {
	const cap = Math.max(1, Math.floor(capacity));
	const floorMin = Math.max(1, Math.min(Math.floor(minHumans), cap));
	if (!Number.isFinite(p.botFillAfter)) return cap;
	if (waited < p.botFillAfter) return cap;
	const span = Math.max(1e-6, p.hardTimeout - p.botFillAfter);
	const u = Math.max(0, Math.min(1, (waited - p.botFillAfter) / span));
	const start = Math.max(floorMin, Math.min(cap, Math.ceil(cap * p.botFillFloor)));
	return Math.max(floorMin, Math.round(start + (floorMin - start) * u));
}
/**
* Combines two tickets' windows into the pair's operating window.
*
* The two axes deliberately combine in *opposite* directions, because they
* express opposite things:
*
* **Skill takes the max — fairness is negotiable.** A player who has waited
* 90 s should be able to rescue a player who just arrived. If both sides had to
* agree, the long-waiting ticket could never be cleared by fresh arrivals,
* which is the classic way a queue develops a permanently stuck tail.
*
* **Ping and region take the min — comfort is not.** Someone who queued four
* seconds ago should not be dragged into a 220 ms cross-region lobby because a
* stranger has been waiting a minute and a half. Their patience is not the
* newcomer's problem. Taking the max here was worth ~50 ms of mean lobby ping
* in the population sim, all of it paid by the players who were *not* waiting.
*
* The stuck tail this could create on the latency axis is bounded by
* `desperate`: past the hard timeout a ticket stops negotiating and the pair's
* windows open all the way. That is the correct place for the escape hatch —
* it is explicit, it is capped, and it applies to one ticket rather than
* quietly degrading every match in the playlist.
*/
function mutualWindows(a, b) {
	const desperate = a.desperate || b.desperate;
	return {
		skill: Math.max(a.skill, b.skill),
		ping: desperate ? Math.max(a.ping, b.ping) : Math.min(a.ping, b.ping),
		crossRegion: desperate ? true : a.crossRegion && b.crossRegion,
		botFill: a.botFill || b.botFill,
		desperate,
		waited: Math.max(a.waited, b.waited)
	};
}
/** Sampled curve rows — printed by `tools/session-mm.mjs` so the curve is documented by the build. */
function describeCurve(p = DEFAULT_WIDENING, times = [
	0,
	5,
	10,
	20,
	30,
	45,
	60,
	90,
	120
], rd = 0, capacity = 12, minHumans = 1) {
	return times.map((t) => {
		const w = windowsAt(t, rd, p);
		return {
			t,
			skill: Math.round(w.skill),
			ping: Math.round(w.ping),
			crossRegion: w.crossRegion,
			botFill: w.botFill,
			humans: humansRequired(t, capacity, minHumans, p)
		};
	});
}
//#endregion
//#region src/session/matchmaking/Playlists.ts
/**
* Playlist table.
*
* A playlist is the unit the queue buckets on: mode, team size, whether bots
* are allowed, whether a live match accepts backfill, and the widening
* overrides that express the playlist's stance on speed versus fairness.
*/
const PLAYLISTS = {
	"core-tdm-6v6": {
		id: "core-tdm-6v6",
		name: "Team Deathmatch",
		mode: "tdm",
		teamSize: 6,
		teams: 2,
		minHumansToStart: 1,
		allowBots: true,
		allowBackfill: true,
		ranked: false
	},
	"core-tdm-4v4": {
		id: "core-tdm-4v4",
		name: "Team Deathmatch (Small)",
		mode: "tdm",
		teamSize: 4,
		teams: 2,
		minHumansToStart: 1,
		allowBots: true,
		allowBackfill: true,
		ranked: false
	},
	"ranked-tdm-4v4": {
		id: "ranked-tdm-4v4",
		name: "Ranked Play",
		mode: "tdm",
		teamSize: 4,
		teams: 2,
		minHumansToStart: 8,
		allowBots: false,
		allowBackfill: false,
		ranked: true,
		widening: RANKED_WIDENING
	},
	"private-6v6": {
		id: "private-6v6",
		name: "Private Match",
		mode: "tdm",
		teamSize: 6,
		teams: 2,
		minHumansToStart: 1,
		allowBots: true,
		allowBackfill: true,
		ranked: false,
		widening: PRIVATE_WIDENING
	},
	"operation-coop-4": {
		id: "operation-coop-4",
		name: "Operation",
		mode: "operation",
		teamSize: 4,
		teams: 1,
		minHumansToStart: 1,
		allowBots: true,
		allowBackfill: true,
		ranked: false
	},
	"firefight-coop-4": {
		id: "firefight-coop-4",
		name: "Firefight",
		mode: "firefight",
		teamSize: 4,
		teams: 1,
		minHumansToStart: 1,
		allowBots: true,
		allowBackfill: true,
		ranked: false
	}
};
const PLAYLIST_IDS = Object.keys(PLAYLISTS);
function playlist(id) {
	return PLAYLISTS[id] ?? PLAYLISTS["core-tdm-6v6"];
}
/** Total player slots in a match of this playlist (both teams). */
function slotCount(def) {
	return def.teamSize * def.teams;
}
//#endregion
//#region src/session/matchmaking/Backfill.ts
/**
* Backfill — replacing players who leave a live match.
*
* Two halves:
*
*  - **Supply.** A match that loses a human raises a *need*. Needs are not
*    raised instantly: a player who disconnects usually comes back, and
*    handing their slot away in the first five seconds guarantees they cannot.
*    After the grace window the slot is offered, first to a bot (instant, free)
*    and then, if a human turns up, the bot yields.
*
*  - **Admission.** Not every match should accept a stranger. Dropping someone
*    into the last ninety seconds of a 6–0 loss is worse for them than another
*    twenty seconds of queue, and it is worse for the match too — the newcomer
*    quits, which raises another need. `canBackfill` encodes the rules and
*    returns *why* it refused, which is what makes the behaviour tunable
*    instead of mysterious.
*
* Ranked playlists refuse backfill entirely: a rated match with a substitute is
* not a rated match.
*/
const DEFAULT_BACKFILL = {
	maxElapsedFraction: .65,
	minSecondsRemaining: 90,
	maxLeaderFraction: .8,
	maxScoreGapFraction: .5,
	graceAfterLeave: 5,
	maxPing: 170,
	hardMaxPing: 280
};
/** Why a match will or will not take a backfill right now. */
function canBackfill(view, def, policy) {
	if (def.ranked) return "ranked";
	if (!def.allowBackfill) return "playlist-forbids";
	if (view.phase !== "live" && view.phase !== "warmup") return "phase";
	if (view.duration > 0) {
		if (view.elapsed / view.duration > policy.maxElapsedFraction) return "too-late";
		if (view.duration - view.elapsed < policy.minSecondsRemaining) return "too-late";
	}
	if (view.scoreLimit > 0 && view.teamScores.length >= 2) {
		const hi = Math.max(...view.teamScores);
		const lo = Math.min(...view.teamScores);
		if (hi / view.scoreLimit > policy.maxLeaderFraction) return "too-late";
		if ((hi - lo) / view.scoreLimit > policy.maxScoreGapFraction) return "blowout";
	}
	return "ok";
}
var BackfillManager = class {
	policy;
	matches = /* @__PURE__ */ new Map();
	refusals = /* @__PURE__ */ new Map();
	constructor(policy = DEFAULT_BACKFILL) {
		this.policy = policy;
	}
	get size() {
		return this.matches.size;
	}
	register(roster, view) {
		this.matches.set(roster.matchId, {
			roster,
			view,
			def: playlist(roster.playlist),
			vacated: /* @__PURE__ */ new Map()
		});
	}
	update(view) {
		const e = this.matches.get(view.matchId);
		if (e) e.view = view;
	}
	rosterOf(id) {
		return this.matches.get(id)?.roster;
	}
	viewOf(id) {
		return this.matches.get(id)?.view;
	}
	end(id) {
		const e = this.matches.get(id);
		this.matches.delete(id);
		return e?.roster;
	}
	matchIds() {
		return [...this.matches.keys()];
	}
	/** Removes a human from a roster and starts the grace clock on their slot. */
	playerLeft(matchId, playerId, now) {
		const e = this.matches.get(matchId);
		if (!e) return false;
		const i = e.roster.slots.findIndex((s) => s.kind === "human" && s.playerId === playerId);
		if (i < 0) return false;
		e.roster.slots.splice(i, 1);
		e.vacated.set(playerId, now);
		if (e.roster.hostId === playerId) {
			const candidates = e.roster.slots.filter((s) => s.kind === "human").map((s) => ({
				playerId: s.playerId,
				connection: s.connection
			}));
			e.roster.hostId = selectHost(candidates, Math.max(0, candidates.length - 1)).hostId;
		}
		return true;
	}
	/**
	* Slots that have been empty longer than the grace window. Bots should be
	* spawned into these immediately — that is what keeps a match playable while
	* the queue looks for a human.
	*/
	needs(now) {
		const out = [];
		for (const e of this.matches.values()) {
			if (canBackfill(e.view, e.def, this.policy) !== "ok") continue;
			let ready = false;
			for (const at of e.vacated.values()) if (now - at >= this.policy.graceAfterLeave) ready = true;
			if (!ready) continue;
			for (let t = 0; t < e.def.teams; t++) {
				const filled = e.roster.slots.filter((s) => s.team === t).length;
				const count = e.def.teamSize - filled + e.roster.slots.filter((s) => s.kind === "bot" && s.team === t).length;
				if (count > 0) out.push({
					matchId: e.roster.matchId,
					team: t,
					count
				});
			}
		}
		return out;
	}
	/**
	* Finds the best live match for a ticket. Scored on skill fit first and ping
	* second — a backfilled player who cannot hit anything leaves again.
	*/
	findMatch(ticket, now) {
		let best = null;
		let bestCost = Infinity;
		for (const e of this.matches.values()) {
			if (e.def.id !== ticket.playlist) continue;
			const refusal = canBackfill(e.view, e.def, this.policy);
			if (refusal !== "ok") {
				this.count(refusal);
				continue;
			}
			if (this.openings(e) < ticket.members.length) {
				this.count("no-slot");
				continue;
			}
			const humans = e.roster.slots.filter((s) => s.kind === "human");
			const mean = humans.length ? humans.reduce((a, h) => a + h.rating.rating, 0) / humans.length : ticket.skill;
			let ping = 0;
			const host = humans.find((h) => h.playerId === e.roster.hostId);
			if (host) for (const m of ticket.members) ping = Math.max(ping, effectiveRtt(m.connection, host.connection));
			if (ping > this.policy.hardMaxPing) {
				this.count("ping");
				continue;
			}
			const overshoot = Math.max(0, ping - this.policy.maxPing);
			const cost = Math.abs(mean - ticket.skill) + ping * 1.5 + overshoot * 12 + (now - e.roster.formedAt) * .05;
			if (cost < bestCost) {
				bestCost = cost;
				best = e.roster.matchId;
			}
		}
		if (!best) this.count("match-unknown");
		return best;
	}
	openings(e) {
		let n = 0;
		for (let t = 0; t < e.def.teams; t++) {
			const slots = e.roster.slots.filter((s) => s.team === t);
			n += e.def.teamSize - slots.length + slots.filter((s) => s.kind === "bot").length;
		}
		return n;
	}
	count(r) {
		this.refusals.set(r, (this.refusals.get(r) ?? 0) + 1);
	}
	/**
	* Places a ticket into a live match, yielding bot slots as required. Returns
	* null when the match filled up between `findMatch` and here.
	*/
	place(matchId, ticket, now) {
		const e = this.matches.get(matchId);
		if (!e) return null;
		if (this.openings(e) < ticket.members.length) return null;
		const yieldedBots = [];
		const added = [];
		for (const m of ticket.members) {
			const team = teamForIncoming(e.roster, e.def);
			if (e.roster.slots.filter((s) => s.team === team).length >= e.def.teamSize) {
				const bot = chooseBotToYield(e.roster, team, m.rating.rating);
				if (!bot) return added.length ? {
					matchId,
					team,
					yieldedBots,
					added
				} : null;
				removeBot(e.roster, bot.botId);
				yieldedBots.push(bot.botId);
			}
			const slot = {
				kind: "human",
				playerId: m.playerId,
				name: m.name,
				team,
				rating: m.rating,
				connection: m.connection,
				partyId: ticket.partyId,
				joinedAt: now,
				backfilled: true
			};
			e.roster.slots.push(slot);
			added.push(slot);
			e.vacated.delete(m.playerId);
		}
		return {
			matchId,
			team: added[0]?.team ?? 0,
			yieldedBots,
			added
		};
	}
	/** Clears the grace clock for slots nobody reclaimed. */
	sweep(now) {
		for (const e of this.matches.values()) for (const [id, at] of e.vacated) if (now - at > this.policy.graceAfterLeave * 6) e.vacated.delete(id);
	}
};
//#endregion
//#region src/session/matchmaking/TeamBalance.ts
function balanceTeams(tickets, def) {
	const assignment = /* @__PURE__ */ new Map();
	const rejected = [];
	const buckets = [];
	for (let t = 0; t < def.teams; t++) buckets.push({
		team: t,
		count: 0,
		sum: 0
	});
	const order = [...tickets].sort((a, b) => {
		if (b.members.length !== a.members.length) return b.members.length - a.members.length;
		if (b.skill !== a.skill) return b.skill - a.skill;
		return a.id < b.id ? -1 : 1;
	});
	for (const ticket of order) {
		const size = ticket.members.length;
		let best = null;
		for (const bucket of buckets) {
			if (bucket.count + size > def.teamSize) continue;
			if (!best) {
				best = bucket;
				continue;
			}
			if (bucket.count < best.count) best = bucket;
			else if (bucket.count === best.count && bucket.sum < best.sum) best = bucket;
		}
		if (!best) {
			rejected.push(ticket);
			continue;
		}
		assignment.set(ticket.id, best.team);
		best.count += size;
		best.sum += ticket.skill * size;
	}
	if (def.teams === 2) improve(order, assignment, buckets);
	const means = buckets.map((b) => b.count > 0 ? b.sum / b.count : 0);
	return {
		assignment,
		means,
		delta: def.teams === 2 ? Math.abs(means[0] - means[1]) : 0,
		rejected
	};
}
/**
* Hill-climbing swaps between same-size parties. Capped at 64 passes: this is
* a 12-slot problem, it converges in two or three, and an unbounded loop in
* matchmaking is a hitch nobody will ever find.
*/
function improve(order, assignment, buckets) {
	const meanDelta = () => {
		const a = buckets[0].count > 0 ? buckets[0].sum / buckets[0].count : 0;
		const b = buckets[1].count > 0 ? buckets[1].sum / buckets[1].count : 0;
		return Math.abs(a - b);
	};
	for (let pass = 0; pass < 64; pass++) {
		let improved = false;
		for (let i = 0; i < order.length; i++) {
			const a = order[i];
			const ta = assignment.get(a.id);
			if (ta === void 0) continue;
			for (let j = i + 1; j < order.length; j++) {
				const b = order[j];
				const tb = assignment.get(b.id);
				if (tb === void 0 || tb === ta) continue;
				if (a.members.length !== b.members.length) continue;
				const before = meanDelta();
				const size = a.members.length;
				buckets[ta].sum += (b.skill - a.skill) * size;
				buckets[tb].sum += (a.skill - b.skill) * size;
				if (meanDelta() < before - 1e-6) {
					assignment.set(a.id, tb);
					assignment.set(b.id, ta);
					improved = true;
					break;
				}
				buckets[ta].sum -= (b.skill - a.skill) * size;
				buckets[tb].sum -= (a.skill - b.skill) * size;
			}
			if (improved) break;
		}
		if (!improved) return;
	}
}
/** Party skill: mean rating, pulled toward the best member. */
function partySkill(ratings) {
	if (ratings.length === 0) return 1500;
	const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
	const best = Math.max(...ratings);
	return mean * .75 + best * .25;
}
//#endregion
//#region src/session/matchmaking/Queue.ts
function ticketRegion(t) {
	return ticketConnection(t).region;
}
/** The party leader's connection stands in for the party when bucketing. */
function ticketConnection(t) {
	return (t.members.find((m) => m.playerId === t.leaderId) ?? t.members[0]).connection;
}
var MatchQueue = class {
	rng;
	opts;
	tickets = /* @__PURE__ */ new Map();
	byPlaylist = /* @__PURE__ */ new Map();
	/** EMA of ticket arrivals per second, per playlist — drives the ETA. */
	arrivalRate = /* @__PURE__ */ new Map();
	lastArrival = /* @__PURE__ */ new Map();
	matchSeq = 0;
	constructor(rng, opts = {}) {
		this.rng = rng;
		this.opts = opts;
	}
	get size() {
		return this.tickets.size;
	}
	get(id) {
		return this.tickets.get(id);
	}
	all() {
		return [...this.tickets.values()];
	}
	countFor(id) {
		return this.byPlaylist.get(id)?.size ?? 0;
	}
	enqueue(ticket) {
		this.tickets.set(ticket.id, ticket);
		let set = this.byPlaylist.get(ticket.playlist);
		if (!set) {
			set = /* @__PURE__ */ new Set();
			this.byPlaylist.set(ticket.playlist, set);
		}
		set.add(ticket.id);
		const last = this.lastArrival.get(ticket.playlist);
		if (last !== void 0 && ticket.joinedAt > last) {
			const inst = 1 / Math.max(.05, ticket.joinedAt - last);
			const prev = this.arrivalRate.get(ticket.playlist) ?? inst;
			this.arrivalRate.set(ticket.playlist, prev * .8 + inst * .2);
		}
		this.lastArrival.set(ticket.playlist, ticket.joinedAt);
	}
	remove(id) {
		const t = this.tickets.get(id);
		if (!t) return void 0;
		this.tickets.delete(id);
		this.byPlaylist.get(t.playlist)?.delete(id);
		return t;
	}
	clear() {
		this.tickets.clear();
		this.byPlaylist.clear();
	}
	/** Playlist widening params with any live-ops override folded in. */
	paramsFor(def) {
		const base = wideningFor(def);
		return this.opts.widening ? {
			...base,
			...this.opts.widening
		} : base;
	}
	status(id, now) {
		const ticket = this.tickets.get(id);
		if (!ticket) return null;
		const def = playlist(ticket.playlist);
		const windows = windowsForTicket(ticket, now, this.paramsFor(def));
		const candidates = this.poolFor(ticket, now, def).reduce((n, c) => n + c.ticket.members.length, 0);
		return {
			ticket,
			windows,
			candidates,
			estimate: this.estimate(ticket, def, windows, candidates, now)
		};
	}
	/**
	* Honest ETA: how long until enough compatible players have arrived, capped
	* by the moment bots arm (because that is a guaranteed launch). Returns -1
	* when there is no arrival history to extrapolate from.
	*/
	estimate(ticket, def, w, candidates, now) {
		const capacity = slotCount(def);
		const have = ticket.members.length + candidates;
		const params = this.paramsFor(def);
		const botsIn = def.allowBots ? Math.max(0, params.botFillAfter - (now - ticket.joinedAt)) : Infinity;
		if (have >= capacity) return 0;
		const rate = this.arrivalRate.get(ticket.playlist) ?? 0;
		if (rate <= 0) return Number.isFinite(botsIn) ? botsIn : -1;
		const eta = (capacity - have) / (rate * 1.35);
		return Math.min(eta, Number.isFinite(botsIn) ? botsIn : eta);
	}
	/**
	* Forms as many matches as it can. Returns the proposals; removes the tickets.
	*
	* The oldest ticket is always tried first — it has the widest windows and the
	* strongest claim — but when it *cannot* form, the pass moves down the list
	* and tries the next one instead of abandoning the playlist for this tick.
	*
	* Skipping that fallback is a head-of-line stall, and it is subtle because it
	* only bites once the queue starts holding out for humans. One apac player at
	* the head of a queue full of eu-west players blocks every match in the
	* playlist until they hit the 120 s hard timeout, at which point they launch a
	* bot lobby and the next unlucky seed inherits the block. Measured cost in the
	* 500-player sim: median queue 75 s instead of 20 s, and a bot-fill rate that
	* stayed pinned near 45% no matter how large the population grew — the
	* giveaway, since a genuine supply problem gets better when you add players.
	*/
	tick(now) {
		const out = [];
		const limit = this.opts.maxMatchesPerTick ?? 8;
		const seedBudget = this.opts.maxSeedsPerTick ?? 32;
		for (const id of this.byPlaylist.keys()) {
			let formed = 0;
			let seedIndex = 0;
			let tried = 0;
			while (formed < limit && tried < seedBudget) {
				const list = this.ordered(id);
				if (seedIndex >= list.length) break;
				tried++;
				const proposal = this.tryForm(list[seedIndex], id, now);
				if (proposal) {
					out.push(proposal);
					formed++;
					seedIndex = 0;
				} else seedIndex++;
			}
		}
		return out;
	}
	ordered(id) {
		const set = this.byPlaylist.get(id);
		if (!set || set.size === 0) return [];
		const list = [];
		for (const tid of set) {
			const t = this.tickets.get(tid);
			if (t) list.push(t);
		}
		list.sort((a, b) => {
			if (b.priority !== a.priority) return b.priority - a.priority;
			if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
			return a.id < b.id ? -1 : 1;
		});
		return list;
	}
	/**
	* Candidate tickets compatible with `seed` right now, best fit first.
	*
	* "Best fit" is a *normalised* blend of the two axes rather than skill alone.
	* Ordering purely on rating distance is what produced 142 ms mean lobbies in
	* the population sim: the greedy accumulator would happily reach across an
	* ocean for a player 3 rating points closer, and once eleven such players are
	* seated the host election has nothing good left to pick from. Dividing each
	* distance by the window that currently admits it makes them comparable —
	* "how much of my skill budget does this cost" versus "how much of my latency
	* budget" — so a marginally worse skill fit next door beats a perfect one
	* three regions away, which is the trade a player would make themselves.
	*/
	poolFor(seed, now, def) {
		const params = this.paramsFor(def);
		const seedW = windowsForTicket(seed, now, params);
		const seedRegion = ticketRegion(seed);
		const seedConn = ticketConnection(seed);
		const out = [];
		for (const t of this.ordered(def.id)) {
			if (t.id === seed.id) continue;
			const w = mutualWindows(seedW, windowsForTicket(t, now, params));
			const dSkill = Math.abs(t.skill - seed.skill);
			if (dSkill > w.skill) continue;
			if (!w.crossRegion && ticketRegion(t) !== seedRegion) continue;
			const dPing = effectiveRtt(ticketConnection(t), seedConn);
			const cost = dSkill / Math.max(1, w.skill) + dPing / Math.max(1, w.ping);
			out.push({
				ticket: t,
				windows: w,
				cost
			});
		}
		out.sort((a, b) => a.cost !== b.cost ? a.cost - b.cost : a.ticket.joinedAt - b.ticket.joinedAt);
		return out;
	}
	/**
	* Ticket arrivals per second, aged. The raw EMA only moves when a ticket
	* arrives, so a playlist that has gone quiet keeps reporting the rate it had
	* before everyone left — and the launch gate below would then hold a lobby
	* open waiting for humans who are not coming. Dividing by the drought length
	* makes "nobody has queued for 30 s" read as the near-zero supply it is.
	*/
	arrivalsPerSecond(id, now) {
		const raw = this.arrivalRate.get(id) ?? 0;
		if (raw <= 0) return 0;
		const last = this.lastArrival.get(id);
		if (last === void 0) return 0;
		return raw / (1 + Math.max(0, now - last) / 10);
	}
	/** Mean party size currently queued for a playlist, floored at 1. */
	meanPartySize(id) {
		const set = this.byPlaylist.get(id);
		if (!set || set.size === 0) return 1;
		let n = 0;
		for (const tid of set) n += this.tickets.get(tid)?.members.length ?? 0;
		return Math.max(1, n / set.size);
	}
	tryForm(seed, id, now) {
		if (!seed) return null;
		const def = playlist(id);
		const params = this.paramsFor(def);
		const capacity = slotCount(def);
		const seedW = windowsForTicket(seed, now, params);
		if (seed.members.length > capacity) {
			this.remove(seed.id);
			return null;
		}
		const bins = new Array(def.teams).fill(def.teamSize);
		if (!seatParty(bins, seed.members.length)) {
			this.remove(seed.id);
			return null;
		}
		const group = [seed];
		let humans = seed.members.length;
		let members = seed.members.map((m) => ({
			playerId: m.playerId,
			connection: m.connection
		}));
		for (const cand of this.poolFor(seed, now, def)) {
			if (humans >= capacity) break;
			const t = cand.ticket;
			const size = t.members.length;
			if (!bins.some((b) => b >= size)) continue;
			const merged = members.concat(t.members.map((m) => ({
				playerId: m.playerId,
				connection: m.connection
			})));
			const host = selectHost(merged, merged.length - 1);
			if (host.hostId && host.worstPing > cand.windows.ping && !cand.windows.desperate) continue;
			if (!seatParty(bins, size)) continue;
			group.push(t);
			members = merged;
			humans += size;
		}
		const full = humans >= capacity;
		const canBotFill = def.allowBots && (seedW.botFill || seedW.desperate);
		const demand = humansRequired(seedW.waited, capacity, def.minHumansToStart, params);
		const remaining = Math.max(0, params.hardTimeout - seedW.waited);
		const inbound = this.arrivalsPerSecond(def.id, now) * this.meanPartySize(def.id) * remaining;
		const supply = Math.min(capacity, Math.floor(humans + inbound));
		const need = Math.max(def.minHumansToStart, Math.min(demand, supply));
		const ready = canBotFill && humans >= need;
		const forced = seedW.desperate && humans >= def.minHumansToStart;
		if (!full && !ready && !forced) return null;
		for (const t of group) this.remove(t.id);
		return this.buildProposal(group, def, now, seedW);
	}
	buildProposal(group, def, now, seedW) {
		const balance = balanceTeams(group, def);
		for (const r of balance.rejected) this.enqueue(r);
		const placed = group.filter((t) => balance.assignment.has(t.id));
		const roster = {
			matchId: `m:${++this.matchSeq}`,
			playlist: def.id,
			mode: def.mode,
			teamSize: def.teamSize,
			teams: def.teams,
			slots: [],
			hostId: null,
			formedAt: now,
			seed: this.rng.u32()
		};
		for (const t of placed) {
			const team = balance.assignment.get(t.id) ?? 0;
			for (const m of t.members) {
				const slot = {
					kind: "human",
					playerId: m.playerId,
					name: m.name,
					team,
					rating: m.rating,
					connection: m.connection,
					partyId: t.partyId,
					joinedAt: now,
					backfilled: t.kind === "backfill"
				};
				roster.slots.push(slot);
			}
		}
		const candidates = roster.slots.filter((s) => s.kind === "human").map((s) => ({
			playerId: s.playerId,
			connection: s.connection
		}));
		roster.hostId = selectHost(candidates, Math.max(0, candidates.length - 1)).hostId;
		fillRoster(roster, def, this.rng, now, { maxPerTeam: this.opts.maxBotsPerTeam });
		return {
			roster,
			quality: qualityOf(roster, now, placed.map((t) => now - t.joinedAt), seedW.waited),
			ticketIds: placed.map((t) => t.id)
		};
	}
};
/**
* Seats a party of `size` in the emptiest team that can hold it, mutating
* `bins`. Returns false when no team has room. Emptiest-first mirrors
* `balanceTeams`, so the packing the accumulator assumes is the packing the
* assignment step actually finds.
*/
function seatParty(bins, size) {
	let best = -1;
	for (let i = 0; i < bins.length; i++) {
		if (bins[i] < size) continue;
		if (best < 0 || bins[i] > bins[best]) best = i;
	}
	if (best < 0) return false;
	bins[best] -= size;
	return true;
}
function qualityOf(roster, _now, waits, seedWait) {
	const humans = roster.slots.filter((s) => s.kind === "human");
	const ratings = humans.map((h) => h.rating.rating);
	const bots = roster.slots.length - humans.length;
	const pings = pingsToHost(humans.map((h) => ({
		playerId: h.playerId,
		connection: h.connection
	})), roster.hostId);
	const teamMeans = [];
	for (let t = 0; t < roster.teams; t++) {
		const slots = roster.slots.filter((s) => s.team === t);
		teamMeans.push(slots.length ? slots.reduce((a, s) => a + (s.kind === "human" ? s.rating.rating : s.rating), 0) / slots.length : 0);
	}
	return {
		skillSpread: ratings.length > 1 ? Math.max(...ratings) - Math.min(...ratings) : 0,
		teamDelta: roster.teams === 2 ? Math.abs(teamMeans[0] - teamMeans[1]) : 0,
		meanPing: pings.length ? pings.reduce((a, b) => a + b, 0) / pings.length : 0,
		worstPing: pings.length ? Math.max(...pings) : 0,
		humans: humans.length,
		bots,
		seedWait,
		waits: [...waits].sort((a, b) => b - a)
	};
}
//#endregion
//#region src/session/matchmaking/Rating.ts
/** Glicko-2 internal scale factor. */
const SCALE = 173.7178;
/** System constant τ — how much volatility is allowed to move per period.
*  0.5 is the recommended value; lower makes the system placid, higher makes it
*  jumpy. A shooter with high per-match variance wants the placid end. */
const TAU = .5;
const EPS = 1e-6;
const RATING_DEFAULT = 1500;
const RD_DEFAULT = 350;
const RD_MIN = 45;
const RD_MAX = 350;
const VOL_DEFAULT = .06;
/** Seconds in a nominal rating period (one day) for idle RD inflation. */
const PERIOD_SECONDS = 86400;
/** c chosen so a fully-known player (RD 45) returns to RD_MAX after ~1 year idle. */
const C = Math.sqrt((350 * 350 - 2025) / 365);
function newRating(rating = RATING_DEFAULT, rd = 350) {
	return {
		rating,
		rd,
		vol: VOL_DEFAULT,
		matches: 0,
		lastPlayed: 0
	};
}
/**
* Seeds a rating from progression rank. Rank is weak evidence — it measures
* time played far more than skill — so it moves the mean a little and leaves
* RD almost untouched.
*/
function ratingFromRank(rank) {
	return {
		rating: clamp$1(RATING_DEFAULT + (rank - 8) * 7, 1380, 1760),
		rd: 320,
		vol: VOL_DEFAULT,
		matches: 0,
		lastPlayed: 0
	};
}
function g(phi) {
	return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));
}
/** Probability that `a` beats `b`, on the display scale. */
function expectedScore(a, b) {
	const mu = (a.rating - RATING_DEFAULT) / SCALE;
	const muj = (b.rating - RATING_DEFAULT) / SCALE;
	const phij = b.rd / SCALE;
	return 1 / (1 + Math.exp(-g(phij) * (mu - muj)));
}
/**
* Conservative skill used for *bucketing*: rating minus one RD. Two players
* with the same rating but different certainty should not be treated as
* interchangeable, and pessimism is the right bias — it keeps unknown players
* out of the top brackets until they prove they belong there.
*/
function conservativeSkill(r) {
	return r.rating - r.rd * .5;
}
/** Inflates RD for time spent away. `now` and `lastPlayed` are seconds. */
function decayed(r, now) {
	if (r.matches === 0 || now <= r.lastPlayed) return r;
	const periods = (now - r.lastPlayed) / PERIOD_SECONDS;
	if (periods < .5) return r;
	const rd = Math.min(350, Math.sqrt(r.rd * r.rd + C * C * periods));
	return {
		...r,
		rd
	};
}
/**
* Runs one Glicko-2 rating period. `games` empty means "played nothing" and
* only inflates RD, which is what the algorithm prescribes.
*/
function updateRating(r, games, now) {
	const mu = (r.rating - RATING_DEFAULT) / SCALE;
	const phi = r.rd / SCALE;
	const sigma = r.vol;
	if (games.length === 0) {
		const phiStar = Math.sqrt(phi * phi + sigma * sigma);
		return {
			...r,
			rd: clamp$1(phiStar * SCALE, 45, 350)
		};
	}
	let vInv = 0;
	let delSum = 0;
	for (const game of games) {
		const muj = (game.opponent.rating - RATING_DEFAULT) / SCALE;
		const gj = g(game.opponent.rd / SCALE);
		const e = 1 / (1 + Math.exp(-gj * (mu - muj)));
		vInv += gj * gj * e * (1 - e);
		delSum += gj * (game.score - e);
	}
	if (vInv <= 0) return {
		...r,
		matches: r.matches + 1,
		lastPlayed: now
	};
	const v = 1 / vInv;
	const sigmaPrime = solveVolatility(phi, v, v * delSum, sigma);
	const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
	const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + vInv);
	return {
		rating: (mu + phiPrime * phiPrime * delSum) * SCALE + RATING_DEFAULT,
		rd: clamp$1(phiPrime * SCALE, 45, 350),
		vol: sigmaPrime,
		matches: r.matches + 1,
		lastPlayed: now
	};
}
/** Illinois-variant regula falsi from the Glicko-2 paper. Converges in <15 steps. */
function solveVolatility(phi, v, delta, sigma) {
	const a = Math.log(sigma * sigma);
	const d2 = delta * delta;
	const phi2 = phi * phi;
	const f = (x) => {
		const ex = Math.exp(x);
		const denom = phi2 + v + ex;
		return ex * (d2 - phi2 - v - ex) / (2 * denom * denom) - (x - a) / (TAU * TAU);
	};
	let A = a;
	let B;
	if (d2 > phi2 + v) B = Math.log(d2 - phi2 - v);
	else {
		let k = 1;
		while (f(a - k * TAU) < 0 && k < 100) k++;
		B = a - k * TAU;
	}
	let fa = f(A);
	let fb = f(B);
	let guard = 0;
	while (Math.abs(B - A) > EPS && guard++ < 200) {
		const C0 = A + (A - B) * fa / (fb - fa);
		const fc = f(C0);
		if (fc * fb <= 0) {
			A = B;
			fa = fb;
		} else fa /= 2;
		B = C0;
		fb = fc;
	}
	const out = Math.exp(A / 2);
	return Number.isFinite(out) ? clamp$1(out, .01, .35) : sigma;
}
/**
* Blends the team result with individual contribution into a Glicko score.
*
* Pure win/loss is far too noisy to rate an individual in a 12-player lobby:
* you are one sixth of your team, and matchmaking is actively trying to make
* the other five cancel out the enemy's five, so the outcome converges on a
* coin flip *by design*. The more successful the matchmaker, the less a win
* tells you about the winner. Most of the signal therefore has to come from how
* far above or below the lobby mean the player scored.
*
* Two things scale that split:
*
*  - **Match length.** A quit-out or a stomp carries less individual signal, so
*    short matches lean back on the result.
*  - **How human the player's team was.** A win beside five bots is a fact
*    about the bots. `teamHumanFraction` pushes weight onto individual
*    performance as the team fills with them — worth r = 0.44 → 0.79 against
*    ground-truth skill in the population sim.
*
* The logistic keeps a 3× score from being worth 3× the credit; a carry gets
* ~0.9 on a win and ~0.5 even on a loss, which is exactly the behaviour players
* expect from "you played well, you lost".
*/
function performanceScore(p) {
	const team = p.drawn ? .5 : p.won ? 1 : 0;
	const mean = Math.max(1, p.lobbyMeanScore);
	const rel = (p.combatScore - mean) / (mean * .35);
	const perf = 1 / (1 + Math.exp(-rel));
	const perfWeight = clamp$1((p.durationSec > 0 ? clamp$1(p.durationSec / 240, .35, 1) : 1) * (.55 + .3 * (1 - clamp$1(p.teamHumanFraction ?? 1, 0, 1))), 0, .95);
	return clamp$1(team * (1 - perfWeight) + perf * perfWeight, .02, .98);
}
/**
* Applies one match to a player record. `opponents` are the enemy team's
* ratings; in co-op playlists pass the bot team's notional ratings so the
* result still moves — slowly, because bot ratings carry RD 200.
*/
function applyMatch(rec, opponents, perf, now) {
	const before = rec.rating.rating;
	const score = performanceScore(perf);
	rec.rating = updateRating(decayed(rec.rating, now), opponents.map((o) => ({
		opponent: o,
		score
	})), now);
	if (perf.won) rec.wins++;
	else if (!perf.drawn) rec.losses++;
	const spm = perf.durationSec > 0 ? perf.combatScore / perf.durationSec * 60 : perf.combatScore;
	rec.avgScorePerMin = rec.avgScorePerMin === 0 ? spm : rec.avgScorePerMin * .8 + spm * .2;
	return {
		before,
		after: rec.rating.rating,
		delta: rec.rating.rating - before
	};
}
function clamp$1(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}
//#endregion
//#region src/session/matchmaking/Store.ts
/**
* Local persistence for matchmaking records.
*
* Same shape and defensiveness as `src/game/Progression.ts`: one JSON blob in
* localStorage, every field validated on the way in, a corrupt store silently
* yields fresh records. Ratings live here until there is a service to own them
* — when one appears, `RatingStore` becomes its cache and only `load`/`save`
* change.
*
* The store holds the *local* player plus every peer we have seen, because
* rating a match needs the opponents' ratings and the host may not have them
* to hand for a player who just left.
*/
const STORAGE_KEY = "blackout.mm.v1";
const MAX_PEERS = 400;
function defaultRecord(id, name, region) {
	return {
		id,
		name,
		region,
		rating: newRating(),
		rank: 1,
		avgScorePerMin: 0,
		wins: 0,
		losses: 0,
		quits: 0
	};
}
var RatingStore = class {
	storage;
	records = /* @__PURE__ */ new Map();
	localId = "local";
	constructor(storage = safeStorage()) {
		this.storage = storage;
	}
	setStorage(storage) {
		this.storage = storage;
	}
	load() {
		if (!this.storage) return;
		try {
			const raw = this.storage.getItem(STORAGE_KEY);
			if (!raw) return;
			const data = JSON.parse(raw);
			if (typeof data.localId === "string" && data.localId) this.localId = data.localId;
			if (!Array.isArray(data.records)) return;
			for (const r of data.records.slice(0, MAX_PEERS)) {
				const rec = sanitise(r);
				if (rec) this.records.set(rec.id, rec);
			}
		} catch {}
	}
	save() {
		if (!this.storage) return;
		try {
			const all = [...this.records.values()];
			const local = all.filter((r) => r.id === this.localId);
			const peers = all.filter((r) => r.id !== this.localId).sort((a, b) => b.rating.matches - a.rating.matches).slice(0, MAX_PEERS - local.length);
			const blob = {
				version: 1,
				localId: this.localId,
				records: [...local, ...peers]
			};
			this.storage.setItem(STORAGE_KEY, JSON.stringify(blob));
		} catch {}
	}
	get(id) {
		return this.records.get(id);
	}
	has(id) {
		return this.records.has(id);
	}
	/** Fetches or creates a record. New records seed their rating from rank. */
	ensure(id, name, region, rank = 1) {
		const found = this.records.get(id);
		if (found) {
			if (name && found.name !== name) found.name = name;
			if (rank > found.rank) found.rank = rank;
			return found;
		}
		const rec = defaultRecord(id, name || id, region);
		rec.rank = Math.max(1, Math.floor(rank));
		if (rec.rank > 1) rec.rating = ratingFromRank(rec.rank);
		this.records.set(id, rec);
		return rec;
	}
	put(rec) {
		this.records.set(rec.id, rec);
	}
	/** Rating for an id we may never have met — an unrated 1500/350 by default. */
	ratingOf(id) {
		return this.records.get(id)?.rating ?? newRating();
	}
	all() {
		return [...this.records.values()];
	}
	get size() {
		return this.records.size;
	}
	setLocal(id) {
		this.localId = id;
	}
	local() {
		return this.records.get(this.localId) ?? this.ensure(this.localId, "Player", "na-east");
	}
	clear() {
		this.records.clear();
		try {
			this.storage?.removeItem(STORAGE_KEY);
		} catch {}
	}
};
function num(v, fallback, lo, hi) {
	return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}
function sanitise(raw) {
	if (!raw || typeof raw !== "object") return null;
	const r = raw;
	if (typeof r.id !== "string" || !r.id) return null;
	const region = typeof r.region === "string" && REGIONS.includes(r.region) ? r.region : "na-east";
	const rec = defaultRecord(r.id, typeof r.name === "string" ? r.name : r.id, region);
	rec.rank = num(r.rank, 1, 1, 100);
	rec.avgScorePerMin = num(r.avgScorePerMin, 0, 0, 1e5);
	rec.wins = num(r.wins, 0, 0, 1e7);
	rec.losses = num(r.losses, 0, 0, 1e7);
	rec.quits = num(r.quits, 0, 0, 1e7);
	const rt = r.rating ?? {};
	rec.rating = {
		rating: num(rt.rating, RATING_DEFAULT, 100, 4e3),
		rd: num(rt.rd, 350, 20, 350),
		vol: num(rt.vol, VOL_DEFAULT, .005, .4),
		matches: num(rt.matches, 0, 0, 1e7),
		lastPlayed: num(rt.lastPlayed, 0, 0, 0x9184e72a000)
	};
	return rec;
}
function safeStorage() {
	try {
		const s = globalThis.localStorage;
		if (!s) return null;
		s.setItem("blackout.mm.probe", "1");
		s.removeItem("blackout.mm.probe");
		return s;
	} catch {
		return null;
	}
}
//#endregion
//#region src/session/matchmaking/Transport.ts
var LoopbackTransport = class {
	localPlayerId;
	isHost = true;
	subs = /* @__PURE__ */ new Set();
	constructor(localPlayerId = "local") {
		this.localPlayerId = localPlayerId;
	}
	send(msg) {
		for (const fn of [...this.subs]) try {
			fn(msg, this.localPlayerId);
		} catch (err) {
			console.error("[mm] transport handler threw", err);
		}
	}
	subscribe(fn) {
		this.subs.add(fn);
		return () => {
			this.subs.delete(fn);
		};
	}
};
/** In-memory star topology: every client talks only to the host. */
var TransportHub = class {
	hostId;
	subs = /* @__PURE__ */ new Map();
	/** Every message that crossed the wire — the tool asserts on this. */
	traffic = [];
	constructor(hostId) {
		this.hostId = hostId;
	}
	transportFor(playerId) {
		const hub = this;
		return {
			isHost: playerId === hub.hostId,
			localPlayerId: playerId,
			send(msg) {
				hub.route(playerId, msg);
			},
			subscribe(fn) {
				let set = hub.subs.get(playerId);
				if (!set) {
					set = /* @__PURE__ */ new Set();
					hub.subs.set(playerId, set);
				}
				set.add(fn);
				return () => {
					set.delete(fn);
				};
			}
		};
	}
	route(from, msg) {
		this.traffic.push({
			from,
			msg
		});
		if (from === this.hostId) for (const [id, set] of this.subs) {
			if (id === this.hostId) continue;
			for (const fn of [...set]) fn(msg, from);
		}
		else for (const fn of [...this.subs.get(this.hostId) ?? []]) fn(msg, from);
	}
};
//#endregion
//#region src/session/matchmaking/Service.ts
/**
* MatchmakingService — the authority-aware facade.
*
* ## Who decides what
*
* ```
*   client                      host
*   ------                      ----
*   requestJoin()  ──queue:join──▶ admit() → MatchQueue
*                  ◀ticket:update─ (broadcast, every tick)
*                  ◀─match:found── proposal
*                  ◀roster:update─ bot fill / bot yield / backfill
* ```
*
* A client's `requestJoin` never touches the local queue — it emits a message
* and waits. `snapshot().mirrored` is true on a client so the UI can be honest
* about showing host state. The host rebuilds every incoming ticket from *its
* own* rating store where it knows the player, and only trusts the claimed
* rating for someone it has never seen; a client cannot lie its way into a
* softer lobby beyond one match.
*
* The service owns no clock. Call `update(now)` from wherever the session
* layer's tick lives (`now` in seconds, monotonic).
*/
var MatchmakingService = class {
	queue;
	backfill;
	store;
	rng;
	/** Proposals formed this tick, for callers that poll instead of listening. */
	pending = [];
	transport;
	emit;
	unsub;
	ticketSeq = 0;
	state = "idle";
	localTicket = null;
	localPlaylist = null;
	mirror = {};
	currentRoster = null;
	now = 0;
	joinInProgressAfter;
	constructor(opts = {}) {
		this.transport = opts.transport ?? new LoopbackTransport();
		this.store = opts.store ?? new RatingStore();
		this.emit = opts.emit ?? (() => {});
		this.rng = new Rand(opts.seed ?? 6221079);
		this.queue = new MatchQueue(this.rng, opts.queue);
		this.backfill = new BackfillManager(opts.backfill);
		this.joinInProgressAfter = opts.joinInProgressAfter ?? 8;
		this.store.setLocal(this.transport.localPlayerId);
		this.unsub = this.transport.subscribe((msg, from) => this.onMessage(msg, from));
	}
	get isHost() {
		return this.transport.isHost;
	}
	get localPlayerId() {
		return this.transport.localPlayerId;
	}
	get queueState() {
		return this.state;
	}
	get roster() {
		return this.currentRoster;
	}
	dispose() {
		this.unsub();
	}
	/**
	* Local player (and their party) want a match. On the host this enqueues
	* immediately; on a client it sends a request and returns null.
	*/
	requestJoin(playlist, party, now = this.now) {
		const members = party ?? [{
			playerId: this.localPlayerId,
			name: this.store.local().name
		}];
		this.localPlaylist = playlist;
		this.state = "searching";
		if (this.isHost) {
			const ticket = this.admit(members, playlist, now);
			this.localTicket = ticket.id;
			this.publishTicket(ticket, now);
			return ticket.id;
		}
		const ticket = this.buildTicket(members, playlist, now, "fresh");
		this.localTicket = ticket.id;
		this.transport.send({
			t: "queue:join",
			ticket
		});
		return null;
	}
	leaveQueue() {
		const id = this.localTicket;
		this.localTicket = null;
		this.state = "idle";
		if (!id) return;
		if (this.isHost) this.queue.remove(id);
		else this.transport.send({
			t: "queue:leave",
			ticketId: id
		});
		this.emit("mm:queue:left", {
			ticketId: id,
			reason: "player"
		});
	}
	/** Host-only: turns a party into a queue ticket using host-side ratings. */
	admit(party, playlist, now = this.now, kind = "fresh") {
		const ticket = this.buildTicket(party, playlist, now, kind);
		this.queue.enqueue(ticket);
		return ticket;
	}
	buildTicket(party, playlist, now, kind) {
		const members = party.map((p) => {
			const known = this.store.get(p.playerId);
			const conn = p.connection ?? defaultConnection(known?.region ?? "na-east");
			const rec = this.store.ensure(p.playerId, p.name, conn.region, p.rank ?? 1);
			if (p.rating && rec.rating.matches === 0 && !known) rec.rating = { ...p.rating };
			return {
				playerId: p.playerId,
				name: p.name || rec.name,
				rating: rec.rating,
				connection: conn,
				rank: p.rank ?? rec.rank
			};
		});
		const skills = members.map((m) => m.rating.rating);
		return {
			id: `t:${++this.ticketSeq}`,
			partyId: `p:${members[0]?.playerId ?? "anon"}`,
			leaderId: members[0]?.playerId ?? "anon",
			members,
			playlist,
			kind,
			joinedAt: now,
			priority: kind === "fresh" ? 0 : 10,
			skill: partySkill(skills),
			rd: members.reduce((a, m) => Math.max(a, m.rating.rd), 0)
		};
	}
	/** Host: run the queue. Client: refresh the local mirror's wait time. */
	update(now) {
		this.now = now;
		this.pending.length = 0;
		if (!this.isHost) return this.pending;
		this.backfill.sweep(now);
		this.topUpBots(now);
		this.serveBackfill(now);
		const proposals = this.queue.tick(now);
		for (const p of proposals) {
			this.pending.push(p);
			this.emit("mm:match:found", { proposal: p });
			this.emit("mm:botfill", {
				matchId: p.roster.matchId,
				added: p.quality.bots,
				humans: p.quality.humans,
				bots: p.quality.bots
			});
			this.emit("mm:host:elected", {
				matchId: p.roster.matchId,
				hostId: p.roster.hostId,
				worstPing: p.quality.worstPing
			});
			this.transport.send({
				t: "match:found",
				proposal: p
			});
			if (this.localTicket && p.ticketIds.includes(this.localTicket)) {
				this.state = "found";
				this.currentRoster = p.roster;
				this.localTicket = null;
			}
		}
		if (this.localTicket) {
			const t = this.queue.get(this.localTicket);
			if (t) this.publishTicket(t, now);
		}
		return this.pending;
	}
	publishTicket(ticket, now) {
		const status = this.queue.status(ticket.id, now);
		if (!status) return;
		this.emit("mm:queue:state", {
			state: this.state,
			playlist: ticket.playlist,
			waited: status.windows.waited,
			skillWindow: status.windows.skill,
			pingWindow: status.windows.ping,
			crossRegion: status.windows.crossRegion,
			botFillArmed: status.windows.botFill,
			candidates: status.candidates
		});
		this.emit("mm:queue:estimate", {
			seconds: status.estimate,
			confident: status.estimate >= 0
		});
		this.transport.send({
			t: "ticket:update",
			ticketId: ticket.id,
			waited: status.windows.waited,
			skillWindow: status.windows.skill,
			pingWindow: status.windows.ping,
			candidates: status.candidates,
			estimate: status.estimate
		});
	}
	/**
	* Any slot a leaver vacated becomes a bot once the grace window expires, so
	* a 6v6 never becomes a 6v4. The bot yields again the moment a human lands.
	*/
	topUpBots(now) {
		for (const need of this.backfill.needs(now)) {
			const roster = this.backfill.rosterOf(need.matchId);
			if (!roster) continue;
			const def = playlist(roster.playlist);
			const before = roster.slots.length;
			if (fillRoster(roster, def, this.rng, now).added.length === 0) continue;
			this.emit("mm:backfill:need", {
				matchId: need.matchId,
				team: need.team,
				count: need.count
			});
			this.emit("mm:botfill", {
				matchId: need.matchId,
				added: roster.slots.length - before,
				humans: roster.slots.filter((s) => s.kind === "human").length,
				bots: roster.slots.filter((s) => s.kind === "bot").length
			});
			this.broadcastRoster(roster);
		}
	}
	/** Places waiting tickets into live matches that will take them. */
	serveBackfill(now) {
		if (this.backfill.size === 0) return;
		for (const ticket of this.queue.all()) {
			const waited = now - ticket.joinedAt;
			if (ticket.kind === "fresh" && waited < this.joinInProgressAfter) continue;
			const matchId = this.backfill.findMatch(ticket, now);
			if (!matchId) continue;
			const placement = this.backfill.place(matchId, ticket, now);
			if (!placement) continue;
			this.queue.remove(ticket.id);
			const roster = this.backfill.rosterOf(matchId);
			const view = this.backfill.viewOf(matchId);
			for (const botId of placement.yieldedBots) {
				const forPlayer = placement.added[0]?.playerId ?? ticket.leaderId;
				this.emit("mm:bot:yield", {
					matchId,
					botId,
					botName: botId,
					forPlayer,
					team: placement.team
				});
				this.transport.send({
					t: "bot:yield",
					matchId,
					botId,
					forPlayer
				});
			}
			for (const slot of placement.added) this.emit("mm:backfill:joined", {
				matchId,
				playerId: slot.playerId,
				team: slot.team,
				late: !!view && view.duration > 0 && view.elapsed / view.duration > .35
			});
			if (roster) this.broadcastRoster(roster);
			if (this.localTicket === ticket.id) {
				this.localTicket = null;
				this.state = "in-match";
				this.currentRoster = roster ?? null;
			}
		}
	}
	registerMatch(roster, view) {
		this.backfill.register(roster, view);
	}
	updateMatch(view) {
		this.backfill.update(view);
	}
	/** A human dropped. Their slot is held briefly, then filled with a bot. */
	reportPlayerLeft(matchId, playerId, now = this.now) {
		if (!this.backfill.playerLeft(matchId, playerId, now)) return;
		const roster = this.backfill.rosterOf(matchId);
		if (!roster) return;
		const rec = this.store.get(playerId);
		if (rec) rec.quits++;
		this.emit("mm:roster:update", { roster });
		this.broadcastRoster(roster);
	}
	endMatch(matchId) {
		const roster = this.backfill.end(matchId);
		if (this.currentRoster?.matchId === matchId) {
			this.currentRoster = null;
			this.state = "idle";
		}
		return roster;
	}
	/**
	* Rates a finished match. Every human is scored against each opposing slot;
	* bots contribute as RD-200 opponents so a lobby full of them still moves a
	* rating, just slowly and with little confidence gained.
	*/
	submitResult(report, now = this.now) {
		const roster = this.backfill.rosterOf(report.matchId) ?? this.currentRoster;
		if (!roster || roster.matchId !== report.matchId) return;
		const scoreOf = new Map(report.scores.map((s) => [s.playerId, s.combatScore]));
		const humans = roster.slots.filter((s) => s.kind === "human");
		const lobbyMean = report.scores.length ? report.scores.reduce((a, s) => a + s.combatScore, 0) / report.scores.length : 1;
		for (const h of humans) {
			const rec = this.store.ensure(h.playerId, h.name, h.connection.region);
			const opponents = [];
			for (const s of roster.slots) {
				if (s.team === h.team) continue;
				opponents.push(s.kind === "human" ? s.rating : {
					rating: s.rating,
					rd: 200,
					vol: .06,
					matches: 50,
					lastPlayed: now
				});
			}
			if (opponents.length === 0) {
				const bots = roster.slots.filter((s) => s.kind === "bot");
				const mean = bots.length ? bots.reduce((a, s) => a + (s.kind === "bot" ? s.rating : 0), 0) / bots.length : 1500;
				opponents.push({
					rating: mean,
					rd: 250,
					vol: .06,
					matches: 30,
					lastPlayed: now
				});
			}
			const ownTeam = roster.slots.filter((s) => s.team === h.team);
			const ownHumans = ownTeam.filter((s) => s.kind === "human").length;
			const delta = applyMatch(rec, opponents, {
				won: report.winningTeam === h.team,
				drawn: report.winningTeam < 0,
				combatScore: scoreOf.get(h.playerId) ?? 0,
				lobbyMeanScore: lobbyMean,
				durationSec: report.durationSec,
				teamHumanFraction: ownTeam.length > 0 ? ownHumans / ownTeam.length : 1
			}, now);
			this.emit("mm:rating:update", {
				playerId: h.playerId,
				before: delta.before,
				after: delta.after,
				delta: delta.delta,
				rd: rec.rating.rd
			});
			this.transport.send({
				t: "rating:update",
				playerId: h.playerId,
				before: delta.before,
				after: delta.after,
				rd: rec.rating.rd
			});
		}
		this.store.save();
	}
	broadcastRoster(roster) {
		const candidates = roster.slots.filter((s) => s.kind === "human").map((s) => ({
			playerId: s.playerId,
			connection: s.connection
		}));
		if (candidates.length && !candidates.some((c) => c.playerId === roster.hostId)) {
			roster.hostId = selectHost(candidates, Math.max(0, candidates.length - 1)).hostId;
			this.emit("mm:host:elected", {
				matchId: roster.matchId,
				hostId: roster.hostId,
				worstPing: 0
			});
		}
		this.emit("mm:roster:update", { roster });
		this.transport.send({
			t: "roster:update",
			roster
		});
	}
	onMessage(msg, from) {
		switch (msg.t) {
			case "queue:join":
				if (!this.isHost) return;
				this.admit(msg.ticket.members.map((m) => ({
					playerId: m.playerId,
					name: m.name,
					rank: m.rank,
					connection: m.connection,
					rating: m.rating
				})), msg.ticket.playlist, this.now, msg.ticket.kind);
				return;
			case "queue:leave":
				if (!this.isHost) return;
				this.queue.remove(msg.ticketId);
				return;
			case "ticket:update":
				if (this.isHost) return;
				this.mirror = {
					waited: msg.waited,
					skillWindow: msg.skillWindow,
					pingWindow: msg.pingWindow,
					candidates: msg.candidates,
					estimate: msg.estimate
				};
				return;
			case "match:found":
				if (this.isHost) return;
				if (!msg.proposal.roster.slots.some((s) => s.kind === "human" && s.playerId === this.localPlayerId)) return;
				this.currentRoster = msg.proposal.roster;
				this.state = "found";
				this.emit("mm:match:found", { proposal: msg.proposal });
				return;
			case "roster:update":
				if (this.isHost) return;
				if (this.currentRoster?.matchId !== msg.roster.matchId) return;
				this.currentRoster = msg.roster;
				this.emit("mm:roster:update", { roster: msg.roster });
				return;
			case "bot:yield":
				if (this.isHost) return;
				this.emit("mm:bot:yield", {
					matchId: msg.matchId,
					botId: msg.botId,
					botName: msg.botId,
					forPlayer: msg.forPlayer,
					team: 0
				});
				return;
			case "rating:update": {
				if (this.isHost) return;
				const rec = this.store.get(msg.playerId);
				if (rec) rec.rating = {
					...rec.rating,
					rating: msg.after,
					rd: msg.rd
				};
				return;
			}
			default:
		}
	}
	snapshot() {
		const local = this.store.local();
		const def = this.localPlaylist ? playlist(this.localPlaylist) : null;
		const status = this.isHost && this.localTicket ? this.queue.status(this.localTicket, this.now) : null;
		return {
			state: this.state,
			playlist: this.localPlaylist,
			playlistName: def?.name ?? "",
			waited: status?.windows.waited ?? this.mirror.waited ?? 0,
			skillWindow: status?.windows.skill ?? this.mirror.skillWindow ?? 0,
			pingWindow: status?.windows.ping ?? this.mirror.pingWindow ?? 0,
			crossRegion: status?.windows.crossRegion ?? false,
			botFillArmed: status?.windows.botFill ?? false,
			candidates: status?.candidates ?? this.mirror.candidates ?? 0,
			estimate: status?.estimate ?? this.mirror.estimate ?? -1,
			roster: this.currentRoster,
			quality: null,
			rating: local.rating.rating,
			rd: local.rating.rd,
			region: local.region,
			mirrored: !this.isHost
		};
	}
	/** Roster composition, for the lobby screen and the tools. */
	composition(roster) {
		const out = [];
		for (let t = 0; t < roster.teams; t++) out.push({
			team: t,
			humans: humansOn(roster, t).length,
			bots: botsOn(roster, t).length
		});
		return out;
	}
};
/** Unrated placeholder — exported so callers can build a party without a store. */
function unratedMember(playerId, name) {
	return {
		playerId,
		name,
		rating: newRating()
	};
}
//#endregion
//#region src/session/matchmaking/Population.ts
const REGION_WEIGHTS = [
	["na-east", .27],
	["na-west", .17],
	["eu-west", .24],
	["eu-east", .09],
	["apac", .13],
	["oce", .05],
	["sa", .05]
];
const ACCESS = [
	{
		name: "fibre",
		weight: .3,
		lastMile: [4, 9],
		jitter: [1, 3],
		loss: [0, .05],
		upstream: [8e3, 4e4],
		hostCapable: true,
		natStrictChance: .05
	},
	{
		name: "cable",
		weight: .4,
		lastMile: [12, 26],
		jitter: [2, 7],
		loss: [.02, .2],
		upstream: [1500, 6e3],
		hostCapable: true,
		natStrictChance: .12
	},
	{
		name: "dsl",
		weight: .18,
		lastMile: [28, 48],
		jitter: [5, 14],
		loss: [.1, .6],
		upstream: [500, 1200],
		hostCapable: true,
		natStrictChance: .22
	},
	{
		name: "cellular",
		weight: .12,
		lastMile: [55, 95],
		jitter: [14, 34],
		loss: [.4, 1.8],
		upstream: [400, 2500],
		hostCapable: false,
		natStrictChance: .55
	}
];
const FIRST = [
	"Reaper",
	"Sable",
	"Mako",
	"Onyx",
	"Havoc",
	"Jinx",
	"Zero",
	"Rift",
	"Cinder",
	"Vulture",
	"Torch",
	"Static",
	"Grim",
	"Halo",
	"Lynx",
	"Nova"
];
const LAST = [
	"77",
	"X",
	"HD",
	"ttv",
	"_pro",
	"99",
	"GG",
	"zz",
	"_04",
	"v2",
	"OG",
	"kz"
];
function pickWeighted(items, rng) {
	let total = 0;
	for (const [, w] of items) total += w;
	let r = rng.next() * total;
	for (const [v, w] of items) {
		r -= w;
		if (r <= 0) return v;
	}
	return items[items.length - 1][0];
}
function pickAccess(rng) {
	return pickWeighted(ACCESS.map((a) => [a, a.weight]), rng);
}
function generatePopulation(n, rng, opts = {}) {
	const mean = opts.skillMean ?? 1500;
	const sigma = opts.skillSigma ?? 260;
	const eliteFraction = opts.eliteFraction ?? .07;
	const eliteOffset = opts.eliteOffset ?? 430;
	const appetiteScale = opts.appetiteScale ?? 1;
	const out = [];
	for (let i = 0; i < n; i++) {
		const region = pickWeighted(REGION_WEIGHTS, rng);
		const access = pickAccess(rng);
		const conn = {
			...defaultConnection(region),
			lastMileMs: rng.range(access.lastMile[0], access.lastMile[1]),
			jitterMs: rng.range(access.jitter[0], access.jitter[1]),
			lossPct: rng.range(access.loss[0], access.loss[1]),
			upstreamKbps: rng.range(access.upstream[0], access.upstream[1]),
			hostCapable: access.hostCapable,
			nat: pickNat(rng, access.natStrictChance)
		};
		const elite = rng.bool(eliteFraction);
		const latent = clamp(mean + rng.normal() * sigma + (elite ? eliteOffset : 0), 820, 2500);
		const size = pickWeighted([
			[1, .62],
			[2, .2],
			[3, .09],
			[4, .09]
		], rng);
		out.push({
			id: `p${i.toString(36)}`,
			name: `${rng.pick(FIRST)}${rng.pick(LAST)}${rng.int(1, 99)}`,
			region,
			connection: conn,
			latentSkill: latent,
			quitChance: clamp(rng.range(.01, .09) + (elite ? .02 : 0), 0, .2),
			appetite: Math.max(1, Math.round(rng.int(1, 12) * appetiteScale)),
			partySize: size
		});
	}
	return out;
}
function pickNat(rng, strictChance) {
	const r = rng.next();
	if (r < strictChance) return "strict";
	if (r < strictChance + .25) return "moderate";
	return "open";
}
/** Population skill percentiles, printed by the tool as a sanity check. */
function skillPercentiles(pop) {
	const s = pop.map((p) => p.latentSkill).sort((a, b) => a - b);
	const at = (q) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
	return {
		p05: at(.05),
		p25: at(.25),
		p50: at(.5),
		p75: at(.75),
		p95: at(.95),
		p99: at(.99)
	};
}
function clamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}
//#endregion
//#region src/session/matchmaking/Simulation.ts
/**
* Headless matchmaking simulation.
*
* Drives the *real* `MatchmakingService` — same queue, same widening curve,
* same bot fill, same backfill manager — against a synthetic population, on a
* virtual clock. Nothing here is a model of the matchmaker; it is a model of
* the *players*, which is the only honest way to measure a queue.
*
* Outcomes are resolved from each synthetic player's latent skill, which the
* rating system never sees. That makes the correlation between final rating and
* latent skill a real measurement rather than a tautology.
*
* Everything is seeded from `src/core/Rand.ts`; two runs with the same seed
* produce byte-identical statistics, which `tools/session-mm.mjs` asserts.
*/
const DEFAULT_SIM = {
	seed: 20260729,
	population: 500,
	attempts: 1e3,
	playlist: "core-tdm-6v6",
	arrivalsPerSecond: 1.6,
	matchDuration: 420,
	scoreLimit: 75,
	step: .5,
	maxSeconds: 4e3,
	joinInProgressAfter: 10
};
function dist(values) {
	if (values.length === 0) return {
		mean: 0,
		p50: 0,
		p90: 0,
		p95: 0,
		p99: 0,
		max: 0
	};
	const s = [...values].sort((a, b) => a - b);
	const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
	return {
		mean: s.reduce((a, b) => a + b, 0) / s.length,
		p50: at(.5),
		p90: at(.9),
		p95: at(.95),
		p99: at(.99),
		max: s[s.length - 1]
	};
}
function poisson(lambda, rng) {
	if (lambda <= 0) return 0;
	const L = Math.exp(-lambda);
	let k = 0;
	let p = 1;
	do {
		k++;
		p *= rng.next();
	} while (p > L && k < 64);
	return k - 1;
}
function pearson(xs, ys) {
	const n = Math.min(xs.length, ys.length);
	if (n < 3) return 0;
	let mx = 0;
	let my = 0;
	for (let i = 0; i < n; i++) {
		mx += xs[i];
		my += ys[i];
	}
	mx /= n;
	my /= n;
	let num = 0;
	let dx = 0;
	let dy = 0;
	for (let i = 0; i < n; i++) {
		const a = xs[i] - mx;
		const b = ys[i] - my;
		num += a * b;
		dx += a * a;
		dy += b * b;
	}
	return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}
function runSimulation(partial = {}) {
	const cfg = {
		...DEFAULT_SIM,
		...partial
	};
	const rng = new Rand(cfg.seed);
	const pop = generatePopulation(cfg.population, rng, { appetiteScale: cfg.appetiteScale });
	const byId = new Map(pop.map((p) => [p.id, p]));
	const events = {};
	const emit = (key, _payload) => {
		events[key] = (events[key] ?? 0) + 1;
	};
	const store = new RatingStore(null);
	const service = new MatchmakingService({
		seed: cfg.seed ^ 40503,
		store,
		emit,
		joinInProgressAfter: cfg.joinInProgressAfter,
		queue: cfg.widening ? { widening: cfg.widening } : void 0
	});
	const idle = new Set(pop.map((p) => p.id));
	const queued = /* @__PURE__ */ new Map();
	const inMatch = /* @__PURE__ */ new Map();
	const remaining = new Map(pop.map((p) => [p.id, p.appetite]));
	const live = /* @__PURE__ */ new Map();
	const queueTimes = [];
	const spreads = [];
	const deltas = [];
	const pings = [];
	let ticketsAdmitted = 0;
	let matches = 0;
	let botSlots = 0;
	let totalSlots = 0;
	let matchesWithBots = 0;
	let matchesFullyHuman = 0;
	let leavers = 0;
	let playersMatched = 0;
	let backfillPlacements = 0;
	let botSlotSeconds = 0;
	let allSlotSeconds = 0;
	let t = 0;
	const seen = /* @__PURE__ */ new Set();
	while (t < cfg.maxSeconds && (ticketsAdmitted < cfg.attempts || live.size > 0 || queued.size > 0)) {
		if (ticketsAdmitted < cfg.attempts) {
			const n = poisson(cfg.arrivalsPerSecond * cfg.step, rng);
			for (let i = 0; i < n && ticketsAdmitted < cfg.attempts; i++) {
				const party = drawParty(pop, idle, remaining, rng);
				if (party.length === 0) break;
				const members = party.map((p) => ({
					playerId: p.id,
					name: p.name,
					connection: p.connection,
					rank: 1
				}));
				service.admit(members, cfg.playlist, t);
				ticketsAdmitted++;
				for (const p of party) {
					idle.delete(p.id);
					queued.set(p.id, t);
				}
			}
		}
		const proposals = service.update(t);
		for (const p of proposals) {
			const strength = teamStrengths(p.roster, byId);
			const total = strength.reduce((a, b) => a + b, 0) / Math.max(1, strength.length);
			const rate = strength.map((s) => cfg.scoreLimit / cfg.matchDuration * (s / Math.max(1, total)));
			const view = {
				matchId: p.roster.matchId,
				phase: "live",
				elapsed: 0,
				duration: cfg.matchDuration,
				scoreLimit: cfg.scoreLimit,
				teamScores: new Array(p.roster.teams).fill(0)
			};
			service.registerMatch(p.roster, view);
			live.set(p.roster.matchId, {
				roster: p.roster,
				view,
				rate,
				scores: new Array(p.roster.teams).fill(0),
				done: false
			});
			matches++;
			const bots = p.quality.bots;
			botSlots += bots;
			totalSlots += p.roster.slots.length;
			if (bots > 0) matchesWithBots++;
			else matchesFullyHuman++;
			spreads.push(p.quality.skillSpread);
			deltas.push(p.quality.teamDelta);
			if (p.quality.meanPing > 0) pings.push(p.quality.meanPing);
			seen.add(p.roster.matchId);
		}
		for (const m of live.values()) for (const s of m.roster.slots) {
			if (s.kind !== "human") continue;
			const joined = queued.get(s.playerId);
			if (joined === void 0) continue;
			queued.delete(s.playerId);
			inMatch.set(s.playerId, m.roster.matchId);
			queueTimes.push(t - joined);
			playersMatched++;
			if (s.backfilled) backfillPlacements++;
		}
		for (const [id, m] of [...live]) {
			if (m.done) continue;
			for (const s of m.roster.slots) {
				allSlotSeconds += cfg.step;
				if (s.kind === "bot") botSlotSeconds += cfg.step;
			}
			m.view.elapsed += cfg.step;
			for (let team = 0; team < m.scores.length; team++) {
				m.scores[team] += m.rate[team] * cfg.step * rng.range(.7, 1.3);
				m.view.teamScores[team] = Math.round(m.scores[team]);
			}
			service.updateMatch(m.view);
			for (const s of [...m.roster.slots]) {
				if (s.kind !== "human") continue;
				const p = byId.get(s.playerId);
				if (!p) continue;
				const per = p.quitChance * (cfg.step / cfg.matchDuration);
				if (!rng.bool(per)) continue;
				service.reportPlayerLeft(id, s.playerId, t);
				inMatch.delete(s.playerId);
				leavers++;
				requeueOrIdle(s.playerId, idle, remaining);
			}
			if (!(m.view.elapsed >= cfg.matchDuration || Math.max(...m.view.teamScores) >= cfg.scoreLimit)) continue;
			finishMatch(service, m, byId, t, rng);
			for (const s of m.roster.slots) {
				if (s.kind !== "human") continue;
				inMatch.delete(s.playerId);
				requeueOrIdle(s.playerId, idle, remaining);
			}
			service.endMatch(id);
			live.delete(id);
			m.done = true;
		}
		t += cfg.step;
	}
	const xs = [];
	const ys = [];
	let rdSum = 0;
	let rated = 0;
	let matchesPlayedSum = 0;
	for (const rec of store.all()) {
		const p = byId.get(rec.id);
		if (!p || rec.rating.matches < 3) continue;
		xs.push(rec.rating.rating);
		ys.push(p.latentSkill);
		rdSum += rec.rating.rd;
		matchesPlayedSum += rec.rating.matches;
		rated++;
	}
	/**
	* Correlation as a function of games played. A rating system is judged on
	* where this curve *goes*, not on one point of it: Glicko-2 starting every
	* player at 1500/RD 350 cannot know anything after three matches, so a low
	* number there is convergence speed, whereas a flat curve means the update is
	* actually broken.
	*/
	const byExperience = [];
	for (const minMatches of [
		3,
		5,
		8,
		12,
		20
	]) {
		const bx = [];
		const by = [];
		for (const rec of store.all()) {
			const p = byId.get(rec.id);
			if (!p || rec.rating.matches < minMatches) continue;
			bx.push(rec.rating.rating);
			by.push(p.latentSkill);
		}
		byExperience.push({
			minMatches,
			r: bx.length > 2 ? pearson(bx, by) : NaN,
			n: bx.length
		});
	}
	const refusals = {};
	for (const [k, v] of service.backfill.refusals) refusals[k] = v;
	const stats = {
		config: cfg,
		seconds: Math.round(t),
		players: pop.length,
		skillPercentiles: skillPercentiles(pop),
		ticketsAdmitted,
		ticketsMatched: matches,
		ticketsStranded: service.queue.size,
		playersMatched,
		matches,
		queueSeconds: dist(queueTimes),
		skillSpread: dist(spreads),
		teamDelta: dist(deltas),
		hostPing: dist(pings),
		botFillRate: totalSlots > 0 ? botSlots / totalSlots : 0,
		botOccupancy: allSlotSeconds > 0 ? botSlotSeconds / allSlotSeconds : 0,
		botSlots,
		totalSlots,
		matchesWithBots,
		matchesFullyHuman,
		backfillPlacements,
		botTopUps: events["mm:botfill"] ?? 0,
		botYields: events["mm:bot:yield"] ?? 0,
		leavers,
		refusals,
		ratingCorrelation: pearson(xs, ys),
		ratingCorrelationByExperience: byExperience,
		meanMatchesPlayed: rated > 0 ? matchesPlayedSum / rated : 0,
		ratedPlayers: rated,
		meanRd: rated > 0 ? rdSum / rated : 0,
		events,
		hash: ""
	};
	stats.hash = fingerprint(stats);
	return stats;
}
function fingerprint(s) {
	return hashString([
		s.matches,
		s.playersMatched,
		round(s.queueSeconds.p50),
		round(s.queueSeconds.p95),
		round(s.skillSpread.mean),
		round(s.botFillRate, 4),
		s.botYields,
		s.leavers,
		round(s.ratingCorrelation, 4)
	].join("|")).toString(16);
}
function round(v, dp = 2) {
	const m = Math.pow(10, dp);
	return Math.round(v * m) / m;
}
function drawParty(pop, idle, remaining, rng) {
	const available = pop.filter((p) => idle.has(p.id) && (remaining.get(p.id) ?? 0) > 0);
	if (available.length === 0) return [];
	const leader = available[rng.int(0, available.length - 1)];
	const party = [leader];
	if (leader.partySize > 1) {
		const friends = available.filter((p) => p.id !== leader.id && p.region === leader.region);
		for (let i = 0; i < leader.partySize - 1 && friends.length > 0; i++) {
			const j = rng.int(0, friends.length - 1);
			party.push(friends[j]);
			friends.splice(j, 1);
		}
	}
	for (const p of party) remaining.set(p.id, (remaining.get(p.id) ?? 1) - 1);
	return party;
}
function requeueOrIdle(id, idle, remaining) {
	if ((remaining.get(id) ?? 0) > 0) idle.add(id);
}
function teamStrengths(roster, byId) {
	const out = [];
	for (let team = 0; team < roster.teams; team++) {
		const slots = roster.slots.filter((s) => s.team === team);
		if (slots.length === 0) {
			out.push(1500);
			continue;
		}
		let sum = 0;
		for (const s of slots) sum += s.kind === "human" ? byId.get(s.playerId)?.latentSkill ?? 1500 : s.rating;
		out.push(sum / slots.length);
	}
	return out;
}
function finishMatch(service, m, byId, t, rng) {
	let winning = 0;
	for (let team = 1; team < m.view.teamScores.length; team++) if (m.view.teamScores[team] > m.view.teamScores[winning]) winning = team;
	const scores = m.roster.slots.filter((s) => s.kind === "human").map((s) => {
		const base = (byId.get(s.playerId)?.latentSkill ?? 1500) / 1500 * 90 * (m.view.elapsed / 60);
		return {
			playerId: s.playerId,
			combatScore: Math.max(0, base * rng.range(.6, 1.45))
		};
	});
	service.submitResult({
		matchId: m.roster.matchId,
		winningTeam: winning,
		durationSec: m.view.elapsed,
		scores
	}, t);
}
/**
* The demo case: four friends want a 6v6. Eight slots must fill with bots, the
* match must start in single-digit seconds, and when a fifth human turns up a
* bot must give up its slot rather than the roster growing to thirteen.
*/
function runFriendGroupScenario(seed = 4242, playlistId = "core-tdm-6v6", friends = 4) {
	const rng = new Rand(seed);
	const pop = generatePopulation(friends + 1, rng, {});
	const service = new MatchmakingService({
		seed,
		store: new RatingStore(null)
	});
	const party = pop.slice(0, friends).map((p) => ({
		playerId: p.id,
		name: p.name,
		connection: p.connection,
		rank: 12
	}));
	service.admit(party, playlistId, 0);
	let t = 0;
	let roster = null;
	while (t < 120 && !roster) {
		const proposals = service.update(t);
		if (proposals.length > 0) roster = proposals[0].roster;
		t += .5;
	}
	if (!roster) return {
		humans: friends,
		bots: 0,
		slots: 0,
		secondsToLaunch: -1,
		teams: [],
		difficulties: {},
		teamDelta: 0,
		afterYield: null
	};
	const difficulties = {};
	for (const s of roster.slots) {
		if (s.kind !== "bot") continue;
		difficulties[s.difficulty] = (difficulties[s.difficulty] ?? 0) + 1;
	}
	const teams = [];
	for (let team = 0; team < roster.teams; team++) {
		const slots = roster.slots.filter((s) => s.team === team);
		const mean = slots.length ? slots.reduce((a, s) => a + (s.kind === "human" ? s.rating.rating : s.rating), 0) / slots.length : 0;
		teams.push({
			team,
			humans: humansOn(roster, team).length,
			bots: botsOn(roster, team).length,
			meanRating: Math.round(mean)
		});
	}
	const view = {
		matchId: roster.matchId,
		phase: "live",
		elapsed: 30,
		duration: 420,
		scoreLimit: 75,
		teamScores: [4, 3]
	};
	service.registerMatch(roster, view);
	const botsBefore = roster.slots.filter((s) => s.kind === "bot").length;
	const slotsBefore = roster.slots.length;
	const newcomer = pop[friends];
	service.admit([{
		playerId: newcomer.id,
		name: newcomer.name,
		connection: newcomer.connection
	}], playlistId, t, "backfill");
	service.update(t + 1);
	const after = service.backfill.rosterOf(roster.matchId) ?? roster;
	const botsAfter = after.slots.filter((s) => s.kind === "bot").length;
	return {
		humans: friends,
		bots: slotsBefore - friends,
		slots: slotsBefore,
		secondsToLaunch: t - .5,
		teams,
		difficulties,
		teamDelta: Math.abs((teams[0]?.meanRating ?? 0) - (teams[1]?.meanRating ?? 0)),
		afterYield: {
			humans: after.slots.filter((s) => s.kind === "human").length,
			bots: botsAfter,
			slots: after.slots.length,
			yielded: botsBefore - botsAfter
		}
	};
}
/** Truth table for the "is it too late to join" rules. */
function runBackfillPolicyProbe(playlistId = "core-tdm-6v6") {
	const def = playlist(playlistId);
	const rows = [
		[
			"fresh match",
			.05,
			0
		],
		[
			"mid match, even",
			.4,
			.1
		],
		[
			"mid match, one-sided",
			.4,
			.6
		],
		[
			"late match",
			.7,
			.1
		],
		[
			"final 90 s",
			.9,
			.1
		],
		[
			"near score limit",
			.5,
			.2
		]
	];
	const duration = 420;
	const limit = 75;
	return rows.map(([label, ef, gap]) => {
		const lead = label === "near score limit" ? limit * .85 : limit * .1 + limit * gap;
		return {
			label,
			elapsedFraction: ef,
			scoreGapFraction: gap,
			verdict: canBackfill({
				matchId: "probe",
				phase: "live",
				elapsed: duration * ef,
				duration,
				scoreLimit: limit,
				teamScores: [lead, Math.max(0, lead - limit * gap)]
			}, def, DEFAULT_BACKFILL)
		};
	});
}
/** The widening curve, sampled — printed by the tool so it is documented. */
function curveTable() {
	return describeCurve(DEFAULT_WIDENING);
}
//#endregion
export { BackfillManager, DEFAULT_BACKFILL, DEFAULT_SIM, DEFAULT_WIDENING, LoopbackTransport, MatchQueue, MatchmakingService, PLAYLISTS, PLAYLIST_IDS, PRIVATE_WIDENING, RANKED_WIDENING, RATING_DEFAULT, RD_DEFAULT, RD_MAX, RD_MIN, REGIONS, RatingStore, TransportHub, VOL_DEFAULT, applyMatch, backboneRtt, balanceTeams, botsOn, canBackfill, chooseBotToYield, connectionQuality, conservativeSkill, curveTable, decayed, defaultConnection, defaultRecord, describeCurve, difficultyForRating, effectiveRtt, estimateRtt, expectedScore, fillRoster, generatePopulation, humansOn, humansRequired, lobbyHumanMean, mutualWindows, newRating, partySkill, performanceScore, pingsToHost, playlist, qualityOf, ratingFromRank, removeBot, resetBotIds, runBackfillPolicyProbe, runFriendGroupScenario, runSimulation, selectHost, skillPercentiles, slotCount, slotRating, teamForIncoming, ticketConnection, ticketRegion, toAgentOptions, toSpawnParams, unratedMember, updateRating, wideningFor, windowsAt, windowsForTicket };
