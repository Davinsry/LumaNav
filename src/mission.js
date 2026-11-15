// Rough Earth → lunar-surface mission estimate: timeline, Δv budget, propellant, speeds.
// Deliberately simple (typical published Δv per phase + Tsiolkovsky), labelled as an estimate
// in the UI. Its real job is turning a launch date into a landing date for the site analysis.
import * as A from 'astronomy-engine'
import { moonAxes } from './astro.js'

const MU_EARTH = 398600.4418 // km³/s²
const R_EARTH = 6378.137 // km
const AU_KM = 149597870.7
const G0 = 9.80665
const LEO_ALT = 200 // km parking orbit
const DAY = 864e5

// Typical values (km/s, days). Low-energy = ballistic lunar transfer as flown by CAPSTONE.
export const ROUTES = {
  fast: { name: 'Fast (Apollo-style)', days: 3.0, tli: 3.15, loi: 0.9 },
  artemis: { name: 'Standard (Artemis-style)', days: 5.0, tli: 3.1, loi: 0.85 },
  low: { name: 'Low-energy (CAPSTONE-style)', days: 110, tli: 3.2, loi: 0.65 },
}
export const ENGINES = {
  hyper: { name: 'Hypergolic', isp: 315 },
  methane: { name: 'Methane/LOX', isp: 360 },
  hydrogen: { name: 'Hydrogen/LOX', isp: 450 },
}
// Launch sites (geodetic lat/lon, degrees east-positive).
export const PADS = {
  biak: { name: 'Biak, Papua (Indonesia)', lat: -1.17, lon: 136.1 },
  ksc: { name: 'Kennedy, Florida (USA)', lat: 28.573, lon: -80.649 },
  baikonur: { name: 'Baikonur, Kazakhstan', lat: 45.965, lon: 63.305 },
  kourou: { name: 'Kourou, French Guiana', lat: 5.239, lon: -52.768 },
  sriharikota: { name: 'Sriharikota, India', lat: 13.72, lon: 80.23 },
  wenchang: { name: 'Wenchang, China', lat: 19.614, lon: 110.951 },
}
// Pad direction (unit vector, J2000 equatorial) at time t: the pad turns with Earth's sidereal time.
// ponytail: spherical Earth and no precession (~0.4° in 2026), same as the 3D Earth it sits on.
export function padVec(pad, t) {
  const g = (A.SiderealTime(A.MakeTime(new Date(t))) * 15 + pad.lon) * Math.PI / 180, la = pad.lat * Math.PI / 180
  return [Math.cos(la) * Math.cos(g), Math.cos(la) * Math.sin(g), Math.sin(la)]
}
const ASCENT_RAD = 0.25 // ~1,600 km downrange from liftoff to orbit insertion

const DV_TCM = 0.05 // trajectory correction allowance
const DV_DESCENT = 2.0 // ~100 km lunar orbit to touchdown, incl. hover margin

const moonVec = (t) => { const v = A.GeoMoon(A.MakeTime(new Date(t))); return [v.x * AU_KM, v.y * AU_KM, v.z * AU_KM] }

// Transfer ellipse from perigee rp that reaches distance D after `tof` seconds.
// Faster-than-Hohmann trips need a bigger ellipse (apogee beyond the Moon); slower ones are
// clamped to Hohmann (a direct ellipse can't take longer). Solved by bisection on a.
function solveTransfer(rp, D, tof) {
  const at = (a) => {
    const e = 1 - rp / a, E = Math.acos(Math.max(-1, Math.min(1, (1 - D / a) / e)))
    return { a, e, E, t: (E - e * Math.sin(E)) * Math.sqrt(a ** 3 / MU_EARTH) }
  }
  let lo = (rp + D) / 2, hi = 60 * D, best = at(lo)
  if (best.t > tof) {
    for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; best = at(mid); if (best.t > tof) lo = mid; else hi = mid }
  }
  const { a, e, E } = best
  return { a, e, Mend: E - e * Math.sin(E), nuEnd: 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2)) }
}

