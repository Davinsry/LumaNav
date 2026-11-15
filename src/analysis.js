// Heavier analyses, kept pure so they run in a worker and in Node tests.
import { ephem, look } from './astro.js'
import { horizon, horizonAt, offsetLL, inDem } from './dem.js'
import { makeInsight } from './insight.js'

const H = 3600e3

// Per-timestep Sun/Earth state for one site. `eph` from astro.ephem() for each timestep.
export function computeSeries(eph, lat, lon, hz, hzDist, stepMin) {
  const N = eph.length
  const s = {
    hz, hzDist, sunAz: new Float32Array(N), sunEl: new Float32Array(N), sunVis: new Float32Array(N),
    earthAz: new Float32Array(N), earthEl: new Float32Array(N), earthVis: new Uint8Array(N),
  }
  eph.forEach((e, i) => {
    const { sun, earth } = look(e, lat, lon, 2)
    s.sunAz[i] = sun.az; s.sunEl[i] = sun.el
    // Sun disc radius ≈ 0.267°: fraction of disc above the local terrain horizon.
    s.sunVis[i] = Math.min(1, Math.max(0, (sun.el - horizonAt(hz, sun.az) + 0.267) / 0.534))
    s.earthAz[i] = earth.az; s.earthEl[i] = earth.el
    s.earthVis[i] = earth.el > horizonAt(hz, earth.az) ? 1 : 0
  })
  let lit = 0, see = 0, both = 0, run = 0, longest = 0
  for (let i = 0; i < N; i++) {
    const l = s.sunVis[i] >= 0.5
    lit += l; see += s.earthVis[i]; both += l && s.earthVis[i]
    run = l ? 0 : run + 1; longest = Math.max(longest, run)
  }
  return Object.assign(s, { pLit: lit / N, pSee: see / N, pBoth: both / N, longestNightH: (longest * stepMin) / 60 })
}

// Illumination grid around a site, in the site's local east/north frame.
// Cell (i, j): east = (i - c) * spacing, north = (j - c) * spacing, c = (n - 1) / 2.
// Returns fractions of time with Sun lit / Earth visible / both, over `days`.
export function computeOverlay(dem, { lat, lon, start, days = 30, stepH = 2, n = 33, spacing = 2500 }, onRow) {
  const T = Math.round((days * 24) / stepH) + 1
  const eph = Array.from({ length: T }, (_, t) => ephem(new Date(start + t * stepH * H)))
  const step = Math.max(spacing, Math.round(2 * (dem?.res ?? 240)))
  const c = (n - 1) / 2
  const lit = new Float32Array(n * n), see = new Float32Array(n * n), both = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const e = (i - c) * step, no = (j - c) * step
      const [plat, plon] = offsetLL(lat, lon, e, no)
      if (dem?.covers ? !dem.covers(plat, plon) : !inDem(plat)) continue
      // ponytail: 2° azimuth + 60 km rays (vs 0.5° / 150 km for the main site) keeps the
      // grid ~1 ms/cell; upgrade = full horizon in more workers if accuracy matters.
      const hz = horizon(dem, plat, plon, { steps: 180, maxDist: 60000 })
      let l = 0, s = 0, b = 0
      for (const ep of eph) {
        const { sun, earth } = look(ep, plat, plon, 2)
        const sl = sun.el >= horizonAt(hz, sun.az), es = earth.el > horizonAt(hz, earth.az)
        l += sl; s += es; b += sl && es
      }
      const k = j * n + i
      lit[k] = l / T; see[k] = s / T; both[k] = b / T
    }
    onRow?.((j + 1) / n)
  }
  return { n, spacing: step, lit, see, both }
}

// Per-day landing quality for one calendar year (UTC), landing at 00:00 each day.
// 2 = good: lit now, ≥5 days of continuous light, Earth visible ≥50% of the first 5 days.
// 0 = poor: dark now or night falls within 2 days. 1 = everything else.
export function computeCalendar({ lat, lon, hz, year, stepH = 2 }) {
  const t0 = Date.UTC(year, 0, 1)
  const days = Math.round((Date.UTC(year + 1, 0, 1) - t0) / 864e5)
  const per = 24 / stepH, ahead = 20 * per
  const T = days * per + ahead
  const lit = new Uint8Array(T), see = new Uint8Array(T)
  for (let t = 0; t < T; t++) {
    const { sun, earth } = look(ephem(new Date(t0 + t * stepH * H)), lat, lon, 2)
    lit[t] = sun.el >= horizonAt(hz, sun.az)
    see[t] = earth.el > horizonAt(hz, earth.az)
  }
  const out = []
  for (let d = 0; d < days; d++) {
    const k = d * per
    let run = 0
    while (run < ahead && lit[k + run]) run++
    let s5 = 0
    for (let t = k; t < k + 5 * per; t++) s5 += see[t]
    const lightH = run * stepH, earthPct = s5 / (5 * per)
    const q = !lit[k] || lightH < 48 ? 0 : lightH >= 120 && earthPct >= 0.5 ? 2 : 1
    out.push({ q, lightH, earthPct, lightCapped: run >= ahead })
  }
  // longest run of good days
  let best = null
  for (let d = 0; d < days;) {
    if (out[d].q !== 2) { d++; continue }
    let e = d
    while (e + 1 < days && out[e + 1].q === 2) e++
    if (!best || e - d > best.to - best.from) best = { from: d, to: e }
    d = e + 1
  }
  return { year, t0, days: out, best }
}

