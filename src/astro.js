// Sun & Earth azimuth/elevation as seen from a point on the lunar surface.
// Moon orientation comes from the IAU rotation model in astronomy-engine
// (includes the main physical libration terms), so Earth's wobble in the sky is real.
import * as A from 'astronomy-engine'

const D = Math.PI / 180
const MOON_R_AU = 1737.4 / 149597870.7

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const add = (...vs) => vs.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0])
const norm = (a) => scale(a, 1 / Math.hypot(...a))
const vec = (v) => [v.x, v.y, v.z]

// Moon body-fixed axes (X = prime meridian, Z = north pole) in J2000 equatorial.
function moonFrame(time) {
  const ax = A.RotationAxis(A.Body.Moon, time)
  const z = vec(ax.north)
  const ra = ax.ra * 15 * D
  const node = [-Math.sin(ra), Math.cos(ra), 0]
  const q = cross(z, node)
  const W = ax.spin * D
  const x = add(scale(node, Math.cos(W)), scale(q, Math.sin(W)))
  return { x, y: cross(z, x), z }
}

function azEl(d, up, east, north) {
  const u = norm(d)
  return {
    az: (Math.atan2(dot(u, east), dot(u, north)) / D + 360) % 360,
    el: Math.asin(dot(u, up)) / D,
  }
}

// Moon body-fixed axes in J2000 equatorial (X = prime meridian, Z = north pole), for drawing.
export const moonAxes = (date) => moonFrame(A.MakeTime(date))

// Site-independent part: compute once per timestamp, reuse for every site.
export function ephem(date) {
  const t = A.MakeTime(date)
  return { f: moonFrame(t), moon: vec(A.GeoMoon(t)), sun: vec(A.GeoVector(A.Body.Sun, t, false)) }
}

// lat/lon in degrees (planetocentric, east-positive), heightM above 1737.4 km sphere.
export const sunEarth = (lat, lon, date, heightM = 0) => look(ephem(date), lat, lon, heightM)

// Local up/east/north of a lunar site, as J2000 equatorial unit vectors.
function siteAxes(f, lat, lon) {
  const la = lat * D, lo = lon * D
  const up = add(
    scale(f.x, Math.cos(la) * Math.cos(lo)),
    scale(f.y, Math.cos(la) * Math.sin(lo)),
    scale(f.z, Math.sin(la)),
  )
  // ponytail: at exactly ±90° east is undefined; nudge so the frame stays valid.
  const eastRaw = cross(f.z, up)
  const east = Math.hypot(...eastRaw) < 1e-9 ? norm(cross(f.z, f.x)) : norm(eastRaw)
  return { up, east, north: cross(up, east) }
}

export function look({ f, moon, sun: sunGeo }, lat, lon, heightM = 0) {
  const { up, east, north } = siteAxes(f, lat, lon)
  const site = add(moon, scale(up, MOON_R_AU * (1 + heightM / 1737400)))
  // Geometric Sun (no light-time); matches JPL Horizons to <0.01° anyway (see check.mjs).
  const sun = sub(sunGeo, site)
  const earth = scale(site, -1)
  return { sun: azEl(sun, up, east, north), earth: azEl(earth, up, east, north) }
}

const AU_KM = 149597870.7
// How Earth and the Sun look from a lunar site, for drawing them in the 3D scene
// (scene frame: x = east, y = up, z = south).
// x/y/z: Earth-fixed axes (Greenwich, 90°E, north pole) → Earth's rotation, so the right
// continents face the Moon. earthR/sunR: true angular radii (deg) at the current distances.
// subLat/subLon: the point on Earth directly below the Moon.
// ponytail: Earth pole taken as J2000 +Z (precession ~0.3°), invisible at these sizes.
export function skyPose(date, lat, lon) {
  const t = A.MakeTime(date), { f, moon, sun } = ephem(date)
  const { up, east, north } = siteAxes(f, lat, lon)
  const toScene = (v) => [dot(v, east), dot(v, up), -dot(v, north)]
  const g = A.SiderealTime(t) * 15 * D
  const X = [Math.cos(g), Math.sin(g), 0], Y = [-Math.sin(g), Math.cos(g), 0], Z = [0, 0, 1]
  const dEarth = Math.hypot(...moon) * AU_KM, dSun = Math.hypot(...sub(sun, moon)) * AU_KM
  const m = norm(moon) // Earth → Moon
  return {
    x: toScene(X), y: toScene(Y), z: toScene(Z),
    earthR: Math.asin(6378.137 / dEarth) / D,
    sunR: Math.asin(695700 / dSun) / D,
    subLat: Math.asin(dot(m, Z)) / D,
    subLon: Math.atan2(dot(m, Y), dot(m, X)) / D,
  }
}
