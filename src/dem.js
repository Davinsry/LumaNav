// Lunar elevation grids (LRO LOLA GDR) and spherical/polar coordinate helpers.
// Supports 240 m/px polar stereographic caps ('75S', '75N') and global simple cylindrical ('16').

export const N = 3812
export const PX = 240
export const R = 1737400
const C = N / 2 - 0.5 // 0-based pixel of the pole
const D = Math.PI / 180

const wrapLon = (lon) => {
  const w = ((lon + 180) % 360 + 360) % 360 - 180
  return w === -180 && lon > 0 ? 180 : w
}

const toInt16 = (buf) => {
  if (buf instanceof Int16Array) return buf
  if (ArrayBuffer.isView(buf)) return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
  return new Int16Array(buf) // little-endian on every machine we demo on
}

export function parseDem(buf) {
  return new Int16Array(buf) // little-endian on every machine we demo on
}

// Polar stereographic map projection (m from pole). Defaults to South Pole for legacy callers.
function polarToMap(hemi, lat, lon) {
  const l = lon * D
  if (hemi === 'N') {
    const r = 2 * R * Math.tan(((90 - lat) * 0.5) * D)
    return [r * Math.sin(l), -r * Math.cos(l)]
  }
  const r = 2 * R * Math.tan(((90 + lat) * 0.5) * D)
  return [r * Math.sin(l), r * Math.cos(l)]
}

function polarAxes(hemi, lon) {
  const l = lon * D
  if (hemi === 'N') {
    // North polar map has Y pointing toward 180°E, so decreasing r (North) goes (-sin l, +cos l).
    return { north: [-Math.sin(l), Math.cos(l)], east: [Math.cos(l), Math.sin(l)] }
  }
  return { north: [Math.sin(l), Math.cos(l)], east: [Math.cos(l), -Math.sin(l)] }
}

function samplePolar(data, X, Y) {
  const c = X / PX + C, r = -Y / PX + C
  const c0 = Math.floor(c), r0 = Math.floor(r)
  if (c0 < 0 || r0 < 0 || c0 >= N - 1 || r0 >= N - 1) return NaN
  const fc = c - c0, fr = r - r0, i = r0 * N + c0
  const h = data[i] * (1 - fc) * (1 - fr) + data[i + 1] * fc * (1 - fr) +
    data[i + N] * (1 - fc) * fr + data[i + N + 1] * fc * fr
  return h * 0.5
}

function sampleCyl(data, ppd, width, heightPx, lat, lon) {
  if (lat < -90 || lat > 90 || !Number.isFinite(lat) || !Number.isFinite(lon)) return NaN
  const lon360 = ((lon % 360) + 360) % 360
  const c = lon360 * ppd - 0.5
  const cFloor = Math.floor(c), fc = c - cFloor
  const c0 = ((cFloor % width) + width) % width
  const c1 = (c0 + 1) % width

  const row = (90 - lat) * ppd - 0.5
  let r0, r1, fr
  if (row <= 0) { r0 = r1 = 0; fr = 0 }
  else if (row >= heightPx - 1) { r0 = r1 = heightPx - 1; fr = 0 }
  else { r0 = Math.floor(row); r1 = r0 + 1; fr = row - r0 }

  const i0 = r0 * width, i1 = r1 * width
  const h = data[i0 + c0] * (1 - fc) * (1 - fr) + data[i0 + c1] * fc * (1 - fr) +
    data[i1 + c0] * (1 - fc) * fr + data[i1 + c1] * fc * fr
  return h * 0.5
}

// Generic DEM provider factory:
// - { kind: 'polar', hemi: 'S'|'N', buf } -> LOLA 240 m/px polar stereographic
// - { kind: 'cyl', ppd: 16, buf } -> LOLA global simple cylindrical
export function makeDem(spec) {
  const data = toInt16(spec.buf ?? spec.data)
  if (spec.kind === 'polar') {
    const hemi = spec.hemi === 'N' ? 'N' : 'S'
    const id = hemi === 'S' ? '75S' : '75N'
    return {
      id,
      kind: 'polar',
      hemi,
      res: PX,
      data,
      covers: (lat) => (hemi === 'S' ? lat <= -75.2 : lat >= 75.2),
      height: (lat, lon) => {
        const [X, Y] = polarToMap(hemi, lat, lon)
        return samplePolar(data, X, Y)
      },
    }
  }
  const ppd = spec.ppd ?? 16
  const width = 360 * ppd
  const heightPx = 180 * ppd
  const res = (Math.PI * R) / (180 * ppd)
  return {
    id: String(ppd),
    kind: 'cyl',
    hemi: null,
    ppd,
    res,
    data,
    covers: (lat) => lat >= -90 && lat <= 90,
    height: (lat, lon) => sampleCyl(data, ppd, width, heightPx, lat, lon),
  }
}

export const demKeyFor = (lat) => (lat <= -75.2 ? '75S' : lat >= 75.2 ? '75N' : '16')

// Pick the highest-resolution loaded DEM that covers `lat`.
export function terrainFor(dems, lat) {
  if (!dems) return null
  const get = typeof dems.get === 'function' ? (k) => dems.get(k)
    : Array.isArray(dems) ? (k) => dems.find((d) => d?.id === k)
    : (k) => dems[k]
  return get(demKeyFor(lat)) || get('16') || null
}