// Position on the transfer at coast fraction f: radius r (km) and true anomaly nu.
// Kepler's equation by bisection: Newton diverges on these very eccentric (e ≈ 0.98) orbits.
function transferAt(tr, f) {
  const M = tr.Mend * f
  let lo = 0, hi = Math.PI
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (mid - tr.e * Math.sin(mid) < M) lo = mid; else hi = mid }
  const E = (lo + hi) / 2
  return { r: tr.a * (1 - tr.e * Math.cos(E)), nu: 2 * Math.atan2(Math.sqrt(1 + tr.e) * Math.sin(E / 2), Math.sqrt(1 - tr.e) * Math.cos(E / 2)) }
}

/**
 * launch: ms UTC · route/engine: keys above · dryKg: lander dry mass + payload · waitDays: time in
 * lunar orbit before descent. TLI is done by the launch vehicle's upper stage (as for most
 * robotic landers); the lander burns for corrections, orbit insertion and descent.
 */
export function planMission({ launch, pad = 'ksc', route = 'artemis', engine = 'hyper', dryKg = 1500, waitDays = 1 }) {
  const r = ROUTES[route], isp = ENGINES[engine].isp, site = PADS[pad] ?? PADS.ksc
  const rLeo = R_EARTH + LEO_ALT

  // One plane holds the pad at liftoff and the Moon at arrival, so the rocket climbs from the
  // pad, coasts in a parking orbit and leaves at TLI without a plane change. The parking orbit
  // lasts 1–2 revolutions: until the craft reaches the transfer's perigee. Arrival depends on
  // TLI and the plane on arrival, so iterate (converges in a couple of passes).
  const P = padVec(site, launch), asc = launch + ASCENT_MIN * 60e3
  let tli = launch + 2.5 * 3600e3, plane, transfer
  for (let i = 0; i < 4; i++) {
    const mA = moonVec(tli + r.days * DAY)
    transfer = solveTransfer(rLeo, Math.hypot(...mA), r.days * 86400)
    plane = transferPlane(P, mA, moonVec(tli + r.days * DAY - 3600e3))
    const perigee = r.days < 20 ? -transfer.nuEnd : Math.PI
    const sweep = (((perigee - plane.thPad - ASCENT_RAD) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) + 2 * Math.PI
    tli = asc + (sweep / (2 * Math.PI)) * LEO_P
  }
  const arrive = tli + r.days * DAY
  const land = arrive + waitDays * DAY

  const dvLander = DV_TCM + r.loi + DV_DESCENT
  const m0 = dryKg * Math.exp((dvLander * 1000) / (isp * G0))

  const vLeo = Math.sqrt(MU_EARTH / rLeo)
  const mA = moonVec(arrive), mL = moonVec(launch)
  const distKm = Math.hypot(...mA)

  return {
    transfer, plane, pad: site,
    route: r, isp, launch, tli, arrive, land,
    dv: { leo: 9.4, tli: r.tli, tcm: DV_TCM, loi: r.loi, descent: DV_DESCENT, lander: dvLander },
    m0, prop: m0 - dryKg, dryKg,
    vLeo, vAfterTli: vLeo + r.tli,
    vAvg: distKm / (r.days * 86400),
    distKm,
    // Moon positions projected on Earth's equatorial plane (km), for the 2D diagram.
    moonAtLaunch: [mL[0], mL[1]], moonAtArrive: [mA[0], mA[1]],
  }
}

/**
 * Solve the Earth launch timestamp that arrives & touches down at target epoch `land` (UTC ms)
 * for the selected launch pad, transfer route, engine, mass, and lunar-orbit wait duration.
 */
export function solveLaunchForLanding({ land, pad = 'ksc', route = 'artemis', engine = 'hyper', dryKg = 1500, waitDays = 1 }) {
  const r = ROUTES[route] ?? ROUTES.artemis
  let t = land - (r.days + waitDays) * DAY - 2.3 * 3600e3
  let best = null
  let bestErr = Infinity
  for (let i = 0; i < 6; i++) {
    const p = planMission({ launch: t, pad, route, engine, dryKg, waitDays })
    const err = Math.abs(land - p.land)
    if (err < bestErr) { best = p; bestErr = err }
    if (err <= 1000) break
    t += land - p.land
  }
  return best
}

// ---------- 3D craft position (geocentric J2000 equatorial, km) for the space view ----------
const R_MOON = 1737.4, LLO_R = R_MOON + 100
const LEO_P = 88.5 * 60e3, LLO_P = 118 * 60e3, LLO_LEAD = 0.35 // rad of orbit flown during descent
const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sc: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l] },
  lerp: (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k],
}

