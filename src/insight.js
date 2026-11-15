// Turns the computed numbers into a verdict + plain-language reasons + advice.
// Rule-based on purpose: every sentence traces back to a number we computed.
// Each item = { k: kind (picks the icon), h: short headline, t: one supporting sentence }.
import { R } from './dem.js'

const WIND = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
export const windOf = (az) => WIND[Math.round(((az % 360) + 360) % 360 / 45) % 8]
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pct = (x) => `${Math.round(x * 100)}%`
const deg = (x) => `${x.toFixed(1)}°`
const km = (m) => `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`
export const dur = (h) => h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} h`

const circMean = (azs) => {
  let x = 0, y = 0
  for (const a of azs) { x += Math.cos(a * Math.PI / 180); y += Math.sin(a * Math.PI / 180) }
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
const hzIdx = (hz, az) => Math.round(az / 360 * hz.length) % hz.length

function longestRun(n, test) {
  let run = 0, best = 0
  for (let i = 0; i < n; i++) { run = test(i) ? run + 1 : 0; if (run > best) best = run }
  return best
}

// Where does the terrain block a body most often? Returns the strongest obstacle.
function mainBlocker(s, azArr, elArr, blocked) {
  const bins = new Array(36).fill(0)
  for (let i = 0; i < azArr.length; i++) if (blocked(i)) bins[Math.floor(azArr[i] / 10) % 36]++
  const bin = bins.indexOf(Math.max(...bins))
  if (!bins[bin]) return null
  let k = hzIdx(s.hz, bin * 10)
  for (let a = bin * 10; a < bin * 10 + 10; a += 0.5) if (s.hz[hzIdx(s.hz, a)] > s.hz[k]) k = hzIdx(s.hz, a)
  const ang = s.hz[k], d = s.hzDist[k]
  return { az: k * 360 / s.hz.length, ang, d, rise: d * Math.tan(ang * Math.PI / 180) + d * d / (2 * R) }
}

// Nearby obstacle (<1 km) means the site sits on a slope; far one is a ridge/crater rim.
const blockerText = (b) => b.d < 1000
  ? `a slope right next to the site (${km(b.d)}) rising ${deg(b.ang)} to the ${windOf(b.az)}`
  : `terrain ${deg(b.ang)} high to the ${windOf(b.az)}, ~${km(b.d)} away (${Math.round(b.rise)} m higher)`

function monthRanges(months) {
  const out = []
  for (const m of months) {
    const last = out[out.length - 1]
    if (last && last[1] === m - 1) last[1] = m; else out.push([m, m])
  }
  return out.map(([a, b]) => a === b ? MONTHS[a] : `${MONTHS[a]}–${MONTHS[b]}`).join(', ')
}

/**
 * s: series from main.seriesFor (hz, hzDist, sun/earth arrays, pLit, pSee, longestNightH)
 * stepMin: minutes per sample · hasDem: terrain known · cal: computeCalendar result (optional)
 * area: { pct, best } from the illumination grid (optional; arrives later)
 */
export function makeInsight({ s, stepMin, hasDem, cal, area }) {
  const n = s.sunEl.length, h = stepMin / 60
  const power = s.pLit >= 0.7 ? 'good' : s.pLit >= 0.3 ? 'mid' : 'bad'
  const comm = s.pSee >= 0.7 ? 'good' : s.pSee >= 0.3 ? 'mid' : 'bad'
  const gapH = longestRun(n, (i) => !s.earthVis[i]) * h

  let level, title
  if (power === 'bad') { level = 'bad'; title = 'Not suitable for a solar-powered mission' }
  else if (power === 'good' && comm === 'good') { level = 'good'; title = 'Power and communication secure' }
  else {
    level = 'risk'
    title = `${power === 'good' ? 'Power secure' : 'Power limited'}, ${comm === 'good' ? 'comms secure' : comm === 'mid' ? 'comms intermittent' : 'almost no comms'}`
  }

  const why = []

  // ---- power ----
  const maxSun = Math.max(...s.sunEl)
  if (maxSun > 20) {
    why.push({ k: 'sun', h: 'Day and night alternate', t: `The Sun rises to ${deg(maxSun)} and then sets. Lunar day and night each last ~14.7 days.` })
  } else {
    const terrainBlocked = (i) => s.sunVis[i] < 0.5 && s.sunEl[i] > 0.27
    const below = (i) => s.sunVis[i] < 0.5 && s.sunEl[i] <= 0.27
    let nT = 0, nB = 0
    for (let i = 0; i < n; i++) { nT += terrainBlocked(i); nB += below(i) }
    if (s.pLit >= 0.97) {
      let hzMax = -90
      for (let i = 0; i < n; i += 4) hzMax = Math.max(hzMax, s.hz[hzIdx(s.hz, s.sunAz[i])])
      why.push({ k: 'sun', h: 'The Sun is almost never blocked', t: hzMax <= 0
        ? `The Sun is low (${deg(Math.max(0, Math.min(...s.sunEl)))}–${deg(maxSun)}), but the surrounding terrain is lower than this site.`
        : `The Sun is low (${deg(Math.max(0, Math.min(...s.sunEl)))}–${deg(maxSun)}), and the terrain along its path rises at most ${deg(hzMax)}.` })
    } else if (Math.min(...s.hz) > 8) {
      why.push({ k: 'sun', h: 'Blocked by crater walls', t: `Walls ${deg(Math.min(...s.hz))}–${deg(Math.max(...s.hz))} high surround the site, while the Sun only reaches ${deg(maxSun)}.` })
    } else if (nT >= nB && nT > 0) {
      const b = mainBlocker(s, s.sunAz, s.sunEl, terrainBlocked)
      why.push({ k: 'sun', h: `Sun blocked by terrain to the ${windOf(b.az)}`, t: `The obstruction is ${blockerText(b)}.` })
    } else if (nB > 0) {
      why.push({ k: 'sun', h: 'Sun below the horizon', t: `At most ${deg(maxSun)} in 30 days: lunar night or polar winter, not hills.` })
    }
  }
  if (s.pLit === 0 && hasDem) {
    why.push({ k: 'sci', h: 'Water-ice candidate', t: 'Permanent darkness means extreme cold where ice can survive. A science target, not a landing site.' })
  }

  // ---- communication ----
  const eAz = windOf(circMean(s.earthAz))
  const eMin = Math.min(...s.earthEl), eMax = Math.max(...s.earthEl)
  if (eMax < 0) {
    why.push({ k: 'earth', h: 'Far side: Earth never visible', t: `Earth is always below the horizon (at most ${deg(eMax)}). Communication only via a relay satellite.` })
  } else if (s.pSee >= 0.99) {
    why.push({ k: 'earth', h: 'Earth always visible', t: `To the ${eAz}, ${deg(eMin)}–${deg(eMax)} high. Direct communication is possible at any time.` })
  } else if (s.pSee === 0) {
    const b = mainBlocker(s, s.earthAz, s.earthEl, () => true)
    why.push({ k: 'earth', h: 'Earth always blocked by terrain', t: `Earth rises to ${deg(eMax)}, but is blocked by ${blockerText(b)}.` })
  } else {
    const blocked = (i) => !s.earthVis[i] && s.earthEl[i] > 0
    const b = mainBlocker(s, s.earthAz, s.earthEl, blocked)
    why.push({ k: 'earth', h: `Earth lost for up to ${dur(gapH)}`, t: `Earth sits to the ${eAz}, moving between ${deg(eMin)} and ${deg(eMax)} because of lunar libration. ${b ? `When low, it is blocked by ${blockerText(b)}.` : 'Below the horizon, Earth is not visible.'}` })
  }

  // ---- area ----
  if (area) {
    const item = area.pct >= 0.97
      ? { k: 'area', h: 'Brightest spot in the area', t: 'Compared with every point within ±40 km.' }
      : { k: 'area', h: `Brighter than ${pct(area.pct)} of the area`, t: 'Compared with every point within ±40 km.' }
    if (area.best) item.t += ` A point ${km(area.best.d)} to the ${windOf(area.best.az)} is better: sunlit ${pct(area.best.lit)}, Earth ${pct(area.best.see)}.`
    item.best = area.best
    why.push(item)
  }

  // ---- advice ----
  const advice = []
  if (comm !== 'good' && eMax >= 0) advice.push({ k: 'relay', h: 'Plan a communication relay', t: `Or plan autonomous operations for gaps of up to ${dur(gapH)}.` })
  if (s.longestNightH >= n * h * 0.99) advice.push({ k: 'power', h: 'Needs non-solar power', t: 'No sunlight in 30 days (e.g. an RTG).' })
  else if (s.longestNightH > 0) advice.push({ k: 'battery', h: `Batteries must last ${dur(s.longestNightH)}`, t: 'Batteries and heaters must cover the longest night.' })
  if (cal) {
    if (cal.best) {
      const f = new Date(cal.t0 + cal.best.from * 864e5), t = new Date(cal.t0 + cal.best.to * 864e5)
      advice.push({ k: 'cal', h: `Land ${f.getUTCDate()} ${MON[f.getUTCMonth()]} – ${t.getUTCDate()} ${MON[t.getUTCMonth()]}`, t: `Best window in ${cal.year} (${cal.best.to - cal.best.from + 1} days).` })
    }
    const poor = []
    for (let m = 0; m < 12; m++) {
      const days = cal.days.filter((_, d) => new Date(cal.t0 + d * 864e5).getUTCMonth() === m)
      if (days.filter((d) => d.q === 0).length / days.length >= 0.7) poor.push(m)
    }
    if (poor.length && poor.length < 12) advice.push({ k: 'avoid', h: `Avoid ${monthRanges(poor)}`, t: 'Almost always dark, or night arrives soon.' })
  }
  if (!hasDem) advice.push({ k: 'info', h: 'Terrain data unavailable', t: 'LOLA terrain data not loaded; nearby hills are ignored.' })

  return { level, title, why, advice }
}
