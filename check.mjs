// Sanity checks: `npm test`. Fails loudly if the geometry or DEM orientation breaks.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sunEarth, skyPose } from './src/astro.js'
import { parseDem, makeDem, terrainFor, offsetLL, toMap, toLatLon, heightAt, horizon } from './src/dem.js'
import { computeOverlay, computeCalendar, computeSeries, rankLandingSites, bestNearbyFromOverlay } from './src/analysis.js'
import { makeInsight } from './src/insight.js'
import { ephem } from './src/astro.js'
import { inDem } from './src/dem.js'
import { validate } from './src/validation.js'
import { planMission, solveLaunchForLanding, missionState, craftPosition, PADS, padVec } from './src/mission.js'
import { moonAxes } from './src/astro.js'

const t0 = Date.UTC(2027, 0, 1)
const month = Array.from({ length: 60 }, (_, i) => new Date(t0 + i * 12 * 3600e3))
const range = (xs) => [Math.min(...xs), Math.max(...xs)]

// Near the south pole the Sun skims the horizon and Earth bobs ±~7° (libration).
const pole = month.map((d) => sunEarth(-89.9, 0, d))
const [sMin, sMax] = range(pole.map((p) => p.sun.el))
const [eMin, eMax] = range(pole.map((p) => p.earth.el))
assert(sMin > -2 && sMax < 2, `pole sun el ${sMin}..${sMax}`)
assert(eMin > -9 && eMax < 9 && eMax - eMin > 6, `pole earth el ${eMin}..${eMax}`)

// Near-side equator sees Earth high; far side (Chang'e-6) never sees it.
const ap11 = month.map((d) => sunEarth(0.674, 23.473, d).earth.el)
assert(Math.min(...ap11) > 55, `apollo11 earth el min ${Math.min(...ap11)}`)
const ce6 = month.map((d) => sunEarth(-41.64, -153.99, d).earth.el)
assert(Math.max(...ce6) < 0, `chang'e-6 earth el max ${Math.max(...ce6)}`)

// Earth/Sun drawing pose: orthonormal Earth axes, realistic angular sizes, and the sub-Moon
// point on Earth stays within the Moon's declination range (±28.6°).
for (const d of month.slice(0, 20)) {
  const p = skyPose(d, -89.444, -137.56)
  const n = (v) => Math.hypot(...v), dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  for (const v of [p.x, p.y, p.z]) assert(Math.abs(n(v) - 1) < 1e-9, 'earth axis not unit')
  assert(Math.abs(dt(p.x, p.y)) < 1e-9 && Math.abs(dt(p.y, p.z)) < 1e-9, 'earth axes not orthogonal')
  assert(p.earthR > 0.88 && p.earthR < 1.04, `earth angular radius ${p.earthR}`)
  assert(p.sunR > 0.26 && p.sunR < 0.275, `sun angular radius ${p.sunR}`)
  assert(Math.abs(p.subLat) < 29, `sub-moon latitude ${p.subLat}`)
}

// Which side of Earth faces the Moon: JPL Horizons COMMAND=399 CENTER=500@301 QUANTITIES=14
// (east-positive) gives sub-observer 232.010°E / −26.226° on 2026-11-14 00:00 UTC.
{
  const p = skyPose(new Date(Date.UTC(2026, 10, 14)), -89.444, -137.56)
  const dLon = Math.abs(((p.subLon - 232.010359 + 540) % 360) - 180)
  assert(dLon < 1 && Math.abs(p.subLat + 26.226107) < 0.5, `sub-moon point off: ${p.subLon}, ${p.subLat}`)
}