// Plane through Earth's centre, the pad at liftoff (P) and the Moon at arrival (mA). x = toward the
// Moon, y = prograde. The normal points north so the launch heads east, like real launches.
// Falls back to the Moon's orbital plane if the Moon is straight above the pad.
function transferPlane(P, mA, mPrev) {
  let n = v3.cross(P, mA)
  if (Math.hypot(...n) < 1e-3 * Math.hypot(...mA)) n = v3.cross(mPrev, mA)
  n = v3.norm(n); if (n[2] < 0) n = v3.sc(n, -1)
  const e1 = v3.norm(mA), e2 = v3.cross(n, e1)
  return { e1, e2, n, D: Math.hypot(...mA), thPad: Math.atan2(v3.dot(P, e2), v3.dot(P, e1)) }
}

// Fixed geometry for one plan: transfer plane (see transferPlane) and the polar
// lunar orbit that passes over the landing site at touchdown.
const geomCache = new WeakMap()
function planGeom(p, site) {
  const key = `${site.lat},${site.lon}`
  const hit = geomCache.get(p)
  if (hit && hit.key === key) return hit
  const { e1, e2, D } = p.plane
  const ax = moonAxes(new Date(p.land)), la = site.lat * Math.PI / 180, lo = site.lon * Math.PI / 180
  const s = v3.add(v3.add(v3.sc(ax.x, Math.cos(la) * Math.cos(lo)), v3.sc(ax.y, Math.cos(la) * Math.sin(lo))), v3.sc(ax.z, Math.sin(la)))
  const pole = ax.z, eqRaw = v3.add(s, v3.sc(pole, -v3.dot(s, pole)))
  const q = Math.hypot(...eqRaw) < 1e-6 ? ax.x : v3.norm(eqRaw) // site exactly at a pole
  const g = { key, D, e1, e2, pole, q, phiSite: Math.atan2(v3.dot(s, pole), v3.dot(s, q)) }
  geomCache.set(p, g)
  return g
}

// Point in the transfer plane: 2D (x toward the Moon at arrival, y = prograde) → 3D.
const inPlane = (g, x, y) => v3.add(v3.sc(g.e1, x), v3.sc(g.e2, y))

function coast2D(p, g, f) {
  const rp = R_EARTH + LEO_ALT
  if (p.route.days < 20) {
    // Perigee placed so the arrival point (true anomaly nuEnd) lies on +x, toward the Moon.
    const { r, nu } = transferAt(p.transfer, f), th = nu - p.transfer.nuEnd
    return [r * Math.cos(th), r * Math.sin(th)]
  }
  // ponytail: low-energy route as two Béziers out to ~3 lunar distances and back (shape only).
  const D = g.D, bez = (p0, p1, p2, p3, t) => p0.map((_, i) => (1 - t) ** 3 * p0[i] + 3 * (1 - t) ** 2 * t * p1[i] + 3 * (1 - t) * t * t * p2[i] + t ** 3 * p3[i])
  return f < 0.5
    ? bez([-rp, 0], [-0.6 * D, -1.5 * D], [1.9 * D, -2.2 * D], [3.1 * D, -0.4 * D], f / 0.5)
    : bez([3.1 * D, -0.4 * D], [3.8 * D, 1.2 * D], [1.7 * D, 0.9 * D], [D, 0], (f - 0.5) / 0.5)
}