export const SURFACE_WINDOW_DAYS = 7
export const RANK_WEIGHTS = { litNow: 20, earthNow: 10, pBoth: 35, pLit: 20, lightAhead: 15 }

const DIRS_ID = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']

function sliceSeries(arr, n) {
  return typeof arr?.subarray === 'function' ? arr.subarray(0, n) : arr.slice(0, n)
}

/**
 * Rank candidate lunar landing sites at a planned touchdown epoch `landT`
 * over a deterministic surface window `[landT, landT + surfaceDays]` (0..100 transparent score).
 * Sites with `!hasDem(site)` are excluded so missing elevation data can never silently win.
 */
export function rankLandingSites({
  sites,
  landT,
  stepMin = 30,
  surfaceDays = SURFACE_WINDOW_DAYS,
  seriesAt,
  hasDem = () => true,
}) {
  const stepH = stepMin / 60
  const maxSamples = Math.max(1, Math.floor((surfaceDays * 24 * 60) / stepMin) + 1)
  const winH = Math.max(stepH, surfaceDays * 24)
  const ranked = []

  for (const site of sites) {
    if (!hasDem(site)) continue
    const s = seriesAt(site, landT)
    const winN = Math.max(1, Math.min(s.sunVis.length, maxSamples))
    const litNow = s.sunVis[0] >= 0.5
    const earthNow = Boolean(s.earthVis[0])

    let lit = 0, see = 0, both = 0, run = 0, longest = 0
    for (let k = 0; k < winN; k++) {
      const l = s.sunVis[k] >= 0.5
      const e = Boolean(s.earthVis[k])
      if (l) lit++
      if (e) see++
      if (l && e) both++
      run = l ? 0 : run + 1
      if (run > longest) longest = run
    }

    let litSamples = 0
    while (litSamples < winN && s.sunVis[litSamples] >= 0.5) litSamples++
    const lightAheadH = litSamples * stepH
    const pLit = lit / winN
    const pSee = see / winN
    const pBoth = both / winN
    const longestNightH = (longest * stepMin) / 60

    const score =
      (litNow ? RANK_WEIGHTS.litNow : 0) +
      (earthNow ? RANK_WEIGHTS.earthNow : 0) +
      pBoth * RANK_WEIGHTS.pBoth +
      pLit * RANK_WEIGHTS.pLit +
      Math.min(1, lightAheadH / winH) * RANK_WEIGHTS.lightAhead

    const winS = {
      ...s,
      sunEl: sliceSeries(s.sunEl ?? s.sunVis, winN),
      sunAz: sliceSeries(s.sunAz ?? s.sunVis, winN),
      earthEl: sliceSeries(s.earthEl ?? s.earthVis, winN),
      earthAz: sliceSeries(s.earthAz ?? s.earthVis, winN),
      sunVis: sliceSeries(s.sunVis, winN),
      earthVis: sliceSeries(s.earthVis, winN),
      pLit,
      pSee,
      pBoth,
      longestNightH,
    }
    const ins = makeInsight({ s: winS, stepMin, hasDem: true })
    ranked.push({
      site,
      s,
      ins,
      litNow,
      earthNow,
      lightAheadH,
      pLit,
      pSee,
      pBoth,
      longestNightH,
      surfaceDays,
      score,
    })
  }

  ranked.sort((a, b) => (b.score - a.score) || String(a.site.id).localeCompare(String(b.site.id)))
  return ranked
}

/**
 * Find a better nearby candidate cell from a worker illumination grid (`computeOverlay`).
 * Returns null if the center site is already near-optimal or no valid neighbor beats it.
 */
export function bestNearbyFromOverlay(ov, { lat, lon, minGain = 0.03, maxRadiusM } = {}) {
  if (!ov || !ov.n || !ov.both) return null
  const n = ov.n
  const c = (n - 1) / 2
  const ck = c * n + c
  const lit0 = ov.lit[ck] ?? 0
  const see0 = ov.see[ck] ?? 0
  const both0 = ov.both[ck] ?? 0
  const maxR = maxRadiusM ?? Math.max(6000, ov.spacing * 1.5)

  let best = null
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (i === c && j === c) continue
      const east = (i - c) * ov.spacing
      const north = (j - c) * ov.spacing
      const distM = Math.hypot(east, north)
      if (distM <= 0 || distM > maxR) continue
      const k = j * n + i
      const lit = ov.lit[k] ?? 0
      const see = ov.see[k] ?? 0
      const both = ov.both[k] ?? 0
      if (lit === 0 && see === 0 && both === 0) continue
      if (both < both0 + minGain && lit < lit0 + minGain) continue
      if (lit < lit0 - 0.05 || see < see0 - 0.1) continue
      const gain = (both - both0) + 0.5 * (lit - lit0) + 0.3 * (see - see0) - 0.008 * (distM / 1000)
      if (!best || gain > best.gain) best = { east, north, distM, lit, see, both, gain }
    }
  }
  if (!best) return null

  const az = ((Math.atan2(best.east, best.north) * 180) / Math.PI + 360) % 360
  const dir = DIRS_ID[Math.round(az / 45) % 8]
  const [newLat, newLon] = offsetLL(lat, lon, best.east, best.north)
  return {
    lat: newLat,
    lon: newLon,
    distKm: best.distM / 1000,
    dir,
    lit: best.lit,
    see: best.see,
    both: best.both,
  }
}