// Mission estimate: timeline adds up, rocket equation matches a hand calculation,
// and speeds are physically sensible (LEO ≈ 7.8 km/s, Earth–Moon 356–407 thousand km).
{
  const launch = Date.UTC(2026, 10, 14)
  const p = planMission({ launch, route: 'fast', engine: 'hyper', dryKg: 1500, waitDays: 1 })
  const park = (p.tli - launch) / 60e3 - 9
  assert(park >= 88 && park <= 178 && Math.abs(p.land - (p.tli + 4 * 864e5)) < 1, `mission timeline (parking ${park} min)`)
  const hand = 1500 * Math.exp((0.05 + 0.9 + 2.0) * 1000 / (315 * 9.80665))
  assert(Math.abs(p.m0 - hand) < 1e-6 && p.prop > 2000 && p.prop < 3000, `propellant ${p.prop}`)
  assert(Math.abs(p.vLeo - 7.784) < 0.01, `LEO speed ${p.vLeo}`)
  assert(p.distKm > 356000 && p.distKm < 407000, `earth-moon distance ${p.distKm}`)
  const low = planMission({ launch, route: 'low', engine: 'hydrogen', dryKg: 1500 })
  assert(low.prop < p.prop, 'low-energy + hydrogen should need less lander propellant')

  // Animation state: phases in order, coast speed falls from ~10.9 km/s toward ~1 km/s,
  // propellant only goes down and ends at the dry mass.
  const order = ['ascent', 'leo', 'tli', 'coast', 'loi', 'llo', 'descent', 'landed']
  let last = -1, lastMass = Infinity
  for (let t = launch; t <= p.land + 3600e3; t += 600e3) {
    const s = missionState(p, t), k = order.indexOf(s.phase)
    assert(k >= last, `phase went backwards at ${s.phase}`)
    assert(s.mass <= lastMass + 1e-6, 'propellant increased')
    last = k; lastMass = s.mass
  }
  // Right after TLI the craft is near 10.9 km/s, then Earth's gravity slows it continuously.
  const vs = [1, 60, 600, 3000, 4000].map((min) => missionState(p, p.tli + min * 60e3).v)
  assert(vs[0] > 10 && vs[0] < 11.2, `speed right after TLI ${vs[0]}`)
  assert(vs.every((v, i) => !i || v < vs[i - 1]), `coast speed should keep falling: ${vs}`)
  assert(Math.abs(missionState(p, p.land + 1).mass - 1500) < 1e-6, 'should land with dry mass')

  // 3D craft path: in LEO at TLI, on a 100 km lunar orbit after arrival, and touching down
  // exactly on the chosen site (same point astro.js uses for the Moon-surface analysis).
  const site = { lat: -85.989, lon: 2.1 }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const atTli = craftPosition(p, p.tli, site)
  assert(Math.abs(Math.hypot(...atTli.pos) - 6578.137) < 1, `LEO radius ${Math.hypot(...atTli.pos)}`)
  const inLlo = craftPosition(p, p.arrive + 3 * 3600e3, site)
  assert(Math.abs(dist(inLlo.pos, inLlo.moon) - 1837.4) < 1, `LLO radius ${dist(inLlo.pos, inLlo.moon)}`)
  const landed = craftPosition(p, p.land, site)
  assert(Math.abs(dist(landed.pos, landed.moon) - 1737.4) < 1, 'touchdown not on the lunar surface')
  // touchdown point = site vector from the Moon's IAU frame
  const ax = moonAxes(new Date(p.land)), la = site.lat * Math.PI / 180, lo = site.lon * Math.PI / 180
  const want = [0, 1, 2].map((i) => landed.moon[i] + 1737.4 * (ax.x[i] * Math.cos(la) * Math.cos(lo) + ax.y[i] * Math.cos(la) * Math.sin(lo) + ax.z[i] * Math.sin(la)))
  assert(dist(landed.pos, want) < 1, `touchdown off site by ${dist(landed.pos, want)} km`)
  // Liftoff: the rocket starts on the launch pad (Kennedy) as Earth is turned at that moment,
  // and heads east.
  const pad0 = padVec(PADS.ksc, launch).map((x) => x * 6378.137)
  assert(dist(craftPosition(p, launch, site).pos, pad0) < 1, 'rocket not on the pad at liftoff')
  const up1 = craftPosition(p, launch + 4 * 60e3, site).pos, east = [-pad0[1], pad0[0], 0]
  assert((up1[0] - pad0[0]) * east[0] + (up1[1] - pad0[1]) * east[1] > 0, 'launch should head east')
  for (const k of Object.keys(PADS)) {
    const q = planMission({ launch, pad: k, route: 'artemis' }), a = craftPosition(q, q.tli - 1, site).pos, b = craftPosition(q, q.tli + 60e3, site).pos
    assert(dist(a, b) / 60 < 11.2, `${k}: jump at TLI ${dist(a, b)} km/min`)
  }
  // Inverse launch solver: given target lunar touchdown epoch, finds launch epoch hitting it within 1 s.
  for (const [pad, route] of [['biak', 'fast'], ['biak', 'artemis'], ['ksc', 'artemis'], ['biak', 'low']]) {
    const wantLand = Date.UTC(2026, 10, 20, 14, 0, 0)
    const inv = solveLaunchForLanding({ land: wantLand, pad, route, engine: 'hyper', dryKg: 1500, waitDays: 1 })
    assert(Math.abs(inv.land - wantLand) <= 1000, `${pad}/${route} inverse landing off by ${inv.land - wantLand} ms`)
    assert(inv.launch < inv.tli && inv.tli < inv.arrive && inv.arrive < inv.land, `${pad}/${route} inverse order invalid`)
  }
  // Arrival never passes through the Moon (stays at lunar-orbit height or above).
  for (let k = 0; k <= 200; k++) {
    const c = craftPosition(p, p.tli + (p.arrive - p.tli) * (0.95 + 0.05 * k / 200), site)
    assert(dist(c.pos, c.moon) > 1837.4 - 1, `craft inside the Moon (${dist(c.pos, c.moon)} km)`)
  }
  // Path is continuous and physical: never faster than ~11.2 km/s (escape speed at LEO)
  // between 10-minute steps, from parking orbit through lunar orbit.
  let prev = craftPosition(p, p.launch + 10 * 60e3, site).pos
  for (let t = p.launch + 20 * 60e3; t <= p.arrive + 3600e3; t += 600e3) {
    const c = craftPosition(p, t, site).pos
    assert(dist(c, prev) / 600 < 11.2, `path jumps ${dist(c, prev)} km in 10 min at ${new Date(t).toISOString()}`)
    prev = c
  }
}