const lloPoint = (g, moon, r, phi) => v3.add(moon, v3.add(v3.sc(g.q, r * Math.cos(phi)), v3.sc(g.pole, r * Math.sin(phi))))
const lloPhi = (p, g, t) => g.phiSite - LLO_LEAD - (2 * Math.PI * (p.land - DESCENT_MIN * 60e3 - t)) / LLO_P

/** Where the craft is at time t: { s (missionState), pos, moon } — vectors in km, J2000 equatorial. */
export function craftPosition(p, t, site) {
  const s = missionState(p, t), g = planGeom(p, site), moon = moonVec(t)
  let pos
  if (s.phase === 'ascent') {
    // Rotate with the pad during the 5 s vertical liftoff, then blend cleanly into eastward orbit plane
    const uAsc = s.uAsc ?? 0, r = R_EARTH + s.alt
    const padUpPos = v3.sc(padVec(p.pad, t), r)
    if (uAsc <= 0) {
      pos = padUpPos
    } else {
      const th = p.plane.thPad + ASCENT_RAD * uAsc * uAsc
      const orbPos = inPlane(g, r * Math.cos(th), r * Math.sin(th))
      const blend = Math.min(1, uAsc / 0.05)
      pos = v3.sc(v3.norm(v3.lerp(padUpPos, orbPos, blend)), r)
    }
  } else if (s.phase === 'leo' || s.phase === 'tli') {
    // LEO ends at the transfer's perigee direction at TLI, so the path is continuous.
    const perigee = p.route.days < 20 ? -p.transfer.nuEnd : Math.PI
    const th = perigee - (2 * Math.PI * (p.tli - t)) / LEO_P, r = R_EARTH + s.alt
    pos = inPlane(g, r * Math.cos(th), r * Math.sin(th))
  } else if (s.phase === 'coast') {
    pos = inPlane(g, ...coast2D(p, g, s.f))
    // last 3% of the coast eases onto the lunar orbit (the real capture burn is not modelled)
    if (s.f > 0.97) {
      pos = v3.lerp(pos, lloPoint(g, moonVec(p.arrive), LLO_R, lloPhi(p, g, p.arrive)), (s.f - 0.97) / 0.03)
      // the straight blend can cut through the Moon; keep it at orbit height or above
      const rel = v3.add(pos, v3.sc(moon, -1)), d = Math.hypot(...rel)
      if (d < LLO_R) pos = v3.add(moon, v3.sc(rel, LLO_R / d))
    }
  } else if (s.phase === 'loi' || s.phase === 'llo') {
    pos = lloPoint(g, moon, LLO_R, lloPhi(p, g, t))
  } else if (s.phase === 'descent') {
    const uDesc = s.uDesc ?? 1
    const ax = moonAxes(new Date(t)), la = site.lat * Math.PI / 180, lo = site.lon * Math.PI / 180
    const sv = v3.add(v3.add(v3.sc(ax.x, Math.cos(la) * Math.cos(lo)), v3.sc(ax.y, Math.cos(la) * Math.sin(lo))), v3.sc(ax.z, Math.sin(la)))
    const padPos = v3.add(moon, v3.sc(sv, R_MOON + s.alt))
    if (uDesc >= 1) {
      pos = padPos
    } else {
      const orbPos = lloPoint(g, moon, R_MOON + s.alt, g.phiSite - LLO_LEAD * (1 - uDesc))
      const blend = Math.max(0, (uDesc - 0.9) / 0.1)
      pos = v3.lerp(orbPos, padPos, blend)
    }
  } else { // landed: on the site, turning with the Moon
    const ax = moonAxes(new Date(t)), la = site.lat * Math.PI / 180, lo = site.lon * Math.PI / 180
    const sv = v3.add(v3.add(v3.sc(ax.x, Math.cos(la) * Math.cos(lo)), v3.sc(ax.y, Math.cos(la) * Math.sin(lo))), v3.sc(ax.z, Math.sin(la)))
    pos = v3.add(moon, v3.sc(sv, R_MOON))
  }
  return { s, pos, moon }
}

// Moon's direction (radians) in Earth's equatorial plane at time t, for animating its orbit.
export const moonAngle = (t) => { const m = moonVec(t); return Math.atan2(m[1], m[0]) }