// Destination (lat, lon) on spherical Moon after moving `distM` along azimuth `azDeg` (0=N, 90=E).
export function destLL(lat0, lon0, azDeg, distM) {
  if (!distM) return [lat0, wrapLon(lon0)]
  const d = distM / R, az = azDeg * D
  const phi = lat0 * D, lam = lon0 * D
  const sinP = Math.sin(phi), cosP = Math.cos(phi)
  const sinL = Math.sin(lam), cosL = Math.cos(lam)
  const cD = Math.cos(d), sD = Math.sin(d)
  const ca = Math.cos(az), sa = Math.sin(az)
  const tx = ca * (-sinP * cosL) + sa * (-sinL)
  const ty = ca * (-sinP * sinL) + sa * cosL
  const tz = ca * cosP
  const px = cosP * cosL * cD + tx * sD
  const py = cosP * sinL * cD + ty * sD
  const pz = sinP * cD + tz * sD
  return [
    Math.asin(pz > 1 ? 1 : pz < -1 ? -1 : pz) / D,
    wrapLon(Math.atan2(py, px) / D),
  ]
}

// Geodesic offset in local east/north meters from (lat0, lon0).
export function offsetLL(lat0, lon0, eastM, northM) {
  if (!eastM && !northM) return [lat0, wrapLon(lon0)]
  return destLL(lat0, lon0, Math.atan2(eastM, northM) / D, Math.hypot(eastM, northM))
}

// Legacy polar South helpers preserved for existing south-polar tests and transition callers.
export function toMap(lat, lon) {
  return polarToMap('S', lat, lon)
}
export function toLatLon(X, Y) {
  const r = Math.hypot(X, Y)
  return [-90 + (2 * Math.atan(r / (2 * R))) / D, Math.atan2(X, Y) / D]
}
export const inDem = (lat) => lat <= -75.2
export function heightAt(dem, X, Y) {
  const data = dem instanceof Int16Array ? dem : dem?.data
  return data ? samplePolar(data, X, Y) : NaN
}
export function localAxes(lon) {
  return polarAxes('S', lon)
}

const legacyCache = new WeakMap()
const asDem = (dem) => {
  if (!dem) return null
  if (typeof dem.height === 'function') return dem
  if (dem instanceof Int16Array) {
    let wrapped = legacyCache.get(dem)
    if (!wrapped) {
      wrapped = makeDem({ kind: 'polar', hemi: 'S', buf: dem })
      legacyCache.set(dem, wrapped)
    }
    return wrapped
  }
  return null
}

// Terrain horizon elevation (deg) for each azimuth step, including lunar curvature.
// Pass `dist` (Float32Array(steps)) to also get the distance (m) of the blocking terrain.
export function horizon(demOrArr, lat, lon, { steps = 720, maxDist = 150000, eye = 2, dist = null } = {}) {
  const out = new Float32Array(steps)
  const d = asDem(demOrArr)
  if (!d || !d.covers(lat, lon)) return out

  if (d.kind === 'polar') {
    // ponytail: keeps fast planar ray-march inside polar cap (<2% stereographic scale factor); geodesic rays used globally.
    const [x0, y0] = polarToMap(d.hemi, lat, lon)
    const h0 = samplePolar(d.data, x0, y0) + eye
    if (!Number.isFinite(h0)) return out
    const { north, east } = polarAxes(d.hemi, lon)
    const step0 = Math.max(d.res, PX)
    for (let k = 0; k < steps; k++) {
      const az = (k * 360 / steps) * D
      const dx = Math.cos(az) * north[0] + Math.sin(az) * east[0]
      const dy = Math.cos(az) * north[1] + Math.sin(az) * east[1]
      let best = -90, bestS = 0
      for (let s = step0; s <= maxDist; s += s < 20000 ? step0 : step0 * 2) {
        const h = samplePolar(d.data, x0 + dx * s, y0 + dy * s)
        if (Number.isNaN(h)) break
        const a = Math.atan2(h - h0 - (s * s) / (2 * R), s)
        if (a > best) { best = a; bestS = s }
      }
      out[k] = best / D
      if (dist) dist[k] = bestS
    }
    return out
  }

  const h0 = d.height(lat, lon) + eye
  if (!Number.isFinite(h0)) return out
  const phi = lat * D, lam = lon * D
  const sinP = Math.sin(phi), cosP = Math.cos(phi)
  const sinL = Math.sin(lam), cosL = Math.cos(lam)
  const p0x = cosP * cosL, p0y = cosP * sinL, p0z = sinP
  const n3x = -sinP * cosL, n3y = -sinP * sinL, n3z = cosP
  const e3x = -sinL, e3y = cosL

  const step = Math.max(d.res, PX)
  const dAngle = step / R
  const cs = Math.cos(dAngle), ss = Math.sin(dAngle)
  const ppd = d.ppd, width = 360 * ppd, heightPx = 180 * ppd, data = d.data

  for (let k = 0; k < steps; k++) {
    const az = (k * 360 / steps) * D
    const ca = Math.cos(az), sa = Math.sin(az)
    const tx = ca * n3x + sa * e3x
    const ty = ca * n3y + sa * e3y
    const tz = ca * n3z
    let best = -90, bestS = 0
    let cD = cs, sD = ss
    for (let s = step; s <= maxDist; s += step) {
      const px = p0x * cD + tx * sD
      const py = p0y * cD + ty * sD
      const pz = p0z * cD + tz * sD
      const sLat = Math.asin(pz > 1 ? 1 : pz < -1 ? -1 : pz) / D
      const sLon = Math.atan2(py, px) / D
      const h = sampleCyl(data, ppd, width, heightPx, sLat, sLon)
      if (!Number.isNaN(h)) {
        const a = Math.atan2(h - h0 - (s * s) / (2 * R), s)
        if (a > best) { best = a; bestS = s }
      }
      const nextC = cD * cs - sD * ss
      sD = sD * cs + cD * ss
      cD = nextC
    }
    out[k] = best / D
    if (dist) dist[k] = bestS
  }
  return out
}

export const horizonAt = (hz, az) => hz[Math.round(az / 360 * hz.length) % hz.length]