// JPL Horizons reference (shared with the in-app validation panel). Must stay within 0.05°.
const jpl = validate()
assert.equal(jpl.rows.length, 8)
assert(jpl.max < 0.05, `JPL mismatch ${jpl.max}`)

// Map projection round-trips.
const [la, lo] = toLatLon(...toMap(-85.5, 33))
assert(Math.abs(la + 85.5) < 1e-9 && Math.abs(lo - 33) < 1e-9)

// DEM orientation: Shackleton floor is deep, rim high; a mirrored map would miss both.
const dem = parseDem(readFileSync(new URL('./public/LDEM_75S_240M.IMG', import.meta.url)).buffer)
const h = (lat, lon) => heightAt(dem, ...toMap(lat, lon))
const floor = h(-89.67, 129.78)
assert(floor < -2500, `shackleton floor ${floor}`)
assert(h(-89.774, -154.87) - floor > 4000, 'shackleton rim not ~4 km above floor')
assert(h(-85.989, 2.1) > 5000, 'malapert summit not > 5 km')

// Horizon from the Shackleton floor must be steep (crater walls).
const hz = horizon(dem, -89.67, 129.78)
assert(Math.min(...hz) > 5, `shackleton floor horizon min ${Math.min(...hz)}`)

// Overlay grid: Shackleton floor (centre cell) never lit, its rim often is.
const ov = computeOverlay(dem, { lat: -89.67, lon: 129.78, start: Date.UTC(2026, 10, 14), n: 9, spacing: 5000 })
assert.equal(ov.lit[4 * 9 + 4], 0, 'shackleton floor lit in overlay')
assert(Math.max(...ov.lit) > 0.5, 'no lit rim cell in overlay')

// Calendar: full year, and Malapert has at least one good landing window in 2027.
const cal = computeCalendar({ lat: -85.989, lon: 2.1, hz: horizon(dem, -85.989, 2.1), year: 2027 })
assert.equal(cal.days.length, 365)
assert(cal.best && cal.best.to - cal.best.from >= 3, 'no good window at Malapert 2027')

// Insight verdicts for well-understood sites (window starting 2026-11-14).
const eph30 = Array.from({ length: 1441 }, (_, i) => ephem(new Date(Date.UTC(2026, 10, 14) + i * 18e5)))
const verdict = (lat, lon) => {
  const dist = new Float32Array(720), hzS = inDem(lat) ? horizon(dem, lat, lon, { dist }) : new Float32Array(720)
  return makeInsight({ s: computeSeries(eph30, lat, lon, hzS, dist, 30), stepMin: 30, hasDem: inDem(lat) })
}
const fl = verdict(-89.67, 129.78)
assert.equal(fl.level, 'bad', 'shackleton floor should be "tidak layak"')
assert(fl.why.some((w) => w.k === 'sci'), 'shackleton floor should mention ice')
assert.equal(verdict(-85.989, 2.1).level, 'good', 'malapert summit should be "layak" in this window')
assert(verdict(-41.638, -153.985).why.some((w) => /far side/i.test(w.h)), "chang'e-6 should be flagged as far side")
// Every item must have a short headline and one supporting sentence (UI depends on it).
for (const r of [fl, verdict(-89.444, -137.56)]) for (const w of [...r.why, ...r.advice]) {
  assert(w.k && w.h && w.t, `insight item missing k/h/t: ${JSON.stringify(w)}`)
  assert(w.h.length <= 48, `headline too long: ${w.h}`)
}