const ASCENT_MIN = 9 // minutes from liftoff to orbit
const DESCENT_MIN = 15 // minutes from lunar orbit to touchdown
const V_LLO = 1.633 // km/s, circular orbit 100 km above the Moon

/**
 * Mission state at time t (ms UTC) for the animation and telemetry.
 * phase: ascent | leo | tli | coast | loi | llo | descent | landed.
 * f: progress 0..1 inside the coast (used to place the craft on the drawn path).
 * Coast speed/distance follow a Keplerian transfer ellipse from LEO to the Moon's distance,
 * with time stretched to the route's duration (good enough for a rough readout).
 */
export function missionState(p, t) {
  const g0isp = p.isp * G0 / 1000 // km/s
  const afterLoi = p.m0 / Math.exp((DV_TCM + p.dv.loi) / g0isp)
  const rLeo = R_EARTH + LEO_ALT
  const ascentEnd = p.launch + ASCENT_MIN * 60e3
  const descentStart = p.land - DESCENT_MIN * 60e3
  const s = { t, met: (t - p.launch) / 3600e3, mass: p.m0, f: 0 }

  if (t < ascentEnd) {
    const dt = Math.max(0, (t - p.launch) / 1000), dur = (ascentEnd - p.launch) / 1000
    const k = dt / dur
    if (dt <= 5) {
      const w = dt / 5
      return { ...s, phase: 'ascent', k, uAsc: 0, dt, v: 0.04 * w, alt: 0.1 * w * w, ref: 'earth' }
    }
    const uAsc = (dt - 5) / (dur - 5)
    return { ...s, phase: 'ascent', k, uAsc, dt, v: 0.04 + (p.vLeo - 0.04) * uAsc * uAsc, alt: 0.1 + (LEO_ALT - 0.1) * Math.sin((uAsc * Math.PI) / 2), ref: 'earth' }
  }
  if (t < p.tli - 6 * 60e3) return { ...s, phase: 'leo', v: p.vLeo, alt: LEO_ALT, ref: 'earth' }
  if (t < p.tli) return { ...s, phase: 'tli', v: p.vLeo + p.dv.tli * (1 - (p.tli - t) / 360e3), alt: LEO_ALT, ref: 'earth' }
  if (t < p.arrive) {
    const f = (t - p.tli) / (p.arrive - p.tli)
    const { r } = transferAt(p.transfer, f)
    // the low-energy route wanders much farther out; distance shown is the direct-ellipse estimate
    return { ...s, phase: 'coast', f, v: Math.sqrt(MU_EARTH * (2 / r - 1 / p.transfer.a)), dist: r, ref: 'earth', mass: p.m0 }
  }
  if (t < p.arrive + 20 * 60e3) return { ...s, phase: 'loi', f: 1, v: V_LLO, alt: 100, ref: 'moon', mass: afterLoi }
  if (t < descentStart) return { ...s, phase: 'llo', f: 1, v: V_LLO, alt: 100, ref: 'moon', mass: afterLoi }
  if (t < p.land) {
    const k = (t - descentStart) / (p.land - descentStart)
    const rem = Math.max(0, (p.land - t) / 1000), dur = (p.land - descentStart) / 1000
    const mass = afterLoi - (afterLoi - p.dryKg) * k
    if (rem <= 10) {
      const w = rem / 10
      return { ...s, phase: 'descent', f: 1, k, rem, uDesc: 1, v: 0.035 * w, alt: 0.26 * Math.pow(w, 1.55), ref: 'moon', mass }
    }
    const uDesc = Math.min(1, (dur - rem) / (dur - 10))
    return { ...s, phase: 'descent', f: 1, k, rem, uDesc, v: 0.035 + (V_LLO - 0.035) * (1 - uDesc), alt: 0.26 + (100 - 0.26) * Math.pow(1 - uDesc, 1.55), ref: 'moon', mass }
  }
  return { ...s, phase: 'landed', f: 1, rem: 0, uDesc: 1, v: 0, alt: 0, ref: 'moon', mass: p.dryKg }
}