// Global multi-DEM checks: orientation, cross-DEM agreement, antimeridian wrap, far-side & equator.
const dem75s = makeDem({ kind: 'polar', hemi: 'S', buf: dem })
const dem75n = makeDem({ kind: 'polar', hemi: 'N', buf: readFileSync(new URL('./public/LDEM_75N_240M.IMG', import.meta.url)).buffer })
const dem16 = makeDem({ kind: 'cyl', ppd: 16, buf: readFileSync(new URL('./public/LDEM_16.IMG', import.meta.url)).buffer })
const dems = { '75S': dem75s, '75N': dem75n, '16': dem16 }
assert.equal(terrainFor(dems, -80).id, '75S')
assert.equal(terrainFor(dems, 80).id, '75N')
assert.equal(terrainFor(dems, 0).id, '16')
assert.equal(terrainFor({ '16': dem16 }, -80).id, '16')

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[(s.length / 2) | 0] }
const diffS = [], diffN = []
for (let lat = 76; lat <= 84; lat += 2) {
  for (let lon = -165; lon <= 165; lon += 30) {
    diffS.push(Math.abs(dem75s.height(-lat, lon) - dem16.height(-lat, lon)))
    diffN.push(Math.abs(dem75n.height(lat, lon) - dem16.height(lat, lon)))
  }
}
const medS = median(diffS), medN = median(diffN)
assert(medS < 300, `75S vs LDEM_16 median diff ${medS} m`)
assert(medN < 300, `75N vs LDEM_16 median diff ${medN} m`)

// Highest point on the Moon (Selenean summit near 5.41°N, 158.63°W) > 9000 m in LDEM_16.
let maxSummit = -Infinity
for (let e = -15000; e <= 15000; e += 1500) {
  for (let n = -15000; n <= 15000; n += 1500) {
    const [pLa, pLo] = offsetLL(5.41, -158.63, e, n)
    const z = dem16.height(pLa, pLo)
    if (z > maxSummit) maxSummit = z
  }
}
assert(maxSummit > 9000, `lunar highest point ${maxSummit} m`)

// Longitude wrap continuity across ±180° and offsetLL wrapping.
const hWest = dem16.height(0, 179.99), hEast = dem16.height(0, -179.99)
assert(Math.abs(hWest - hEast) < 150, `±180 wrap jump ${Math.abs(hWest - hEast)} m`)
const [wLat, wLon] = offsetLL(0, 179.99, 5000, 0)
assert(Math.abs(wLat) < 0.01 && wLon < -179 && wLon > -180, `offsetLL wrap ${wLat},${wLon}`)

// Generic polar horizon agrees with legacy Int16Array horizon at Shackleton ridge & Malapert.
for (const [pLat, pLon, name] of [[-89.774, -154.87, 'shackleton ridge'], [-85.989, 2.1, 'malapert']]) {
  const hzLeg = horizon(dem, pLat, pLon), hzGen = horizon(dem75s, pLat, pLon)
  let ok = 0
  for (let i = 0; i < hzLeg.length; i++) if (Math.abs(hzLeg[i] - hzGen[i]) <= 0.5) ok++
  assert(ok / hzLeg.length >= 0.95, `${name} generic horizon match ${(ok / hzLeg.length * 100).toFixed(1)}%`)
}

// Far side (Chang'e-4) never sees Earth; equator (Apollo 11) is lit ~40–60% of a lunar month.
const seriesFor = (d, lat, lon) => {
  const dist = new Float32Array(720), hzG = horizon(d, lat, lon, { dist })
  return computeSeries(eph30, lat, lon, hzG, dist, 30)
}
const c4 = seriesFor(dem16, -45.457, 177.588)
assert(c4.earthVis.every((v) => v === 0), "chang'e-4 should never see Earth")
assert(makeInsight({ s: c4, stepMin: 30, hasDem: true }).why.some((w) => /far side/i.test(w.h)))
const a11 = seriesFor(dem16, 0.6741, 23.473)
assert(a11.pLit >= 0.40 && a11.pLit <= 0.60, `apollo 11 lit ${(a11.pLit * 100).toFixed(1)}%`)
const ov16 = computeOverlay(dem16, { lat: 0.6741, lon: 23.473, start: Date.UTC(2026, 10, 14), n: 5, spacing: 2500 })
assert(ov16.spacing >= 2 * dem16.res * 0.99, `global overlay spacing ${ov16.spacing}`)
assert(ov16.lit[12] >= 0.35 && ov16.lit[12] <= 0.65 && ov16.see[12] > 0.9, 'apollo 11 overlay center mismatch')

// Biak equatorial launch pad + deterministic landing-site recommendation ranking.
assert(PADS.biak && Math.abs(PADS.biak.lat - -1.17) < 0.01 && Math.abs(PADS.biak.lon - 136.1) < 0.01, 'biak pad missing')
const biakPlan = planMission({ launch: Date.UTC(2027, 0, 15, 12, 0, 0), pad: 'biak' })
assert(biakPlan.launch < biakPlan.tli && biakPlan.tli < biakPlan.arrive && biakPlan.arrive < biakPlan.land, 'biak timeline order')
const ephBiak = Array.from({ length: 1441 }, (_, i) => ephem(new Date(biakPlan.land + i * 18e5)))
const testSites = [
  { id: 'shackleton-rim', name: 'Tebing Shackleton', lat: -89.774, lon: -154.87 },
  { id: 'malapert', name: 'Puncak Malapert', lat: -85.989, lon: 2.1 },
  { id: 'shackleton-floor', name: 'Dasar Kawah Shackleton', lat: -89.67, lon: 129.78 },
]
const ranked = rankLandingSites({
  sites: testSites,
  landT: biakPlan.land,
  stepMin: 30,
  seriesAt: (site) => {
    const dist = new Float32Array(720)
    const hzG = horizon(dem75s, site.lat, site.lon, { dist })
    return computeSeries(ephBiak, site.lat, site.lon, hzG, dist, 30)
  },
})
assert(ranked.length === 3, 'ranked length mismatch')
assert(ranked.every((r) => Number.isFinite(r.score) && r.score >= 0 && r.score <= 100), 'score out of [0,100]')
assert(ranked[0].score >= ranked[1].score && ranked[1].score >= ranked[2].score, 'ranking not descending')
const floorRank = ranked.find((r) => r.site.id === 'shackleton-floor')
assert(floorRank && floorRank.litNow === false && floorRank.score < ranked[0].score, 'shackleton floor should be dark and score below top')

// 7-day surface window isolation, deterministic tie stability, touchdown-lit preference, and !hasDem exclusion.
const winSamples = 7 * 48 + 1
const mkSynthSeries = (first7Lit, first7See, tailLit, tailSee) => {
  const sunVis = new Float32Array(1441)
  const earthVis = new Uint8Array(1441)
  const sunEl = new Float32Array(1441)
  const sunAz = new Float32Array(1441)
  const earthEl = new Float32Array(1441)
  const earthAz = new Float32Array(1441)
  for (let i = 0; i < 1441; i++) {
    const inWin = i < winSamples
    sunVis[i] = inWin ? first7Lit : tailLit
    earthVis[i] = inWin ? first7See : tailSee
    sunEl[i] = (sunVis[i] >= 0.5 ? 4 : -4)
    earthEl[i] = (earthVis[i] ? 5 : -5)
  }
  return { hz: new Float32Array(720), sunEl, sunAz, earthEl, earthAz, sunVis, earthVis, pLit: 0, pSee: 0, pBoth: 0, longestNightH: 0 }
}
const synMap = {
  a: mkSynthSeries(1, 1, 0, 0),
  b: mkSynthSeries(1, 1, 1, 1),
  dark: mkSynthSeries(0, 1, 1, 1),
}
const synRank1 = rankLandingSites({
  sites: [{ id: 'b', lat: -85, lon: 0 }, { id: 'a', lat: -86, lon: 0 }, { id: 'dark', lat: -87, lon: 0 }],
  landT: biakPlan.land,
  stepMin: 30,
  surfaceDays: 7,
  seriesAt: (site) => synMap[site.id],
})
const synRank2 = rankLandingSites({
  sites: [{ id: 'dark', lat: -87, lon: 0 }, { id: 'b', lat: -85, lon: 0 }, { id: 'a', lat: -86, lon: 0 }],
  landT: biakPlan.land,
  stepMin: 30,
  surfaceDays: 7,
  seriesAt: (site) => synMap[site.id],
})
assert(synRank1.length === 3 && synRank1[0].score === synRank1[1].score, 'days 8..30 must not change 7-day score')
assert(synRank1[0].pLit === synRank1[1].pLit && synRank1[0].longestNightH === synRank1[1].longestNightH, 'days 8..30 leaked into surface metrics')
assert(synRank1.map((r) => r.site.id).join(',') === synRank2.map((r) => r.site.id).join(','), 'ranking order not deterministic')
assert(synRank1[0].litNow === true && synRank1[2].site.id === 'dark', 'lit touchdown candidate must outrank dark touchdown')

const nodemRank = rankLandingSites({
  sites: [{ id: 'nodem', lat: 0, lon: 0 }, { id: 'dark', lat: -87, lon: 0 }],
  landT: biakPlan.land,
  surfaceDays: 7,
  hasDem: (site) => site.id !== 'nodem',
  seriesAt: (site) => (site.id === 'nodem' ? synMap.b : synMap.dark),
})
assert(nodemRank.length === 1 && nodemRank[0].site.id === 'dark', 'site without DEM must never place #1')

const synOv = {
  n: 5, spacing: 2500,
  lit: new Float32Array(25).fill(0.5),
  see: new Float32Array(25).fill(0.5),
  both: new Float32Array(25).fill(0.4),
}
synOv.lit[2 * 5 + 3] = 0.9; synOv.see[2 * 5 + 3] = 0.95; synOv.both[2 * 5 + 3] = 0.85 // (i=3, j=2) => +2.5 km east
const tipOv = bestNearbyFromOverlay(synOv, { lat: -85, lon: 0 })
assert(tipOv && Math.abs(tipOv.distKm - 2.5) < 0.01 && tipOv.dir === 'east' && Math.abs(tipOv.lit - 0.9) < 1e-6, 'bestNearbyFromOverlay mismatch')

// 5 s real-time liftoff (0 → 100 m) & 10 s gentle touchdown (260 → 0 m)
const mLift0 = missionState(biakPlan, biakPlan.launch)
const mLift5 = missionState(biakPlan, biakPlan.launch + 5000)
const mLand10 = missionState(biakPlan, biakPlan.land - 10000)
const mLand5 = missionState(biakPlan, biakPlan.land - 5000)
assert(mLift0.phase === 'ascent' && mLift0.alt === 0 && mLift0.uAsc === 0, 'liftoff t=0 mismatch')
assert(Math.abs(mLift5.alt - 0.1) < 1e-9 && Math.abs(mLift5.v - 0.04) < 1e-9 && mLift5.uAsc === 0, 'liftoff t=5s mismatch')
assert(mLand10.phase === 'descent' && Math.abs(mLand10.alt - 0.26) < 1e-9 && Math.abs(mLand10.v - 0.035) < 1e-9 && mLand10.uDesc === 1, 'landing rem=10s mismatch')
assert(Math.abs(mLand5.alt - 0.26 * Math.pow(0.5, 1.55)) < 1e-9 && Math.abs(mLand5.v - 0.0175) < 1e-9 && mLand5.uDesc === 1, 'landing rem=5s mismatch')
const liftPos5 = craftPosition(biakPlan, biakPlan.launch + 5000, testSites[0]).pos
const liftPad5 = padVec(biakPlan.pad, biakPlan.launch + 5000)
const liftDot = (liftPos5[0] * liftPad5[0] + liftPos5[1] * liftPad5[1] + liftPos5[2] * liftPad5[2]) / (Math.hypot(...liftPos5) * Math.hypot(...liftPad5))
assert(liftDot > 0.999999 && Math.abs(Math.hypot(...liftPos5) - (6378.137 + 0.1)) < 1e-6, 'liftoff 5s must be purely vertical above pad')

console.log({ sun: [sMin, sMax], earth: [eMin, eMax], shackletonFloor: floor, hzMin: Math.min(...hz), jplMaxDiff: jpl.max, medS, medN, maxSummit: Math.round(maxSummit), a11Lit: +a11.pLit.toFixed(3), biakTop: `${ranked[0].site.id}:${ranked[0].score.toFixed(1)}` })
console.log('OK')
