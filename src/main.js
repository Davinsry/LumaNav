import { ephem, skyPose } from './astro.js'
import { makeDem, terrainFor, demKeyFor, horizon } from './dem.js'
import { createScene } from './scene.js'
import { computeCalendar, computeSeries, rankLandingSites, SURFACE_WINDOW_DAYS, bestNearbyFromOverlay } from './analysis.js'
import { makeInsight, dur } from './insight.js'
import { validate } from './validation.js'
import { icon } from './icons.js'
import { planMission, solveLaunchForLanding, missionState, moonAngle, PADS } from './mission.js'
import { createSpace } from './space.js'

// Coordinates: rim/summit points located in LOLA DEMs; mission coordinates from LROC/reports.
const SITES = [
  { id: 'ridge', group: 'South Pole', name: 'Shackleton Connecting Ridge', lat: -89.444, lon: -137.56, note: 'Ridge between Shackleton & de Gerlache. Artemis candidate' },
  { id: 'floor', group: 'South Pole', name: 'Shackleton Crater Floor', lat: -89.67, lon: 129.78, note: 'Permanently shadowed (PSR), water-ice site' },
  { id: 'malapert', group: 'South Pole', name: 'Malapert Massif', lat: -85.989, lon: 2.1, note: '5 km high massif. Artemis III candidate' },
  { id: 'athena', group: 'South Pole', name: 'Mons Mouton (IM-2 Athena)', lat: -84.79, lon: 29.2, note: 'Landed March 2025, approximate coordinates' },
  { id: 'odysseus', group: 'South Pole', name: 'Malapert A (IM-1 Odysseus)', lat: -80.13, lon: 1.44, note: 'Landed February 2024' },
  { id: 'shivshakti', group: 'South Pole', name: 'Shiv Shakti (Chandrayaan-3)', lat: -69.373, lon: 32.319, note: 'Landed August 2023 in the southern highlands' },
  { id: 'apollo11', group: 'Near Side', name: 'Apollo 11 (Mare Tranquillitatis)', lat: 0.674, lon: 23.473, note: 'First crewed landing (1969), near-side equator' },
  { id: 'apollo15', group: 'Near Side', name: 'Apollo 15 (Hadley–Apennine)', lat: 26.132, lon: 3.633, note: 'Hadley Rille & the Montes Apenninus (1971)' },
  { id: 'apollo17', group: 'Near Side', name: 'Apollo 17 (Taurus–Littrow)', lat: 20.191, lon: 30.772, note: 'Taurus–Littrow mountain valley (1972)' },
  { id: 'change5', group: 'Near Side', name: "Chang'e-5 (Mons Rümker)", lat: 43.1, lon: -51.8, note: 'Oceanus Procellarum, youngest sample return (2020)' },
  { id: 'blueghost1', group: 'Near Side', name: 'Blue Ghost 1 (Mare Crisium)', lat: 18.56, lon: 61.81, note: 'Near Mons Latreille, landed March 2025' },
  { id: 'slim', group: 'Near Side', name: 'SLIM (Shioli Crater)', lat: -13.316, lon: 25.251, note: 'JAXA precision landing near Mare Nectaris (2024)' },
  { id: 'change4', group: 'Far Side', name: "Chang'e-4 (Von Kármán)", lat: -45.445, lon: 177.599, note: 'First soft landing on the far side (2019)' },
  { id: 'change6', group: 'Far Side', name: "Chang'e-6 (Apollo Crater)", lat: -41.638, lon: -153.985, note: 'First far-side sample return (2024)' },
  { id: 'peary', group: 'North Pole', name: 'Peary Crater Rim', lat: 89.38, lon: 126.0, note: 'High ridge on the north rim of Peary (LOLA 240 m)' },
]

const STEP_MIN = 30
const DAYS = 30
const N = (DAYS * 24 * 60) / STEP_MIN + 1
const $ = (s) => document.querySelector(s)

const DEM_SPECS = {
  '75S': { url: './LDEM_75S_240M.IMG', kind: 'polar', hemi: 'S' },
  '75N': { url: './LDEM_75N_240M.IMG', kind: 'polar', hemi: 'N' },
  '16': { url: './LDEM_16.IMG', kind: 'cyl', ppd: 16 },
}

const st = {
  site: SITES[0], pinned: [SITES[2]], customs: [], slips: [], start: null, idx: 0, playing: false, tab: 'timeline',
  eph: [], dems: new Map(), demPending: new Map(), cache: new Map(), hzCache: new Map(), calCache: new Map(), ovCache: new Map(), ovId: 0, layer: 'normal', surface: false,
}
const siteKey = (s) => `${s.lat},${s.lon}`
const demFor = (lat) => terrainFor(st.dems, lat)
const loadedDemsKey = () => [...st.dems.keys()].sort().join(',')

// ---------- data ----------
function ensureDem(lat) {
  const key = demKeyFor(lat)
  if (st.dems.has(key)) return Promise.resolve(st.dems.get(key))
  if (st.demPending.has(key)) return st.demPending.get(key)
  const spec = DEM_SPECS[key]
  $('#loading').textContent = 'Loading terrain data…'
  $('#loading').hidden = false
  let ok = false
  const p = fetch(spec.url)
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer() })
    .then((b) => {
      const dem = makeDem({ kind: spec.kind, hemi: spec.hemi, ppd: spec.ppd, buf: b })
      st.dems.set(key, dem)
      // Invalidate cached horizons/overlays that fell back to flat or coarser DEM while loading.
      for (const c of [st.cache, st.hzCache, st.calCache, st.ovCache, scCache]) c.clear()
      cmpKey = ''; msKey = ''
      const copy = b.slice(0)
      worker.postMessage({ dem: { kind: spec.kind, hemi: spec.hemi, ppd: spec.ppd, buf: copy } }, [copy])
      ok = true
      return dem
    })
    .catch((e) => {
      $('#loading').textContent = `Could not load LOLA data (${e.message}). Assuming a flat horizon.`
      return null
    })
    .finally(() => {
      st.demPending.delete(key)
      if (ok && st.demPending.size === 0) $('#loading').hidden = true
    })
  st.demPending.set(key, p)
  return p
}

function computeEphem() {
  st.eph = ephCache.get(st.start) ?? Array.from({ length: N }, (_, i) => ephem(new Date(st.start + i * STEP_MIN * 60e3)))
  st.cache.clear()
}

function horizonFor(site) {
  const d = demFor(site.lat)
  const key = `${siteKey(site)}|${d?.id ?? 'flat'}`
  // Horizon depends only on the site and loaded DEM, so keep it across date changes.
  if (!st.hzCache.has(key)) {
    const dist = new Float32Array(720)
    const hz = d ? horizon(d, site.lat, site.lon, { dist }) : new Float32Array(720)
    st.hzCache.set(key, { hz, dist })
  }
  return st.hzCache.get(key)
}

function seriesFor(site) {
  const d = demFor(site.lat)
  const key = `${site.lat},${site.lon}|${d?.id ?? 'flat'}`
  if (st.cache.has(key)) return st.cache.get(key)
  const { hz, dist } = horizonFor(site)
  const s = computeSeries(st.eph, site.lat, site.lon, hz, dist, STEP_MIN)
  st.cache.set(key, s)
  return s
}

// steps until a boolean series flips, or -1 if it never does in the window
function untilFlip(test, i0) {
  const v0 = test(i0)
  for (let i = i0 + 1; i < N; i++) if (test(i) !== v0) return i - i0
  return -1
}

// ---------- formatting ----------
const fmtDur = (steps) => {
  if (steps < 0) return `> ${DAYS - Math.floor(st.idx * STEP_MIN / 1440)} days`
  const m = steps * STEP_MIN, d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60)
  return d ? `${d} d ${h} h` : `${h} h ${m % 60} min`
}
const pct = (x) => `${Math.round(x * 100)}%`
const fmtDate = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
const hzIdx = (s, az) => ((Math.round((az / 360) * s.hz.length) % s.hz.length) + s.hz.length) % s.hz.length
function nextStateTime(arr, pred, i0, start, targetState) {
  let prev = !!pred(arr[i0])
  for (let k = i0 + 1; k < N; k++) {
    const cur = !!pred(arr[k])
    if (cur !== prev && cur === targetState) return start + k * STEP_MIN * 60e3
    prev = cur
  }
  return null
}

// ---------- site picker ----------
// Popovers sit just under the toolbar's first row, whose height depends on screen width.
// Popovers live at #app level and open just under the button that triggered them.
function placeUnder(el, anchor) {
  const a = anchor.getBoundingClientRect(), app = $('#app').getBoundingClientRect()
  el.style.top = `${a.bottom - app.top + 6}px`
  el.style.left = `${Math.max(12, a.left - app.left)}px`
}
function setPicker(open) {
  if (open) placeUnder($('#picker'), $('#site-btn'))
  $('#picker').hidden = !open
  $('#site-btn').setAttribute('aria-expanded', open)
  if (open) drawMoonMap()
}
$('#site-btn').onclick = (e) => { e.stopPropagation(); setAbout(false); setPicker($('#picker').hidden) }
document.addEventListener('pointerdown', (e) => {
  if (!$('#picker').hidden && !e.target.closest('#picker, #site-btn')) setPicker(false)
  if (!$('#about').hidden && !e.target.closest('#about, #about-btn')) setAbout(false)
  if (!$('#datepick').hidden && !e.target.closest('#datepick, #date-btn')) setDatePicker(false)
})
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!$('#datepick').hidden) dp.target.anchor().focus()
  setPicker(false); setAbout(false); setDatePicker(false)
})

// ---------- "Metode & Data" panel ----------
const num = (x, d = 2) => x.toFixed(d)
function setAbout(open) {
  if (open) placeUnder($('#about'), $('#about-btn'))
  $('#about').hidden = !open
  $('#about-btn').setAttribute('aria-expanded', open)
  if (!open || $('#val-rows').childElementCount) return
  // Recompute against the JPL reference right here in the browser.
  const v = validate()
  $('#val-sum').innerHTML = `8 epochs (1–15 Jan 2027) at Shackleton Connecting Ridge. Maximum difference between our calculation and JPL Horizons: <b class="ok">${num(v.max, 4)}°</b>.`
  $('#val-rows').replaceChildren(...v.rows.map((r) => {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${new Date(r.t).toISOString().slice(0, 10)}</td>
      <td>${num(r.jpl.sun.az)}° / ${num(r.jpl.sun.el)}°</td>
      <td>${num(r.jpl.earth.az)}° / ${num(r.jpl.earth.el)}°</td>
      <td class="ok">${num(r.max, 4)}°</td>`
    return tr
  }))
}
$('#about-btn').onclick = (e) => { e.stopPropagation(); setPicker(false); setAbout($('#about').hidden) }

const normLon = (lon) => {
  const w = ((lon + 180) % 360 + 360) % 360 - 180
  return w === -180 && lon > 0 ? 180 : w
}

// Interactive equirectangular Moon map inside #picker (lon -180..+180 left→right, lat +90..-90 top→bottom).
const moonMapImg = new Image()
moonMapImg.src = './textures/moon.jpg'
moonMapImg.onload = () => { if (!$('#picker').hidden) drawMoonMap() }

function drawMoonMap() {
  const c = $('#moon-map')
  if (!c || !c.clientWidth) return
  const [g, w, h] = fit(c)
  g.clearRect(0, 0, w, h)
  if (moonMapImg.complete && moonMapImg.naturalWidth) g.drawImage(moonMapImg, 0, 0, w, h)
  const xy = (lat, lon) => [(normLon(lon) / 360 + 0.5) * w, (0.5 - lat / 180) * h]

  // Equator, prime meridian, and ±75° polar 240 m boundaries.
  g.strokeStyle = 'rgba(255,255,255,0.16)'; g.lineWidth = 1
  for (const la of [75.2, 0, -75.2]) {
    const [, y] = xy(la, 0); g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke()
  }
  g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke()

  for (const s of [...SITES, ...st.customs]) {
    const [x, y] = xy(s.lat, s.lon)
    g.fillStyle = s === st.site ? css('--accent') : 'rgba(255,207,74,0.8)'
    g.beginPath(); g.arc(x, y, s === st.site ? 4.5 : 2.5, 0, Math.PI * 2); g.fill()
  }
  const [sx, sy] = xy(st.site.lat, st.site.lon)
  g.strokeStyle = '#fff'; g.lineWidth = 1.5
  g.beginPath(); g.arc(sx, sy, 6, 0, Math.PI * 2); g.stroke()
  $('#moon-map-coord').textContent = `${st.site.lat.toFixed(1)}°, ${normLon(st.site.lon).toFixed(1)}°`
}

function mapCoord(ev) {
  const r = $('#moon-map').getBoundingClientRect()
  const ux = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width))
  const uy = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))
  return [+((0.5 - uy) * 180).toFixed(2), +((ux - 0.5) * 360).toFixed(2)]
}
$('#moon-map').addEventListener('pointermove', (ev) => {
  const [la, lo] = mapCoord(ev)
  $('#moon-map-coord').textContent = `${la.toFixed(1)}°, ${lo.toFixed(1)}°`
})
$('#moon-map').addEventListener('pointerleave', () => {
  $('#moon-map-coord').textContent = `${st.site.lat.toFixed(1)}°, ${normLon(st.site.lon).toFixed(1)}°`
})
$('#moon-map').addEventListener('click', (ev) => {
  const [la, lo] = mapCoord(ev)
  $('#lat').value = la; $('#lon').value = lo
  addCustom(la, lo)
  setPicker(false)
})

function renderSites() {
  $('#sites').innerHTML = ''
  const custom = st.customs.map((s) => ({ ...s, group: 'Custom coordinates' }))
  let lastGroup = ''
  for (const s of [...custom, ...SITES]) {
    const orig = st.customs.find((c) => c.id === s.id) || s
    if (s.group !== lastGroup) {
      lastGroup = s.group
      const hdr = document.createElement('li')
      hdr.className = 'site-grp'
      hdr.textContent = lastGroup
      $('#sites').appendChild(hdr)
    }
    const li = document.createElement('li')
    li.className = orig === st.site ? 'on' : ''
    const pinned = st.pinned.includes(orig)
    li.innerHTML = `<button class="pick"><b></b><small></small></button>
      <button class="pin ${pinned ? 'on' : ''}" title="Show on the timeline for comparison">${pinned ? '✓ Comparing' : '+ Compare'}</button>`
    li.querySelector('b').textContent = orig.name
    li.querySelector('small').textContent = orig.note
    li.querySelector('.pick').onclick = () => { selectSite(orig); setPicker(false) }
    li.querySelector('.pin').onclick = () => {
      st.pinned = pinned ? st.pinned.filter((p) => p !== orig) : [...st.pinned, orig].slice(-3)
      renderSites(); drawDock()
      if (!pinned && !st.dems.has(demKeyFor(orig.lat))) ensureDem(orig.lat).then((loaded) => { if (loaded) update() })
    }
    $('#sites').appendChild(li)
  }
  if (!$('#picker').hidden) drawMoonMap()
}

function addCustom(lat, lon) {
  if (!(lat >= -90 && lat <= 90 && Number.isFinite(lon))) return
  lon = normLon(lon)
  const s = { id: `c${Date.now()}`, name: `Point ${lat.toFixed(3)}°, ${lon.toFixed(2)}°`, lat, lon, note: 'Custom coordinates' }
  st.customs = [s, ...st.customs].slice(0, 5)
  selectSite(s)
}

function selectSite(s) {
  st.site = s
  const d = demFor(s.lat)
  view.setSite(s, d, seriesFor(s).hz)
  if (sim.p) space?.setPlan(sim.p, s, d)
  requestOverlay()
  $('#site-name').textContent = s.name
  const resLabel = d ? (d.kind === 'polar' ? 'LOLA 240 m' : 'LOLA 1.9 km') : 'loading terrain…'
  $('#site-coord').textContent = `${s.lat.toFixed(3)}°, ${s.lon.toFixed(2)}° · ${resLabel}`
  renderSites(); update()
  if (!st.dems.has(demKeyFor(s.lat))) {
    ensureDem(s.lat).then((loaded) => {
      if (!loaded) return
      if (st.site === s) selectSite(s)
      else update()
      renderMission(true)
    })
  }
}

// ---------- insight ----------
const VERDICT_LABEL = { good: 'Suitable', risk: 'Risky', bad: 'Not suitable' }

function renderInsight() {
  const site = st.site, s = seriesFor(site), d = demFor(site.lat)
  const r = makeInsight({ s, stepMin: STEP_MIN, hasDem: !!d, cal: calendarFor(site) })
  $('#v-badge').className = `badge ${r.level}`
  $('#v-badge').textContent = VERDICT_LABEL[r.level]
  $('#v-title').textContent = r.title
}

// ---------- status card ----------
function timelineEpochMs() { return st.start + st.idx * STEP_MIN * 60e3 }

function applyStatusReadout(sky, t, s, i = null) {
  const sv = sky.sunVis, lit = sv >= 0.5, ev = sky.earthVis
  const chip = (el, text, cls) => { el.textContent = text; el.className = `chip ${cls}` }
  const inWin = i != null && i >= 0 && i < N
  chip($('#sun-chip'), sv >= 1 ? 'Sunlit' : sv > 0 ? `Partial ${pct(sv)}` : 'Dark', sv >= 1 ? 'sun' : sv > 0 ? 'part' : 'off')
  $('#sun-next-label').textContent = lit ? 'sets in' : 'rises in'
  $('#sun-next').textContent = inWin ? fmtDur(untilFlip((k) => s.sunVis[k] >= 0.5, i)) : '—'

  chip($('#earth-chip'), ev ? 'Visible' : 'Blocked', ev ? 'earth' : 'off')
  $('#earth-next-label').textContent = ev ? 'sets in' : 'rises in'
  $('#earth-next').textContent = inWin ? fmtDur(untilFlip((k) => s.earthVis[k] === 1, i)) : '—'

  if (inWin) {
    const dayEl = $('#utc-day-off'), timeEl = $('#utc-time')
    if (dayEl && timeEl && dayEl.options.length) {
      dayEl.value = String(Math.floor(i / 48))
      timeEl.value = String(i % 48)
    }
  }
  $('#now').textContent = fmtDate(t)
  st.pose = sky.pose || skyPose(new Date(t), st.site.lat, st.site.lon)
  view.setSky({ sunAz: sky.sunAz, sunEl: sky.sunEl, sunVis: sv, earthAz: sky.earthAz, earthEl: sky.earthEl, earthVis: ev, pose: st.pose, t })
}

function renderStatus() {
  const s = seriesFor(st.site), i = st.idx
  $('#m-lit').textContent = pct(s.pLit)
  $('#m-see').textContent = pct(s.pSee)
  const bothEl = $('#m-both'); if (bothEl) bothEl.textContent = pct(s.pBoth)
  $('#m-night').textContent = s.longestNightH >= DAYS * 24 ? `${DAYS}+ days` : dur(s.longestNightH)
  const t = timelineEpochMs()
  applyStatusReadout({
    sunAz: s.sunAz[i], sunEl: s.sunEl[i], sunVis: s.sunVis[i],
    earthAz: s.earthAz[i], earthEl: s.earthEl[i], earthVis: s.earthVis[i],
    pose: skyPose(new Date(t), st.site.lat, st.site.lon),
  }, t, s, i)
}

function renderLiveStatus(sky, t) {
  const s = seriesFor(st.site)
  const winEnd = st.start + (N - 1) * STEP_MIN * 60e3
  if (t >= st.start && t <= winEnd) {
    const i = Math.max(0, Math.min(N - 1, Math.round((t - st.start) / (STEP_MIN * 60e3))))
    st.idx = i
    applyStatusReadout(sky, t, s, i)
    renderInsight()
    drawDock()
  } else {
    applyStatusReadout(sky, t, s, null)
  }
}

// ---------- canvases ----------
function fit(c) {
  const r = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight
  if (c.width !== Math.round(w * r) || c.height !== Math.round(h * r)) { c.width = w * r; c.height = h * r }
  const g = c.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0)
  return [g, w, h]
}
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

function drawPano() {
  const [g, w, h] = fit($('#pano'))
  const s = seriesFor(st.site)
  let peak = 0
  for (let k = 0; k < N; k += 4) peak = Math.max(peak, s.earthEl[k], s.sunEl[k])
  for (const v of s.hz) peak = Math.max(peak, v)
  const top = Math.min(90, Math.max(12, Math.ceil(peak + 3)))
  const bot = -10, gridStep = top > 40 ? 15 : 5
  const X = (az) => (az / 360) * w, Y = (el) => ((top - el) / (top - bot)) * h
  g.clearRect(0, 0, w, h)
  g.strokeStyle = css('--line'); g.fillStyle = css('--muted'); g.font = '11px ui-monospace, monospace'; g.lineWidth = 1
  for (let el = Math.ceil(bot / gridStep) * gridStep; el <= top; el += gridStep) { g.beginPath(); g.moveTo(0, Y(el)); g.lineTo(w, Y(el)); g.stroke(); g.fillText(`${el}°`, w - 34, Y(el) - 2) }
  for (const [t, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) g.fillText(t, X(az) + 4, 12)
  g.fillStyle = css('--earth-dim')
  for (let k = 0; k < N; k += 2) g.fillRect(X(s.earthAz[k]) - 1, Y(s.earthEl[k]) - 1, 2, 2)
  for (let k = 0; k < N; k += 2) {
    g.fillStyle = s.sunVis[k] >= 0.5 ? css('--sun-dim') : 'rgba(255,207,74,0.12)'
    g.fillRect(X(s.sunAz[k]) - 1, Y(s.sunEl[k]) - 1, 2, 2)
  }
  g.beginPath(); g.moveTo(0, h)
  s.hz.forEach((v, k) => g.lineTo((k / s.hz.length) * w, Y(v)))
  g.lineTo(w, h); g.closePath()
  g.fillStyle = css('--ground'); g.fill()
  g.strokeStyle = css('--ground-edge'); g.lineWidth = 1.5; g.stroke()
  const i = st.idx
  const dot = (az, el, col) => { g.beginPath(); g.arc(X(az), Y(el), 6, 0, 7); g.fillStyle = col; g.fill() }
  dot(s.earthAz[i], s.earthEl[i], css('--earth'))
  dot(s.sunAz[i], s.sunEl[i], css('--sun'))
  const pe = $('#pano-explain')
  if (pe) {
    const sk = hzIdx(s, s.sunAz[i]), ek = hzIdx(s, s.earthAz[i])
    const shz = s.hz[sk], ehz = s.hz[ek]
    const sDist = s.hzDist ? s.hzDist[sk] / 1000 : 0, eDist = s.hzDist ? s.hzDist[ek] / 1000 : 0
    const why = (name, vis, el, hz, az, distKm) => {
      const m = el - hz, ridge = distKm > 0 ? `horizon peak ${num(distKm, 1)} km away` : 'flat horizon'
      return `${name}: ${vis ? 'above the horizon' : 'blocked by terrain'} at azimuth ${num(az, 1)}° (elevation ${num(el, 2)}° vs terrain ${num(hz, 2)}°, margin ${m >= 0 ? '+' : ''}${num(m, 2)}°, ${ridge})`
    }
    pe.textContent = `${why('Sun', s.sunVis[i] >= 0.5, s.sunEl[i], shz, s.sunAz[i], sDist)} · ${why('Earth', !!s.earthVis[i], s.earthEl[i], ehz, s.earthAz[i], eDist)}`
  }
}

const ROW = 12, ROW_BOTH = 8, GAP = 12, ROW_H = ROW * 2 + ROW_BOTH + GAP
// Label column shrinks on narrow screens so the bars keep most of the width.
const tlLabel = () => Math.round(Math.min(230, Math.max(130, $('#timeline').clientWidth * 0.26)))
const tlRows = () => [st.site, ...st.pinned.filter((p) => p !== st.site)]

function drawTimeline() {
  const c = $('#timeline'), rows = tlRows()
  c.style.height = `${rows.length * ROW_H + 26}px`
  const [g, w] = fit(c), TL_LABEL = tlLabel()
  const maxChars = Math.floor(TL_LABEL / 7)
  const bw = w - TL_LABEL - 8, X = (k) => TL_LABEL + (k / (N - 1)) * bw
  g.clearRect(0, 0, w, c.clientHeight)
  g.font = '11px ui-monospace, monospace'
  g.fillStyle = css('--muted'); g.strokeStyle = css('--line')
  // Tick every 5 days, or every 10 when the bars are too narrow for the "MM-DD" labels.
  const tick = bw / (DAYS / 5) < 44 ? 10 : 5
  for (let d = 0; d <= DAYS; d += tick) {
    const x = X((d * 1440) / STEP_MIN)
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.clientHeight - 16); g.stroke()
    if (d < DAYS) g.fillText(new Date(st.start + d * 864e5).toISOString().slice(5, 10), x + 3, c.clientHeight - 4)
  }
  rows.forEach((site, r) => {
    const s = seriesFor(site), y = r * ROW_H + 4
    g.fillStyle = site === st.site ? css('--text') : css('--muted')
    g.font = `${site === st.site ? 600 : 400} 12px system-ui`
    g.fillText(site.name.length > maxChars ? site.name.slice(0, maxChars - 1) + '…' : site.name, 6, y + 10)
    g.font = '11px ui-monospace, monospace'
    // Short percentages in bar colours (sun, Earth, simultaneous both).
    g.fillStyle = css('--sun'); g.fillText(pct(s.pLit), 6, y + ROW + 12)
    g.fillStyle = css('--earth'); g.fillText(pct(s.pSee), 44, y + ROW + 12)
    g.fillStyle = css('--good'); g.fillText(pct(s.pBoth), 82, y + ROW + 12)
    for (let k = 0; k < N - 1; k++) {
      const x0 = X(k), x1 = X(k + 1) + 0.5
      g.fillStyle = s.sunVis[k] >= 1 ? css('--sun') : s.sunVis[k] > 0 ? css('--sun-dim') : css('--bar-off')
      g.fillRect(x0, y, x1 - x0, ROW - 2)
      g.fillStyle = s.earthVis[k] ? css('--earth') : css('--bar-off')
      g.fillRect(x0, y + ROW, x1 - x0, ROW - 2)
      g.fillStyle = (s.sunVis[k] >= 0.5 && s.earthVis[k]) ? css('--good') : css('--bar-off')
      g.fillRect(x0, y + ROW * 2, x1 - x0, ROW_BOTH - 2)
    }
  })
  g.fillStyle = css('--accent'); g.fillRect(X(st.idx) - 1, 0, 2, c.clientHeight - 16)
  const ti = $('#tl-inspect')
  if (ti) {
    const s = seriesFor(st.site), i = st.idx, both = s.sunVis[i] >= 0.5 && s.earthVis[i]
    ti.textContent = `Sample #${i + 1}/${N} (30 min step) · ${fmtDate(st.start + i * STEP_MIN * 60e3)} · Sun ${s.sunVis[i] >= 1 ? 'sunlit' : s.sunVis[i] > 0 ? `partial ${pct(s.sunVis[i])}` : 'dark'} (${num(s.sunEl[i], 1)}°) · Earth ${s.earthVis[i] ? 'visible' : 'blocked'} (${num(s.earthEl[i], 1)}°) · Both: ${both ? 'Yes' : 'No'} · Click/drag the chart to inspect`
  }
}

// ---------- calendar ----------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CAL = { label: 36, row: 16 }
const fmtDay = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` }

function calendarFor(site, year = new Date(st.start).getUTCFullYear()) {
  const key = `${siteKey(site)}|${year}`
  if (!st.calCache.has(key)) st.calCache.set(key, computeCalendar({ lat: site.lat, lon: site.lon, hz: seriesFor(site).hz, year }))
  return st.calCache.get(key)
}

// day index in the year → [x, y, w, h] of its cell
function calCell(cal, d, w) {
  const dt = new Date(cal.t0 + d * 864e5), cw = (w - CAL.label) / 31
  return [CAL.label + (dt.getUTCDate() - 1) * cw, dt.getUTCMonth() * CAL.row, cw - 2, CAL.row - 3]
}

function drawCalendar() {
  const c = $('#cal')
  c.style.height = `${12 * CAL.row}px`
  const [g, w] = fit(c), cal = calendarFor(st.site)
  g.clearRect(0, 0, w, c.clientHeight)
  g.font = '11px system-ui'; g.fillStyle = css('--muted')
  MONTHS.forEach((m, i) => g.fillText(m, 2, i * CAL.row + 10))
  const col = [css('--bar-off'), css('--mid'), css('--good')]
  const sel = Math.floor((st.start - cal.t0) / 864e5)
  cal.days.forEach((d, i) => {
    const [x, y, cw, ch] = calCell(cal, i, w)
    g.fillStyle = col[d.q]; g.fillRect(x, y, cw, ch)
    if (i === sel) { g.strokeStyle = css('--accent'); g.lineWidth = 2; g.strokeRect(x - 1, y - 1, cw + 2, ch + 2) }
  })
  const b = cal.best
  $('#cal-best').innerHTML = b
    ? `Best window ${cal.year}: <b>${fmtDay(cal.t0 + b.from * 864e5)} – ${fmtDay(cal.t0 + b.to * 864e5)}</b> (${b.to - b.from + 1} days) · click to select`
    : `No "good" days in ${cal.year} for this site.`
}

function calDayAt(ev) {
  const c = $('#cal'), r = c.getBoundingClientRect(), cal = calendarFor(st.site)
  const month = Math.floor((ev.clientY - r.top) / CAL.row), day = Math.floor((ev.clientX - r.left - CAL.label) / ((c.clientWidth - CAL.label) / 31)) + 1
  if (month < 0 || month > 11 || day < 1) return null
  const t = Date.UTC(cal.year, month, day)
  return new Date(t).getUTCMonth() === month ? { t, d: cal.days[Math.round((t - cal.t0) / 864e5)] } : null
}

function syncUtcDayOptions() {
  const dayEl = $('#utc-day-off')
  if (!dayEl) return
  dayEl.replaceChildren(...Array.from({ length: DAYS + 1 }, (_, d) => {
    const opt = document.createElement('option')
    opt.value = String(d)
    opt.textContent = `D+${d} (${fmtDay(st.start + d * 864e5)})`
    return opt
  }))
}

function setStart(t, { syncMission = true, preserveIdx = false } = {}) {
  st.start = t
  if (syncMission) {
    if (!preserveIdx) st.idx = st.idx % 48
    landingTargetMs = st.start + st.idx * STEP_MIN * 60e3
    recCache.key = ''
  }
  $('#date-label').textContent = fmtLong(t)
  syncUtcDayOptions()
  computeEphem(); requestOverlay(); update()
}

// ---------- date picker (month grid with a landing-quality dot per day) ----------
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const fmtLong = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}` }
const QUALITY = ['poor', 'fair', 'good']
const todayUTC = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) }

const DP_TARGETS = {
  landing: { anchor: () => $('#date-btn'), value: () => st.start, pick: (t) => setStart(t), dots: true },
}
const dp = { y: 0, m: 0, view: 'month', target: DP_TARGETS.landing }

function setDatePicker(open, target = dp.target) {
  dp.target.anchor().setAttribute('aria-expanded', false)
  dp.target = target
  $('#datepick').hidden = !open // show first: hidden elements can't take focus
  target.anchor().setAttribute('aria-expanded', open)
  $('#datepick').setAttribute('aria-label', 'Choose landing date')
  $('.dp-key').hidden = !target.dots
  if (open) {
    const d = new Date(target.value()); dp.y = d.getUTCFullYear(); dp.m = d.getUTCMonth()
    dp.view = 'month' // month first, then day
    placeUnder($('#datepick'), target.anchor())
    renderDatePicker(target.value())
  }
}

// focusT: the day that should receive keyboard focus after rendering
// Month view: 12 months of the year, each with how many "bagus" landing days it has at this site.
function renderMonthPicker() {
  $('#dp-title').textContent = String(dp.y)
  $('#dp-title').setAttribute('aria-label', `Year ${dp.y}`)
  $('.dp-week').hidden = true
  $('#dp-grid').classList.add('months')
  const cal = dp.target.dots ? calendarFor(st.site, dp.y) : null, sel = new Date(dp.target.value()), now = new Date()
  const cells = MONTHS_LONG.map((name, m) => {
    const b = document.createElement('button')
    const isSel = sel.getUTCFullYear() === dp.y && sel.getUTCMonth() === m
    b.className = `dp-month${isSel ? ' sel' : ''}${now.getUTCFullYear() === dp.y && now.getUTCMonth() === m ? ' today' : ''}`
    b.dataset.m = m
    let good = 0
    if (cal) for (let t = Date.UTC(dp.y, m, 1); new Date(t).getUTCMonth() === m; t += 864e5) good += cal.days[Math.round((t - cal.t0) / 864e5)]?.q === 2
    b.innerHTML = `<b>${name.slice(0, 3)}</b>${cal ? `<small class="${good ? 'has' : ''}">${good} good days</small>` : ''}`
    b.setAttribute('aria-label', `${name} ${dp.y}${cal ? `, ${good} good landing days` : ''}`)
    return b
  })
  $('#dp-grid').replaceChildren(...cells)
  ;(cells.find((c) => c.classList.contains('sel')) || cells[0]).focus()
}

function renderDatePicker(focusT) {
  if (dp.view === 'month') return renderMonthPicker()
  $('.dp-week').hidden = false
  $('#dp-grid').classList.remove('months')
  $('#dp-title').textContent = `${MONTHS_LONG[dp.m]} ${dp.y}`
  $('#dp-title').setAttribute('aria-label', `${MONTHS_LONG[dp.m]} ${dp.y}, click to choose a month`)
  const first = Date.UTC(dp.y, dp.m, 1)
  const lead = (new Date(first).getUTCDay() + 6) % 7 // Monday-first grid
  const cal = dp.target.dots ? calendarFor(st.site, dp.y) : null, today = todayUTC(), sel = dp.target.value()
  const cells = []
  for (let k = 0; k < 42; k++) {
    const t = first + (k - lead) * 864e5, d = new Date(t), inMonth = d.getUTCMonth() === dp.m
    const b = document.createElement('button')
    b.className = `dp-day${inMonth ? '' : ' out'}${t === today ? ' today' : ''}${t === sel ? ' sel' : ''}`
    b.dataset.t = t
    b.tabIndex = t === focusT ? 0 : -1
    b.textContent = d.getUTCDate()
    const q = cal && inMonth ? cal.days[Math.round((t - cal.t0) / 864e5)]?.q : undefined
    b.setAttribute('aria-label', `${fmtLong(t)}${q !== undefined ? `, landing ${QUALITY[q]}` : ''}`)
    if (t === sel) b.setAttribute('aria-current', 'date')
    if (q !== undefined) { const i = document.createElement('i'); i.className = `q${q}`; b.append(i) }
    cells.push(b)
  }
  $('#dp-grid').replaceChildren(...cells)
  $(`#dp-grid [data-t="${focusT}"]`)?.focus()
}

function dpShift(months) {
  if (dp.view === 'month') { dp.y += Math.sign(months); return renderMonthPicker() }
  dp.m += months
  dp.y += Math.floor(dp.m / 12); dp.m = ((dp.m % 12) + 12) % 12
  renderDatePicker(Date.UTC(dp.y, dp.m, 1))
}

function toggleDatePicker(target, e) {
  e.stopPropagation(); setPicker(false); setAbout(false)
  setDatePicker($('#datepick').hidden || dp.target !== target, target)
}
$('#date-btn').onclick = (e) => toggleDatePicker(DP_TARGETS.landing, e)
$('#dp-prev').onclick = () => dpShift(-1)
$('#dp-next').onclick = () => dpShift(1)
$('#dp-today').onclick = () => { dp.target.pick(todayUTC()); setDatePicker(false) }
$('#dp-title').onclick = () => { dp.view = 'month'; renderMonthPicker() }
$('#dp-grid').addEventListener('click', (e) => {
  const mb = e.target.closest('.dp-month')
  if (mb) { dp.m = +mb.dataset.m; dp.view = 'day'; renderDatePicker(Date.UTC(dp.y, dp.m, 1)); return }
  const b = e.target.closest('.dp-day')
  if (b) { const tg = dp.target; tg.pick(+b.dataset.t); setDatePicker(false); tg.anchor().focus() }
})
// Arrow keys move by day/week (crossing months), PageUp/PageDown by month, Enter/Space picks.
$('#dp-grid').addEventListener('keydown', (e) => {
  const cur = +document.activeElement?.dataset?.t
  if (!cur) return
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]
  if (step || e.key === 'PageUp' || e.key === 'PageDown') {
    e.preventDefault()
    const d = new Date(cur)
    const t = step ? cur + step * 864e5 : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (e.key === 'PageUp' ? -1 : 1), d.getUTCDate())
    const nd = new Date(t)
    if (nd.getUTCMonth() !== dp.m || nd.getUTCFullYear() !== dp.y) { dp.y = nd.getUTCFullYear(); dp.m = nd.getUTCMonth() }
    renderDatePicker(t)
  }
})

$('#cal').addEventListener('pointermove', (ev) => {
  const h = calDayAt(ev)
  $('#cal-info').textContent = h
    ? `${fmtDay(h.t)}: ${h.d.lightH ? `sunlit for the next ${h.d.lightCapped ? '20+' : Math.round(h.d.lightH / 24 * 10) / 10} days` : 'dark at landing'} · Earth ${pct(h.d.earthPct)} of the first 5 days`
    : ''
})
$('#cal').addEventListener('click', (ev) => { const h = calDayAt(ev); if (h) setStart(h.t) })
$('#cal-best').onclick = () => { const cal = calendarFor(st.site); if (cal.best) setStart(cal.t0 + cal.best.from * 864e5) }

// ---------- illumination overlay (web worker) ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
const LAYER_INFO = {
  lit: ['% of time sunlit (power)', 'linear-gradient(90deg,#121a28,#6b5421,#ffcf4a)'],
  see: ['% of time Earth visible (communication)', 'linear-gradient(90deg,#121a28,#1d3a6b,#5b9dff)'],
  both: ['% of time sunlit and Earth visible', 'linear-gradient(90deg,#121a28,#0f4a3d,#5dcaa5)'],
}

function overlayHint() {
  const d = demFor(st.site.lat)
  const grid = d ? (d.kind === 'cyl' ? 'Resolusi grid 7,5 km (±120 km).' : 'Resolusi grid 2,5 km (±40 km).') : ''
  return `${grid} Hover the terrain to see values.`.trim()
}

function requestOverlay() {
  const s = st.site, d = demFor(s.lat), key = `${siteKey(s)}|${st.start}|${d?.id ?? 'flat'}`, id = ++st.ovId
  view.setOverlay(null)
  if (!d) { legendInfo(st.layer === 'normal' ? '' : 'Loading terrain data…'); return }
  if (st.ovCache.has(key)) { view.setOverlay(st.ovCache.get(key)); legendInfo(overlayHint()); return }
  legendInfo('Menghitung… 0%')
  const spacing = d.kind === 'cyl' ? Math.round(120000 / 16) : 2500
  worker.postMessage({ id, demId: d.id, lat: s.lat, lon: s.lon, start: st.start, spacing })
  st.ovPending = { id, key }
}

worker.onmessage = ({ data }) => {
  if (data.id !== st.ovId) return // stale result from a previous site/date
  if (data.progress != null) { legendInfo(`Menghitung… ${pct(data.progress)}`); return }
  st.ovCache.set(st.ovPending.key, data.result)
  view.setOverlay(data.result)
  renderInsight()
  renderMission(true)
  legendInfo(overlayHint())
}

function legendInfo(html) { $('#legend-info').innerHTML = html }

function applyLayer(layer) {
  st.layer = layer
  for (const x of document.querySelectorAll('#layers button')) x.classList.toggle('on', x.dataset.layer === layer)
  const info = LAYER_INFO[layer]
  const hideLegend = space?.visible || !info
  $('#legend').hidden = hideLegend
  if (info) { $('#legend-title').textContent = info[0]; $('#legend-bar').style.background = info[1] }
  view.setLayer(layer)
}

for (const b of document.querySelectorAll('#layers button')) {
  b.onclick = () => {
    surfaceSavedLayer = null
    applyLayer(b.dataset.layer)
  }
}

function onHover(v) {
  if (!v) return
  legendInfo(`${v.km.toFixed(1)} km from site · sunlit <b>${pct(v.lit)}</b> · Earth <b>${pct(v.see)}</b> · both <b>${pct(v.both)}</b><br>Double-click to land here.`)
}

// ---------- surface view ----------
$('#surface-btn').onclick = () => {
  st.surface = !st.surface
  view.setMode(st.surface ? 'surface' : 'orbit')
  $('#surface-btn').textContent = st.surface ? 'Back to orbit' : 'View from surface'
  $('#surface-tools').hidden = !st.surface
}
for (const b of document.querySelectorAll('#surface-tools button')) {
  b.onclick = () => {
    const s = seriesFor(st.site), i = st.idx
    // Aim and zoom so the body fills a good part of the view (true angular size).
    if (b.dataset.look === 'sun') view.lookAt(s.sunAz[i], s.sunEl[i], st.pose.sunR * 2 * 7)
    else view.lookAt(s.earthAz[i], s.earthEl[i], st.pose.earthR * 2 * 3)
  }
}

// ---------- compare: scenario table (site × landing date) ----------
const ephCache = new Map(), scCache = new Map()
function ephFor(start) {
  if (start === st.start) return st.eph
  if (!ephCache.has(start)) {
    if (ephCache.size >= 6) ephCache.delete(ephCache.keys().next().value)
    ephCache.set(start, Array.from({ length: N }, (_, i) => ephem(new Date(start + i * STEP_MIN * 60e3))))
  }
  return ephCache.get(start)
}
function seriesAt(site, start) {
  if (start === st.start) return seriesFor(site)
  const d = demFor(site.lat)
  const key = `${siteKey(site)}|${start}|${d?.id ?? 'flat'}`
  if (!scCache.has(key)) {
    const { hz, dist } = horizonFor(site)
    scCache.set(key, computeSeries(ephFor(start), site.lat, site.lon, hz, dist, STEP_MIN))
  }
  return scCache.get(key)
}
const longestOff = (arr) => { let run = 0, best = 0; for (const v of arr) { run = v ? 0 : run + 1; best = Math.max(best, run) } return best * STEP_MIN / 60 }

// Rows: current site, pinned sites (same date), then "launch slips" of the current site.
function scenarios() {
  const rows = [st.site, ...st.pinned.filter((p) => p !== st.site)].map((site) => ({ site, days: 0, pinned: site !== st.site }))
  for (const d of st.slips) rows.push({ site: st.site, days: d, slip: true })
  return rows.map((r) => {
    const start = st.start + r.days * 864e5, s = seriesAt(r.site, start)
    const ins = makeInsight({ s, stepMin: STEP_MIN, hasDem: !!demFor(r.site.lat) })
    return { ...r, start, s, ins, gapH: longestOff(s.earthVis) }
  })
}

const COLS = [
  { k: (r) => r.s.pLit, f: pct, best: Math.max },
  { k: (r) => r.s.pSee, f: pct, best: Math.max },
  { k: (r) => r.s.pBoth, f: pct, best: Math.max },
  { k: (r) => r.s.longestNightH, f: (h) => (h >= DAYS * 24 ? `${DAYS}+ days` : dur(h)), best: Math.min },
  { k: (r) => r.gapH, f: (h) => (h >= DAYS * 24 ? `${DAYS}+ days` : dur(h)), best: Math.min },
]
const VERDICT = { good: 'Suitable', risk: 'Risky', bad: 'Not suitable' }
let cmpKey = ''

function eventPairCell(arr, pred, start) {
  const rise = nextStateTime(arr, pred, 0, start, true)
  const set = nextStateTime(arr, pred, 0, start, false)
  const rTxt = rise ? fmtWhen(rise) : '—'
  const sTxt = set ? fmtWhen(set) : '—'
  return `↑ ${rTxt}<br>↓ ${sTxt}`
}

function renderCompare(force) {
  const key = [st.start, siteKey(st.site), ...st.pinned.map(siteKey), ...st.slips, loadedDemsKey()].join('|')
  if (!force && key === cmpKey) return
  cmpKey = key
  const rows = scenarios()
  const bests = COLS.map((c) => {
    const vals = rows.map(c.k), b = c.best(...vals)
    return rows.length > 1 && vals.some((v) => v !== b) ? b : null
  })
  $('#cmp-rows').replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr')
    if (!r.pinned && !r.slip) tr.className = 'cur'
    const date = `${fmtDay(r.start)} ${new Date(r.start).getUTCFullYear()}`
    const numCell = (i) => `<td class="num${bests[i] !== null && COLS[i].k(r) === bests[i] ? ' best' : ''}">${COLS[i].f(COLS[i].k(r))}</td>`
    tr.innerHTML = `<td><b></b><small>${date}${r.slip ? ` · launch delayed ${r.days} days` : ''}</small></td>
      <td><span class="vd"><span class="dot ${r.ins.level}"></span>${VERDICT[r.ins.level]}</span></td>
      ${numCell(0)}${numCell(1)}${numCell(2)}
      <td class="mono" style="font-size:11px;white-space:nowrap">${eventPairCell(r.s.sunVis, (v) => v >= 0.5, r.start)}</td>
      <td class="mono" style="font-size:11px;white-space:nowrap">${eventPairCell(r.s.earthVis, (v) => v === 1, r.start)}</td>
      ${numCell(3)}${numCell(4)}
      <td></td>`
    tr.querySelector('b').textContent = r.site.name
    tr.children[1].title = r.ins.title
    const act = tr.lastElementChild
    const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; act.append(b) }
    if (r.pinned || r.slip) btn('View', () => { selectSite(r.site); if (r.days) setStart(r.start) })
    if (r.pinned) btn('Remove', () => { st.pinned = st.pinned.filter((p) => p !== r.site); renderSites(); drawDock() })
    if (r.slip) btn('Remove', () => { st.slips = st.slips.filter((d) => d !== r.days); drawDock() })
    return tr
  }))

  // Factual trade-off comparison without crowning an automatic overall winner.
  const esc = (s) => s.replace(/</g, '&lt;')
  const label = (r) => `${esc(r.site.name)}${r.days ? ` (+${r.days}h)` : ''}`
  let sum = 'Add sites or delay scenarios to compare the 30-day window.'
  if (rows.length > 1) {
    const hiSun = rows.reduce((a, b) => (b.s.pLit > a.s.pLit ? b : a))
    const hiEarth = rows.reduce((a, b) => (b.s.pSee > a.s.pSee ? b : a))
    const hiBoth = rows.reduce((a, b) => (b.s.pBoth > a.s.pBoth ? b : a))
    sum = `Most sunlit: <b>${label(hiSun)}</b> (${pct(hiSun.s.pLit)}) · Most Earth: <b>${label(hiEarth)}</b> (${pct(hiEarth.s.pSee)}) · Both: <b>${label(hiBoth)}</b> (${pct(hiBoth.s.pBoth)}). The choice depends on power, communication and night tolerance.`
  }
  const base = rows[0], slips = rows.filter((r) => r.slip)
  if (slips.length) {
    const w = slips[slips.length - 1]
    sum += ` A +${w.days} day shift changes sunlit ${pct(base.s.pLit)} → ${pct(w.s.pLit)}, Earth ${pct(base.s.pSee)} → ${pct(w.s.pSee)}.`
  }
  $('#cmp-sum').innerHTML = sum
}

$('#slip').onchange = (e) => {
  const d = +e.target.value
  if (d && !st.slips.includes(d)) st.slips = [...st.slips, d].sort((a, b) => a - b)
  e.target.value = ''
  drawDock()
}

// ---------- mission: target landing time → inverse launch time (+ Δv, propellant, speeds, diagram) ----------
const ms = { launch: todayUTC() + 12 * 3600e3, pad: 'biak', route: 'artemis', engine: 'hyper', dryKg: 1500, wait: 1 }
let landingTargetMs = 0
const msPlan = (launch) => planMission({ launch, pad: ms.pad, route: ms.route, engine: ms.engine, dryKg: ms.dryKg, waitDays: ms.wait })
const msPlanForTarget = (landT = landingTargetMs, route = ms.route) => solveLaunchForLanding({ land: landT, pad: ms.pad, route, engine: ms.engine, dryKg: ms.dryKg, waitDays: ms.wait })
let recCache = { key: '', ranked: [] }
let recLoading = false
const fmtCoord = ({ lat, lon }) => `${num(Math.abs(lat), 2)}° ${lat < 0 ? 'S' : 'N'}, ${num(Math.abs(lon), 2)}° ${lon < 0 ? 'W' : 'E'}`
let msKey = ''
const fmtWhen = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` }
const num0 = (x) => Math.round(x).toLocaleString('en-US')
const dayOf = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) }

// Conditions at the site at the moment of touchdown.
function landingConditions(landT, site = st.site) {
  const start = dayOf(landT), i = Math.max(0, Math.min(N - 1, Math.round((landT - start) / (STEP_MIN * 60e3))))
  const s = seriesAt(site, start)
  const ins = makeInsight({ s, stepMin: STEP_MIN, hasDem: !!demFor(site.lat) })
  const hzAt = (az) => s.hz[((Math.round((az / 360) * s.hz.length) % s.hz.length) + s.hz.length) % s.hz.length]
  const sunEl = s.sunEl[i], sunAz = s.sunAz[i], sunHz = hzAt(sunAz), sunMargin = sunEl - sunHz
  const earthEl = s.earthEl[i], earthAz = s.earthAz[i], earthHz = hzAt(earthAz), earthMargin = earthEl - earthHz
  const sv = s.sunVis[i], ev = s.earthVis[i]
  return {
    start, i, sv, lit: sv >= 0.5, see: !!ev, ins,
    sunEl, sunAz, sunHz, sunMargin,
    earthEl, earthAz, earthHz, earthMargin,
    pLit: s.pLit, pSee: s.pSee, longestNightH: s.longestNightH,
  }
}

function syncAnalysisToLanding(landT) {
  const start = dayOf(landT)
  const i = Math.max(0, Math.min(N - 1, Math.round((landT - start) / (STEP_MIN * 60e3))))
  if (st.start !== start) setStart(start, { syncMission: false, preserveIdx: true })
  setIdx(i)
}

function renderMission(force) {
  if (!landingTargetMs) return
  const key = [landingTargetMs, ms.pad, ms.route, ms.engine, ms.dryKg, ms.wait, siteKey(st.site), loadedDemsKey()].join('|')
  if (!force && key === msKey) return
  msKey = key
  $('#ms-pad').value = ms.pad
  for (const [id, v] of [['#ms-route', ms.route], ['#ms-engine', ms.engine]])
    for (const b of document.querySelectorAll(`${id} button`)) { b.classList.toggle('on', b.dataset.v === v); b.setAttribute('aria-checked', b.dataset.v === v) }

  const p = msPlanForTarget(landingTargetMs)
  ms.launch = p.launch
  const etaEl = $('#ms-eta')
  if (etaEl) {
    etaEl.innerHTML = `Launch from ${p.pad.name.split(',')[0]}: <b>${fmtWhen(p.launch)} UTC</b> · ~${p.route.days} days`
    etaEl.title = `Launch ${fmtWhen(p.launch)} UTC → land ${fmtWhen(p.land)} UTC`
  }
  const steps = [
    ['Launch', `${p.pad.name} (${fmtCoord(p.pad)}), to 200 km orbit`, p.launch],
    ['Trans-lunar injection', `Upper stage, Δv ${num(p.dv.tli, 2)} km/s`, p.tli],
    ['Lunar orbit insertion', `${p.route.days}-day trip, Δv ${num(p.dv.loi, 2)} km/s`, p.arrive],
    ['Landing', `${st.site.name}, descent Δv ${num(p.dv.descent, 1)} km/s`, p.land],
  ]
  $('#ms-steps').replaceChildren(...steps.map(([h, sub, t]) => {
    const li = document.createElement('li')
    li.innerHTML = '<span><b></b><small></small><span class="step-live"></span></span><span class="when"></span>'
    li.querySelector('b').textContent = h
    li.querySelector('small').textContent = sub
    li.querySelector('.when').textContent = fmtWhen(t)
    return li
  }))

  const kpi = (label, value) => `<div><small>${label}</small><b>${value}</b></div>`
  $('#ms-kpis').innerHTML =
    kpi('Lander Δv', `${num(p.dv.lander, 2)} km/s`) + kpi('Propellant', `${num0(p.prop)} kg`) + kpi('Initial mass', `${num0(p.m0)} kg`) +
    kpi('After TLI', `${num(p.vAfterTli, 1)} km/s`) + kpi('Average', `${num0(p.vAvg * 3600)} km/h`) + kpi('Moon distance', `${num0(p.distKm)} km`)

  const box = $('#ms-land')
  if (box) {
    const lc = landingConditions(p.land)
    box.innerHTML = `<div class="top"><span class="badge ${lc.ins.level}"></span><b></b></div>
      <div class="top"><span class="chip ${lc.lit ? 'sun' : 'off'}">${lc.lit ? 'Sunlit' : 'Dark'}</span><span class="chip ${lc.see ? 'earth' : 'off'}">${lc.see ? 'Earth visible' : 'Earth blocked'}</span><small style="color:var(--muted)">at landing</small></div>
      <button class="btn" id="ms-use">Use this landing date in the analysis</button>`
    box.querySelector('.badge').textContent = VERDICT_LABEL[lc.ins.level]
    box.querySelector('b').textContent = lc.ins.title
    box.querySelector('#ms-use').onclick = () => { setStart(lc.start, { syncMission: false, preserveIdx: true }); setIdx(lc.i) }
  }

  // Launch slips: how a delay moves the landing and changes the verdict.
  const slipEl = $('#ms-slip')
  if (slipEl) {
    slipEl.replaceChildren(...[0, 7, 14].map((d) => {
      const q = msPlan(p.launch + d * 864e5)
      const c = landingConditions(q.land)
      const row = document.createElement('div')
      row.innerHTML = `<span>${d ? `Launch delayed ${d} days` : 'On schedule'} → lands <b>${fmtDay(q.land)}</b></span><span class="dot ${c.ins.level}"></span><span>${VERDICT_LABEL[c.ins.level]}</span>`
      return row
    }))
  }

  // Transparent deterministic ranking of loaded candidate lunar landing sites at touchdown `p.land`.
  renderRoutePop()

  buildSim(p)
}

// Rankings are memoised per landing moment + loaded DEMs, so hovering between routes in the
// recommendation popup doesn't re-rank 15 sites each time.
const rankMemo = new Map()
function getRankedForLanding(landT) {
  const loadedCount = SITES.filter((site) => Boolean(demFor(site.lat))).length
  const recKey = `${landT}:${st.dems.size}:${loadedCount}`
  if (recCache.key !== recKey) {
    let ranked = rankMemo.get(recKey)
    if (!ranked) {
      ranked = loadedCount ? rankLandingSites({
        sites: SITES,
        landT,
        surfaceDays: SURFACE_WINDOW_DAYS,
        seriesAt,
        hasDem: (site) => Boolean(demFor(site.lat)),
      }) : []
      rankMemo.set(recKey, ranked)
      if (rankMemo.size > 12) rankMemo.delete(rankMemo.keys().next().value)
    }
    recCache = { key: recKey, ranked }
  }
  return { loadedCount, ranked: recCache.ranked }
}

// ---------- recommendation popup: hover a route (Cepat/Standar/Hemat) → top sites for that route ----------
const ROUTE_LABEL = { fast: 'Fast', artemis: 'Standard', low: 'Low-energy' }
let routePeek = null, routePopTimer = null
const routePlan = (route) => msPlanForTarget(landingTargetMs, route)

function renderRoutePop() {
  const pop = $('#route-pop')
  const route = routePeek || ms.route, p = msPlanForTarget(landingTargetMs, route)
  if (recPreview) return // the preview itself triggers re-renders; keep the hovered cards in place
  $('#rp-head').innerHTML = `<b>Recommended sites · ${ROUTE_LABEL[route]} route</b><span>Launch ${fmtWhen(p.launch)} UTC → land ${fmtWhen(p.land)} UTC${route === ms.route ? '' : ' · click the route to use it'}</span>`
  fillRecContainer($('#ms-rec'), p, route)
  if (!pop.hidden) placeRoutePop()
}

function placeRoutePop() {
  const pop = $('#route-pop'), app = $('#app').getBoundingClientRect(), side = $('#side').getBoundingClientRect()
  const btn = document.querySelector(`#ms-route button[data-v="${routePeek || ms.route}"]`)?.getBoundingClientRect() || side
  const left = Math.min(side.right - app.left + 8, app.width - pop.offsetWidth - 12)
  const top = Math.min(Math.max(12, btn.top - app.top - 12), app.height - pop.offsetHeight - 12)
  pop.style.left = `${Math.max(12, left)}px`; pop.style.top = `${Math.max(12, top)}px`
}

// Preview = temporarily select the site and jump the analysis clock to its landing moment;
// the real selection is restored when the pointer leaves (unless the card is clicked).
let recPreview = null, recPreviewTimer = null
function previewRec(site, landT) {
  clearTimeout(recPreviewTimer)
  if (!demFor(site.lat)) return
  if (!recPreview) recPreview = { site: st.site, start: st.start, idx: st.idx }
  if (st.site !== site) selectSite(site)
  syncAnalysisToLanding(landT)
}
function endRecPreview(delay = 0) {
  clearTimeout(recPreviewTimer)
  recPreviewTimer = setTimeout(() => {
    if (!recPreview) return
    const { site, start, idx } = recPreview
    recPreview = null
    if (st.site !== site) selectSite(site)
    if (st.start !== start) setStart(start, { syncMission: false, preserveIdx: true })
    setIdx(idx)
    renderRoutePop()
  }, delay)
}

function showRoutePop(route) {
  if (route !== routePeek) endRecPreview()
  clearTimeout(routePopTimer)
  routePeek = route
  for (const b of document.querySelectorAll('#ms-route button')) b.classList.toggle('peek', b.dataset.v === route)
  $('#route-pop').hidden = false
  renderRoutePop()
}
// Small delay so the pointer can travel from the route button into the popup.
function hideRoutePop(delay = 220) {
  clearTimeout(routePopTimer)
  routePopTimer = setTimeout(() => {
    endRecPreview()
    $('#route-pop').hidden = true
    routePeek = null
    for (const b of document.querySelectorAll('#ms-route button')) b.classList.remove('peek')
  }, delay)
}

function nearbyTipFor(r, landT) {
  const d = demFor(r.site.lat)
  if (!d) return null
  const ov = st.ovCache.get(`${siteKey(r.site)}|${dayOf(landT)}|${d.id}`) || st.ovCache.get(`${siteKey(r.site)}|${st.start}|${d.id}`)
  return ov ? bestNearbyFromOverlay(ov, r.site) : null
}

function fillRecContainer(recEl, p, route = ms.route) {
  if (!recEl) return
  const { loadedCount, ranked } = getRankedForLanding(p.land)
  const top = ranked.slice(0, 3)
  const allLoaded = st.dems.size >= 3
  const btnLabel = recLoading
    ? 'Loading DEM…'
    : (allLoaded ? 'All 15 sites rated' : 'Rate all 15 sites')
  const nightTxt = (r) => (r.longestNightH >= SURFACE_WINDOW_DAYS * 24 ? `${SURFACE_WINDOW_DAYS}+h` : dur(r.longestNightH))
  recEl.innerHTML = `
    <div class="ms-rec-head">
      <span>${SURFACE_WINDOW_DAYS}-day mission · ${loadedCount}/${SITES.length} sites with terrain data</span>
      <button class="field ms-btn-sm" data-load-all="1" type="button" ${recLoading || allLoaded ? 'disabled' : ''}>${btnLabel}</button>
    </div>
    <div class="ms-rec-list">
      ${top.length ? top.map((r, i) => {
        const tip = i === 0 ? nearbyTipFor(r, p.land) : null
        return `
        <div class="ms-rec-item${r.site.id === st.site.id ? ' active' : ''}" data-rec-card="${r.site.id}" role="button" tabindex="0" aria-label="Choose ${r.site.name}">
          <div class="ms-rec-top">
            <span class="ms-rec-name"><span class="dot ${r.ins.level}"></span><span>#${i + 1} ${r.site.name}</span></span>
            <span class="ms-score">${Math.round(r.score)}/100</span>
          </div>
          <div class="ms-rec-meta sub">At landing: ${r.litNow ? 'Sunlit' : 'Dark'} · ${r.earthNow ? 'Earth visible' : 'Earth blocked'}</div>
          <div class="ms-rec-meta">${SURFACE_WINDOW_DAYS} d: Sunlit ${Math.round(r.pLit * 100)}% · Earth ${Math.round(r.pSee * 100)}% · Longest night ${nightTxt(r)}</div>
          ${tip ? `<button class="ms-rec-tip" type="button" data-tip-lat="${tip.lat.toFixed(4)}" data-tip-lon="${tip.lon.toFixed(4)}">Move ${num(tip.distKm, 1)} km ${tip.dir}: sunlit ${Math.round(tip.lit * 100)}% · Earth ${Math.round(tip.see * 100)}%</button>` : ''}
          <div class="ms-rec-hint">${r.site.id === st.site.id ? 'Selected' : 'Click to choose'}</div>
        </div>`
      }).join('') : '<div class="ms-rec-meta">Loading NASA LOLA terrain data…</div>'}
    </div>
  `
  recEl.querySelectorAll('[data-tip-lat]').forEach((btn) => {
    btn.onclick = () => {
      addCustom(+btn.dataset.tipLat, +btn.dataset.tipLon)
      syncAnalysisToLanding(p.land)
      setSpace(false)
    }
  })
  recEl.querySelectorAll('[data-load-all]').forEach((loadBtn) => {
    loadBtn.onclick = () => {
      if (recLoading || st.dems.size >= 3) return
      recLoading = true
      renderMission(true)
      Promise.all([ensureDem(-89), ensureDem(0), ensureDem(89)]).finally(() => {
        recLoading = false
        recCache.key = ''
        renderMission(true)
      })
    }
  })
  // Hover a card → the 3D map previews that site at its landing moment; click → choose it.
  recEl.querySelectorAll('[data-rec-card]').forEach((card) => {
    const site = SITES.find((s) => s.id === card.dataset.recCard)
    if (!site) return
    const choose = async () => {
      recPreview = null // keep what is on screen: it becomes the real selection
      clearTimeout(recPreviewTimer)
      if (route !== ms.route) ms.route = route // picked from a previewed route: adopt it
      await ensureDem(site.lat)
      selectSite(site)
      syncAnalysisToLanding(p.land)
      renderMission(true)
      setSpace(false)
      view.resetCamera()
      hideRoutePop(0)
    }
    card.addEventListener('click', (e) => { if (!e.target.closest('button')) choose() })
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose() } })
    card.addEventListener('mouseenter', () => previewRec(site, p.land))
    card.addEventListener('focus', () => previewRec(site, p.land))
    card.addEventListener('mouseleave', () => endRecPreview(120))
  })
  syncPlayLocks()
}

function onLaunchScheduleChange(autoPickBest = false) {
  recCache.key = ''
  const p = msPlanForTarget(landingTargetMs)
  ms.launch = p.launch
  const { ranked } = getRankedForLanding(p.land)
  const bestSite = autoPickBest ? (ranked[0]?.site || st.site) : null
  if (bestSite && bestSite !== st.site) selectSite(bestSite)
  syncAnalysisToLanding(p.land)
  renderMission(true)
}

// ---------- mission simulation (animated, schematic, seen from above Earth's north pole) ----------
// The frame is rotated so the Moon at arrival sits on the right. The Moon itself moves along
// its orbit using the real ephemeris, so the craft "meets" it at arrival.
const sim = { p: null, u: 0, playing: false, pts: [], rot: 0 }
const SURF_U_START = 0.80 // 0..0.80 = peluncuran → mendarat; 0.80..1.00 = timelapse permukaan 7 hari (~9,6 dtk)
const SIM_SECONDS = 48 // 5 s 1× Earth liftoff, descent→touchdown, and ~9.6 s surface timelapse
const LEO_PERIOD = 88.5 * 60e3, LLO_PERIOD = 118 * 60e3
const PHASE_NAME = {
  ascent: 'Ascent to Earth orbit', leo: 'Earth parking orbit', tli: 'TLI burn', coast: 'Coasting to the Moon',
  loi: 'Lunar orbit insertion', llo: 'Lunar orbit', descent: 'Descent to surface', landed: 'Landed',
}
const BURNING = new Set(['ascent', 'tli', 'loi', 'descent'])

// Slider position u (0..1) → mission time (launch → touchdown → SURFACE_WINDOW_DAYS surface timelapse).
function simTime(u) {
  const p = sim.p, asc = p.launch + 9 * 60e3, desc = p.land - 15 * 60e3
  const tliPre = Math.max(asc + 60e3, p.tli - 2 * 60e3)
  const sep2End = Math.min(p.arrive - 60e3, p.tli + 8 * 60e3)
  const loiEnd = Math.min(desc, p.arrive + 20 * 60e3), lloStart = Math.max(loiEnd, desc - LLO_PERIOD)
  const seg = [
    [0, p.launch],
    [0.105, p.launch + 5000],
    [0.21, asc],
    [0.29, tliPre],
    [0.33, p.tli],
    [0.41, sep2End],
    [0.49, p.arrive],
    [0.53, loiEnd],
    [0.53, lloStart],
    [0.60, desc],
    [0.65, p.land - 10000],
    [SURF_U_START, p.land],
    [1, p.land + SURFACE_WINDOW_DAYS * 864e5],
  ]
  for (let i = 1; i < seg.length; i++) {
    if (u <= seg[i][0]) {
      const [a, t0] = seg[i - 1], [b, t1] = seg[i]
      return t0 + ((u - a) / (b - a || 1)) * (t1 - t0)
    }
  }
  return p.land + SURFACE_WINDOW_DAYS * 864e5
}

function buildSim(p) {
  sim.p = p
  sim.rot = moonAngle(p.arrive)
  sim.u = Math.min(sim.u, 1)
  space?.setPlan(p, st.site, demFor(st.site.lat))
  drawSim()
}

// ---------- "Misi 3D": swaps the lunar-surface view for the Earth–Moon space view ----------
let space = null, didAutoFocus = false, didAutoTerrain = false, didFocusLapse = false, spaceClock = 'sim'
let surfaceSavedLayer = null

function restoreSavedLayer() {
  if (surfaceSavedLayer === null) return
  const prev = surfaceSavedLayer
  surfaceSavedLayer = null
  applyLayer(prev)
}

function exitWalkIfNeeded() {
  if (!st.surface) return
  st.surface = false
  $('#surface-btn').textContent = 'View from surface'
  $('#surface-tools').hidden = true
}

function setSpace(on) {
  if (on && !space) {
    space = createSpace($('#view'))
    if (import.meta.env.DEV) window.__space = space // for manual checks in the console
  }
  if (!space) return
  if (on) { renderMission(true); space.setPlan(sim.p, st.site, demFor(st.site.lat)) }
  space.show(on)
  const useTimeline = st.playing || (spaceClock === 'timeline' && !sim.playing)
  if (on) space.setTime(useTimeline ? timelineEpochMs() : simTime(sim.u), { timelineDriven: useTimeline })
  $('#sim-3d').classList.toggle('on', on)
  $('#sim-3d').textContent = on ? 'Close 3D' : 'View 3D'
  for (const id of ['#layers', '#reset-cam-btn', '#surface-btn', '#moon-cam-row']) {
    const el = $(id); if (el) el.hidden = on
  }
  if (on) { $('#surface-tools').hidden = true; $('#legend').hidden = true }
  else { $('#surface-tools').hidden = !st.surface; $('#legend').hidden = !LAYER_INFO[st.layer] }
  $('#space-cam').hidden = !on; $('#space-exit').hidden = !on
  const td = $('#traj-details')
  if (td) td.hidden = !(on || sim.playing || sim.u > 0)
  if (!on && sim.u === 0 && !sim.playing) { const h = $('#land-hud'); if (h) h.hidden = true }
}
$('#sim-3d').onclick = () => {
  const on = !space?.visible
  if (st.playing) {
    setSpace(on)
    if (on) {
      const curCam = document.querySelector('#space-cam button.on')?.dataset.cam
      setCam(curCam === 'overview' ? 'overview' : 'moon')
    }
    return
  }
  spaceClock = 'sim'
  if (on && sim.u >= 1) sim.u = 0
  setSpace(on)
  if (on) {
    setCam('craft')
    drawSim()
    if (!sim.playing) simPlay(true)
  }
}
$('#space-exit').onclick = () => {
  simPlay(false)
  restoreSavedLayer()
  spaceClock = 'sim'
  sim.u = 0
  $('#sim-u').value = '0'
  didAutoFocus = false
  didAutoTerrain = false
  didFocusLapse = false
  resetHudState()
  view.setFlight(null)
  const h = $('#land-hud'); if (h) h.hidden = true
  if (sim.p) syncAnalysisToLanding(sim.p.land)
  setSpace(false)
  drawSim()
}
function setCam(m) {
  for (const x of document.querySelectorAll('#space-cam button')) x.classList.toggle('on', x.dataset.cam === m)
  space?.setMode(m)
  if (m === 'landing') { setSpace(false); view.focusLanding() }
  if (sim.p) {
    const useTimeline = st.playing || (spaceClock === 'timeline' && !sim.playing)
    drawSim(useTimeline ? { timelineT: timelineEpochMs() } : {})
  }
}
for (const b of document.querySelectorAll('#space-cam button')) b.onclick = () => setCam(b.dataset.cam)
// "Luncurkan roket": open the 3D view at liftoff, camera on the rocket, and play.
$('#ms-go').onclick = () => {
  if (st.playing) return
  simPlay(false)
  restoreSavedLayer()
  sim.u = 0
  didAutoFocus = false
  didAutoTerrain = false
  didFocusLapse = false
  resetHudState()
  if (sim.p) syncAnalysisToLanding(sim.p.land)
  spaceClock = 'sim'
  setSpace(true)
  drawSim()
  setCam('craft')
  simPlay(true)
}

function simGeom(w, h) {
  const low = sim.p.route.days > 20 // low-energy route
  const ex = low ? w * 0.22 : w * 0.3, ey = h * 0.55
  const R = low ? Math.min(w * 0.2, h * 0.32) : Math.min(w * 0.6, h * 0.42)
  return { low, ex, ey, R, rp: Math.max(14, R * 0.12) }
}

// Transfer path in math coords (y up), each point tagged with time fraction f (0..1).
function simPath({ low, R, rp }) {
  const pts = []
  if (!low) {
    // ponytail: perigee drawn at 12% of the Moon's distance (really ~1.7%) so the arc is readable.
    const ra = R, e = (ra - rp) / (ra + rp), a = (ra + rp) / 2
    for (let k = 0; k <= 160; k++) {
      const nu = (k / 160) * Math.PI, r = (a * (1 - e * e)) / (1 + e * Math.cos(nu))
      const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2 - 1e-9))
      pts.push({ x: r * Math.cos(Math.PI + nu), y: r * Math.sin(Math.PI + nu), f: (E - e * Math.sin(E)) / Math.PI })
    }
    pts[pts.length - 1].f = 1
  } else {
    // ponytail: low-energy route drawn as two Béziers out past the Moon and back; not to scale.
    const bez = (p0, p1, p2, p3, t) => p0.map((_, i) => (1 - t) ** 3 * p0[i] + 3 * (1 - t) ** 2 * t * p1[i] + 3 * (1 - t) * t * t * p2[i] + t ** 3 * p3[i])
    const A0 = [-rp, 0], far = [R * 3.1, -R * 0.4], M = [R, 0]
    for (let k = 0; k <= 80; k++) { const [x, y] = bez(A0, [-R * 0.6, -R * 1.5], [R * 1.9, -R * 2.2], far, k / 80); pts.push({ x, y, f: (k / 80) * 0.5 }) }
    for (let k = 1; k <= 80; k++) { const [x, y] = bez(far, [R * 3.8, R * 1.2], [R * 1.7, R * 0.9], M, k / 80); pts.push({ x, y, f: 0.5 + (k / 80) * 0.5 }) }
  }
  return pts
}

const lerpPath = (pts, f) => {
  const i = pts.findIndex((o) => o.f >= f)
  if (i <= 0) return pts[Math.max(0, i)]
  const a = pts[i - 1], b = pts[i], k = (f - a.f) / (b.f - a.f || 1)
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
}

// Craft position (math coords) at mission time t.
function craftAt(t, G, pts) {
  const p = sim.p, s = missionState(p, t)
  const moonA = moonAngle(t) - sim.rot, mx = G.R * Math.cos(moonA), my = G.R * Math.sin(moonA)
  if (s.phase === 'ascent' || s.phase === 'leo' || s.phase === 'tli') {
    const ang = Math.PI - (2 * Math.PI * (p.tli - t)) / LEO_PERIOD // ends at perigee (left) at TLI
    const r = s.phase === 'ascent' ? 7 + (G.rp - 7) * Math.sin((s.k * Math.PI) / 2) : G.rp
    return { s, x: r * Math.cos(ang), y: r * Math.sin(ang), mx, my }
  }
  if (s.phase === 'coast') { const q = lerpPath(pts, s.f); return { s, x: q.x, y: q.y, mx, my } }
  const ang = (2 * Math.PI * (t - p.arrive)) / LLO_PERIOD
  const r = s.phase === 'descent' ? 12 * (1 - s.k) : s.phase === 'landed' ? 0 : 12
  return { s, x: mx + r * Math.cos(ang), y: my + r * Math.sin(ang), mx, my }
}

function drawSim(opts = {}) {
  if (!sim.p) return
  const c = $('#ms-canvas'), [g, w, h] = fit(c), G = simGeom(w, h), pts = simPath(G)
  const P = (x, y) => [G.ex + x, G.ey - y]
  const timelineMode = opts.timelineT != null || st.playing || (!sim.playing && space?.visible && spaceClock === 'timeline')
  const t = opts.timelineT ?? (timelineMode ? timelineEpochMs() : simTime(sim.u))
  const cur = craftAt(t, G, pts)
  g.clearRect(0, 0, w, h)

  // Moon orbit, Earth (+ LEO ring)
  g.setLineDash([3, 4]); g.strokeStyle = '#2a3340'; g.lineWidth = 1
  g.beginPath(); g.arc(G.ex, G.ey, G.R, 0, 7); g.stroke()
  g.beginPath(); g.arc(G.ex, G.ey, G.rp, 0, 7); g.stroke(); g.setLineDash([])
  g.fillStyle = css('--earth'); g.beginPath(); g.arc(G.ex, G.ey, 7, 0, 7); g.fill()

  // Full path faded, travelled part bright
  const line = (from, to, style, width) => {
    g.strokeStyle = style; g.lineWidth = width; g.beginPath()
    pts.filter((q) => q.f >= from && q.f <= to).forEach((q, k) => { const [x, y] = P(q.x, q.y); k ? g.lineTo(x, y) : g.moveTo(x, y) })
    g.stroke()
  }
  line(0, 1, 'rgba(255,90,54,0.3)', 1.5)
  const done = cur.s.phase === 'coast' ? cur.s.f : cur.s.f >= 1 || ['loi', 'llo', 'descent', 'landed'].includes(cur.s.phase) ? 1 : 0
  if (done > 0) line(0, done, css('--accent'), 2)

  // day markers
  const days = sim.p.route.days, step = days > 20 ? 20 : 1
  g.font = '11px ui-monospace, monospace'
  for (let d = step; d < days; d += step) {
    const q = lerpPath(pts, d / days), [x, y] = P(q.x, q.y)
    g.fillStyle = 'rgba(255,210,196,0.7)'; g.beginPath(); g.arc(x, y, 2.5, 0, 7); g.fill()
    g.fillStyle = css('--muted'); g.fillText(`D+${d}`, x + 5, y + (G.low ? -6 : 13))
  }
  if (G.low) { g.fillStyle = css('--muted'); const [fx, fy] = P(G.R * 3.1, -G.R * 0.4); g.fillText('~1.5 million km (not to scale)', Math.min(fx - 60, w - 170), fy - 10) }

  // Moon where it is right now (moves along its orbit), and where it will be at arrival
  if (sim.u < 0.72) {
    const [ax, ay] = P(G.R, 0)
    g.strokeStyle = 'rgba(201,198,189,0.5)'; g.setLineDash([2, 3]); g.beginPath(); g.arc(ax, ay, 8, 0, 7); g.stroke(); g.setLineDash([])
    g.fillStyle = css('--muted'); g.font = '11px system-ui'; g.fillText('meeting point', ax - 30, ay - 13)
  }
  const [mx, my] = P(cur.mx, cur.my)
  g.fillStyle = '#c9c6bd'; g.beginPath(); g.arc(mx, my, 7, 0, 7); g.fill()
  g.fillStyle = css('--text'); g.font = '600 11.5px system-ui'
  g.fillText('Moon', mx + 10, my + 4); g.fillText('Earth', G.ex - 14, G.ey + 24)

  // Craft: a small arrow pointing along its motion, with a flame while an engine burns
  const ahead = craftAt(t + Math.max(60e3, (sim.p.land - sim.p.launch) * 1e-4), G, pts)
  const [cx, cy] = P(cur.x, cur.y), [nx, ny] = P(ahead.x, ahead.y)
  const ang = Math.atan2(ny - cy, nx - cx) || 0
  g.save(); g.translate(cx, cy); g.rotate(ang)
  if (BURNING.has(cur.s.phase)) {
    g.fillStyle = '#ffb347'; g.beginPath(); g.moveTo(-5, 0); g.lineTo(-13 - Math.random() * 4, -3); g.lineTo(-13 - Math.random() * 4, 3); g.closePath(); g.fill()
  }
  g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(7, 0); g.lineTo(-5, -4); g.lineTo(-3, 0); g.lineTo(-5, 4); g.closePath(); g.fill()
  g.restore()

  const phase = cur.s.phase
  if (phase !== 'descent' && phase !== 'landed') {
    didAutoFocus = false
    didAutoTerrain = false
    didFocusLapse = false
    restoreSavedLayer()
  } else if (phase === 'descent') {
    didFocusLapse = false
    restoreSavedLayer()
    if (!didAutoTerrain) {
      didAutoTerrain = true
      exitWalkIfNeeded()
      if (space?.visible) setSpace(false)
      view.focusLanding()
    }
    const inFinalLanding = (cur.s.rem ?? 99) <= 10.2
    if (!inFinalLanding) didAutoFocus = false
    else if (!space?.visible && !didAutoFocus) {
      didAutoFocus = true
      view.focusLanding()
    }
  } else {
    // landed: surface timelapse phase (SURF_U_START .. 1)
    if (!didAutoTerrain) {
      didAutoTerrain = true
      if (space?.visible) setSpace(false)
    }
    const surfaceActive = sim.u >= SURF_U_START && (sim.playing || sim.u < 1)
    if (surfaceActive) {
      if (!didFocusLapse) {
        didFocusLapse = true
        exitWalkIfNeeded()
        view.focusLapse()
      }
      if (surfaceSavedLayer === null) {
        surfaceSavedLayer = st.layer
        if (st.layer !== 'both') applyLayer('both')
      }
    } else {
      restoreSavedLayer()
    }
  }

  const td = $('#traj-details')
  if (td) td.hidden = !(space?.visible || sim.playing || sim.u > 0)
  if (timelineMode) {
    renderTelemetry({ ...cur.s, t })
    renderLandingHud(cur.s, null, t)
    if (space?.visible && !opts.spaceAlreadyUpdated) space.setTime(t, { timelineDriven: true })
    view.setFlight(null)
    return
  }
  const liveSky = (space?.visible || sim.playing || sim.u > 0) ? liveSkyAt(t, st.site) : null
  renderTelemetry(cur.s)
  if (space?.visible) space.setTime(t)
  view.setFlight(sim.u > 0 || sim.playing ? cur.s : null)
  if (liveSky) renderLiveStatus(liveSky, t)
  renderLandingHud(cur.s, liveSky, t)
}

let hudDismissed = false, hudLastSampleK = -1, hudEventText = '', hudEventUntil = 0, hudCompareSiteId = ''

function resetHudState() {
  hudDismissed = false
  hudLastSampleK = -1
  hudEventText = ''
  hudEventUntil = 0
  hudCompareSiteId = ''
}

function ensureHudDom(hud) {
  if (hud.dataset.bound === '1') return
  hud.dataset.bound = '1'
  hud.innerHTML = `
    <div class="lh-head">
      <span class="lh-title" id="lh-site">-</span>
      <span class="lh-head-r"><span class="lh-day mono" id="lh-day">Day 1</span><button class="lh-close" id="lh-close" type="button" aria-label="Close" title="Close">×</button></span>
    </div>
    <div class="lh-chips">
      <span class="chip" id="lh-sun">-</span>
      <span class="chip" id="lh-earth">-</span>
      <span class="mono" id="lh-time" style="color:var(--muted);font-size:11px;margin-left:auto">-</span>
    </div>
    <div class="lh-event" id="lh-event" hidden></div>
    <div class="lh-foot" id="lh-foot" hidden>
      <span id="lh-sum">-</span>
      <button class="btn ms-btn-sm ms-btn-pri" id="lh-cmp2" type="button">Compare with option #2</button>
    </div>
  `
  hud.querySelector('#lh-close').onclick = () => { hudDismissed = true; hud.hidden = true }
  hud.querySelector('#lh-cmp2').onclick = async () => {
    if (!sim.p) return
    const { ranked } = getRankedForLanding(sim.p.land)
    const target = ranked.find((r) => r.site.id === hudCompareSiteId)?.site || ranked[1]?.site || ranked[0]?.site
    if (!target) return
    simPlay(false)
    await ensureDem(target.lat)
    selectSite(target)
    syncAnalysisToLanding(sim.p.land)
    setSpace(false)
    exitWalkIfNeeded()
    didAutoTerrain = true
    didFocusLapse = false
    resetHudState()
    sim.u = SURF_U_START
    drawSim()
    simPlay(true)
  }
}

function renderLandingHud(s, liveSky, t) {
  const hud = $('#land-hud')
  if (!hud || !sim.p) return
  const landedNow = (sim.playing || sim.u > 0) && s.phase === 'landed'
  if (!landedNow) {
    if (s.phase !== 'landed') { hudLastSampleK = -1; hudEventText = ''; hudEventUntil = 0 }
    hud.hidden = true
    return
  }
  ensureHudDom(hud)
  hud.hidden = hudDismissed
  if (hudDismissed) return

  const elapsedMs = Math.max(0, t - sim.p.land)
  const dayNum = Math.min(SURFACE_WINDOW_DAYS, Math.floor(elapsedMs / 864e5) + 1)
  const ser = seriesAt(st.site, sim.p.land)
  const k = Math.max(0, Math.min(SURFACE_WINDOW_DAYS * 48, Math.floor(elapsedMs / (STEP_MIN * 60e3))))

  // Detect Sun/Earth visibility transitions as surface time progresses.
  if (hudLastSampleK >= 0 && k > hudLastSampleK) {
    for (let m = hudLastSampleK + 1; m <= k; m++) {
      const prevLit = ser.sunVis[m - 1] >= 0.5, curLit = ser.sunVis[m] >= 0.5
      const prevSee = Boolean(ser.earthVis[m - 1]), curSee = Boolean(ser.earthVis[m])
      const dEv = Math.min(SURFACE_WINDOW_DAYS, Math.floor((m * STEP_MIN * 60e3) / 864e5) + 1)
      if (prevSee !== curSee) {
        hudEventText = `Day ${dEv}: Earth${curSee ? 'rise' : 'set'}`
        hudEventUntil = performance.now() + 2400
      } else if (prevLit !== curLit) {
        hudEventText = `Day ${dEv}: Sun${curLit ? 'rise' : 'set'}`
        hudEventUntil = performance.now() + 2400
      }
    }
  } else if (k < hudLastSampleK) {
    hudEventText = ''
    hudEventUntil = 0
  }
  hudLastSampleK = k

  const sv = liveSky?.sunVis ?? ser.sunVis[k]
  const ev = liveSky ? liveSky.earthVis : ser.earthVis[k]
  const lit = sv >= 0.5

  hud.querySelector('#lh-site').textContent = st.site.name
  hud.querySelector('#lh-day').textContent = `Day ${dayNum} / ${SURFACE_WINDOW_DAYS}`
  const sunEl = hud.querySelector('#lh-sun')
  sunEl.className = `chip ${sv >= 1 ? 'sun' : sv > 0 ? 'part' : 'off'}`
  sunEl.textContent = `Sun: ${lit ? 'Sunlit' : 'Dark'}`
  const earthEl = hud.querySelector('#lh-earth')
  earthEl.className = `chip ${ev ? 'earth' : 'off'}`
  earthEl.textContent = `Earth: ${ev ? 'Visible' : 'Blocked'}`
  hud.querySelector('#lh-time').textContent = `${fmtWhen(t)} UTC`

  const evEl = hud.querySelector('#lh-event')
  const showEv = Boolean(hudEventText) && performance.now() < hudEventUntil
  evEl.hidden = !showEv
  if (showEv) evEl.textContent = hudEventText

  const atEnd = sim.u >= 0.999 || (!sim.playing && t >= sim.p.land + SURFACE_WINDOW_DAYS * 864e5 - 60e3)
  const foot = hud.querySelector('#lh-foot')
  foot.hidden = !atEnd
  if (atEnd) {
    const { ranked } = getRankedForLanding(sim.p.land)
    const curStat = ranked.find((r) => r.site.id === st.site.id) || rankLandingSites({
      sites: [st.site], landT: sim.p.land, surfaceDays: SURFACE_WINDOW_DAYS, seriesAt,
    })[0]
    hud.querySelector('#lh-sum').textContent = curStat
      ? `${SURFACE_WINDOW_DAYS}-day summary: Sunlit ${Math.round(curStat.pLit * 100)}% · Earth ${Math.round(curStat.pSee * 100)}% · Both ${Math.round(curStat.pBoth * 100)}%`
      : `${SURFACE_WINDOW_DAYS} days on the surface complete`
    const opt2 = ranked[1]?.site
    const opt1 = ranked[0]?.site
    const target = opt2 && st.site.id !== opt2.id ? opt2 : (opt1 && st.site.id !== opt1.id ? opt1 : null)
    const cmpBtn = hud.querySelector('#lh-cmp2')
    if (target) {
      hudCompareSiteId = target.id
      cmpBtn.hidden = false
      cmpBtn.textContent = target === opt2 ? 'Compare with option #2' : `Compare with option #1 (${opt1.name})`
    } else {
      hudCompareSiteId = ''
      cmpBtn.hidden = true
    }
  }
}

function renderTelemetry(s) {
  const totSec = Math.max(0, Math.round(s.met * 3600))
  const d = Math.floor(totSec / 86400), remD = totSec % 86400
  const hh = Math.floor(remD / 3600), mm = Math.floor((remD % 3600) / 60), ss = remD % 60
  const met = `T+ ${d ? `${d} d ` : ''}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  const inSep2 = s.phase === 'coast' && sim.p && (s.t - sim.p.tli) < 8 * 60e3
  const phaseLbl = s.phase === 'ascent' && (s.dt ?? 99) <= 5 ? 'Liftoff (real time)'
    : inSep2 ? 'Stage 2 separation & solar panel deploy'
    : s.phase === 'descent' && (s.rem ?? 99) <= 10 ? 'Final vertical touchdown (real time)'
    : PHASE_NAME[s.phase]
  const altStr = s.alt < 1 ? `${num0(s.alt * 1000)} m` : `${num0(s.alt)} km`
  const velStr = s.v < 0.2 ? `${num0(s.v * 1000)} m/s` : `${num(s.v, 2)} km/s`
  const where = s.ref === 'moon' ? ['Altitude (Moon)', altStr]
    : s.phase === 'coast' ? ['Distance from Earth', `${num0(s.dist)} km`] : ['Altitude (Earth)', altStr]
  const lc = landingConditions(sim.p.land, st.site)
  const kpi = (l, v) => `<div><small>${l}</small><b>${v}</b></div>`
  $('#sim-tel').innerHTML =
    kpi('Mission time', met) + kpi('Phase', phaseLbl) +
    kpi('Speed', velStr) + kpi(where[0], where[1]) +
    kpi('Date (UTC)', fmtWhen(s.t)) +
    kpi('Sun & Earth', `${lc.lit ? 'Sunlit' : 'Dark'} · ${lc.see ? 'Earth visible' : 'Earth blocked'}`)
  $('#sim-u').value = Math.round(sim.u * 1000)

  const activeStep = (s.phase === 'ascent' || s.phase === 'leo') ? 0
    : (s.phase === 'tli' || s.phase === 'coast') ? 1
    : (s.phase === 'loi' || s.phase === 'llo' || s.phase === 'descent') ? 2
    : 3
  document.querySelectorAll('#ms-steps li').forEach((li, idx) => {
    li.classList.toggle('active', idx === activeStep)
    li.classList.toggle('done', idx < activeStep)
    const liveEl = li.querySelector('.step-live')
    if (liveEl) {
      liveEl.textContent = idx === activeStep ? `${phaseLbl} · ${where[1]} · ${velStr}` : ''
    }
  })
}

function liveSkyAt(t, site = st.site) {
  const d = new Date(t)
  const { hz, dist } = horizonFor(site)
  const s = computeSeries([ephem(d)], site.lat, site.lon, hz, dist, STEP_MIN)
  return {
    sunAz: s.sunAz[0],
    sunEl: s.sunEl[0],
    sunVis: s.sunVis[0],
    earthAz: s.earthAz[0],
    earthEl: s.earthEl[0],
    earthVis: s.earthVis[0],
    t,
    pose: skyPose(d, site.lat, site.lon),
  }
}

function syncPlayLocks() {
  const tlPlaying = !!st.playing
  const rocketPlaying = !!sim.playing
  const playBtn = $('#play')
  if (playBtn) {
    playBtn.disabled = rocketPlaying
    playBtn.title = rocketPlaying
      ? 'The timeline cannot play while the rocket simulation is running'
      : 'Play / pause the 30-day timeline'
  }
  const rocketBtns = [
    $('#ms-go'),
    $('#sim-play'),
    $('#sim-u'),
  ]
  for (const btn of rocketBtns) {
    if (!btn) continue
    btn.disabled = tlPlaying
    if (tlPlaying) {
      btn.title = 'Stop the timeline first so the rocket launch does not clash with it'
    } else {
      btn.removeAttribute('title')
    }
  }
}

function simPlay(on) {
  if (on && st.playing) return
  if (on) spaceClock = 'sim'
  sim.playing = on
  $('#sim-play').innerHTML = icon(on ? 'pause' : 'play', 16)
  $('#sim-play').setAttribute('aria-label', on ? 'Pause simulation' : 'Play simulation')
  syncPlayLocks()
  if (!on) return
  if (sim.u >= 1) { sim.u = 0; resetHudState() }
  let last = performance.now()
  const tick = (now) => {
    if (!sim.playing) return
    sim.u = Math.min(1, sim.u + (now - last) / 1000 / SIM_SECONDS); last = now
    drawSim()
    if (sim.u >= 1) {
      simPlay(false)
      drawSim()
      return
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
$('#sim-play').onclick = () => simPlay(!sim.playing)
$('#sim-u').oninput = (e) => { spaceClock = 'sim'; sim.u = +e.target.value / 1000; drawSim() }

// Once the popup is open, another route takes over only when the pointer rests on it: moving
// diagonally from "Cepat" down to the cards crosses "Standar"/"Hemat" and must not switch.
let routeSwitchTimer = null
for (const b of document.querySelectorAll('#ms-route button')) {
  b.addEventListener('mouseenter', () => {
    clearTimeout(routeSwitchTimer)
    if ($('#route-pop').hidden || routePeek === b.dataset.v) return showRoutePop(b.dataset.v)
    clearTimeout(routePopTimer) // keep the current popup while deciding
    routeSwitchTimer = setTimeout(() => showRoutePop(b.dataset.v), 350)
  })
  b.addEventListener('focus', () => showRoutePop(b.dataset.v))
  b.addEventListener('mouseleave', () => { clearTimeout(routeSwitchTimer); hideRoutePop() })
  b.addEventListener('blur', (e) => { if (!$('#route-pop').contains(e.relatedTarget)) hideRoutePop() })
}
$('#route-pop').addEventListener('mouseenter', () => { clearTimeout(routePopTimer); clearTimeout(routeSwitchTimer) })
$('#route-pop').addEventListener('mouseleave', () => hideRoutePop())
$('#route-pop').addEventListener('focusout', (e) => { if (!$('#route-pop').contains(e.relatedTarget) && !e.relatedTarget?.closest?.('#ms-route')) hideRoutePop() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#route-pop').hidden) hideRoutePop(0) })

for (const [id, k] of [['#ms-route', 'route'], ['#ms-engine', 'engine']])
  for (const b of document.querySelectorAll(`${id} button`)) b.onclick = () => {
    ms[k] = b.dataset.v
    if (k === 'route') onLaunchScheduleChange(false)
    else renderMission()
  }
$('#ms-mass').oninput = (e) => { const v = +e.target.value; if (v >= 100 && v <= 100000) { ms.dryKg = v; renderMission() } }
$('#ms-pad').innerHTML = Object.entries(PADS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('')
$('#ms-pad').value = ms.pad
$('#ms-pad').onchange = (e) => {
  ms.pad = e.target.value
  onLaunchScheduleChange(false)
  if (space?.visible) {
    simPlay(false)
    sim.u = 0
    spaceClock = 'sim'
    setCam('craft')
    drawSim()
    simPlay(true)
  }
}
$('#ms-wait').oninput = (e) => { const v = +e.target.value; if (v >= 0 && v <= 30) { ms.wait = v; onLaunchScheduleChange(false) } }

// The 4 analysis panes inside #dock-pop are drawn on demand when open.
const DRAW = { pano: () => drawPano(), cal: () => drawCalendar(), cmp: () => renderCompare(), timeline: () => drawTimeline() }
const drawDock = () => { if (!$('#dock-pop')?.hidden) DRAW[st.tab]?.() }
function update() {
  const td = $('#tabs-date'); if (td) td.textContent = fmtDay(st.start)
  renderStatus()
  renderInsight()
  renderMission()
  drawDock()
  if (space?.visible && !sim.playing) {
    const t = timelineEpochMs()
    space.setTime(t, { timelineDriven: true })
    drawSim({ timelineT: t, spaceAlreadyUpdated: true })
  }
}

// ---------- interaction ----------
function setIdx(k) { spaceClock = 'timeline'; st.idx = Math.max(0, Math.min(N - 1, k)); update() }

function timelinePointer(ev) {
  const c = $('#timeline'), r = c.getBoundingClientRect(), x = ev.clientX - r.left, TL_LABEL = tlLabel()
  if (x < TL_LABEL) {
    if (ev.type !== 'pointerdown') return
    const row = tlRows()[Math.floor((ev.clientY - r.top) / ROW_H)]
    if (row) selectSite(row)
    return
  }
  setIdx(Math.round(((x - TL_LABEL) / (c.clientWidth - TL_LABEL - 8)) * (N - 1)))
}
$('#timeline').addEventListener('pointerdown', (e) => { timelinePointer(e); e.target.setPointerCapture(e.pointerId) })
$('#timeline').addEventListener('pointermove', (e) => { if (e.buttons) timelinePointer(e) })

const TAB_TITLES = { timeline: '30-day timeline', pano: 'Horizon', cal: 'Yearly calendar', cmp: 'Scenario comparison' }
let dockCloseTimer = null

function setDockOpen(open) {
  const pop = $('#dock-pop')
  if (!pop) return
  pop.hidden = !open
  for (const b of document.querySelectorAll('#dock-tabs button')) {
    const active = open && b.dataset.tab === st.tab
    b.classList.toggle('on', active)
    b.setAttribute('aria-expanded', String(active))
  }
  if (open) drawDock()
}

function setTab(tab) {
  if (!DRAW[tab]) return
  st.tab = tab
  const titleEl = $('#dock-title')
  if (titleEl && TAB_TITLES[tab]) titleEl.textContent = TAB_TITLES[tab]
  for (const p of document.querySelectorAll('#dock-pop [data-pane]')) p.hidden = p.dataset.pane !== tab
  setDockOpen(true)
}

const cancelDockClose = () => { if (dockCloseTimer) { clearTimeout(dockCloseTimer); dockCloseTimer = null } }
const scheduleDockClose = () => {
  cancelDockClose()
  dockCloseTimer = setTimeout(() => {
    const pop = $('#dock-pop'), tabs = $('#dock-tabs')
    if (pop?.matches(':hover') || tabs?.matches(':hover')) return
    if (pop?.contains(document.activeElement) && document.activeElement?.tagName === 'SELECT') return
    setDockOpen(false)
  }, 120)
}

for (const b of document.querySelectorAll('#dock-tabs button')) {
  b.addEventListener('mouseenter', () => { cancelDockClose(); setTab(b.dataset.tab) })
  b.addEventListener('click', () => { cancelDockClose(); setTab(b.dataset.tab) })
}
$('#dock-tabs')?.addEventListener('mouseenter', cancelDockClose)
$('#dock-tabs')?.addEventListener('mouseleave', scheduleDockClose)
$('#dock-pop')?.addEventListener('mouseenter', cancelDockClose)
$('#dock-pop')?.addEventListener('mouseleave', scheduleDockClose)

// ---------- resizable sidebar (drag right edge) ----------
// Pointer drag or arrow keys on the grip; the size is stored as a CSS variable and remembered.
function resizer({ grip, el, prop, key, size, clamp, delta, keys }) {
  if (!grip || !el) return
  const set = (v) => {
    v = Math.round(clamp(v))
    el.style.setProperty(prop, `${v}px`)
    try { localStorage.setItem(key, v) } catch {}
    drawDock() // canvases follow the new size
  }
  let drag = null
  grip.addEventListener('pointerdown', (e) => { e.preventDefault(); drag = { x: e.clientX, y: e.clientY, s: size() }; grip.classList.add('drag') })
  // Listen on window so the drag keeps working when the pointer leaves the thin grip.
  addEventListener('pointermove', (e) => { if (drag) set(drag.s + delta(e.clientX - drag.x, e.clientY - drag.y)) })
  addEventListener('pointerup', () => { if (drag) { drag = null; grip.classList.remove('drag') } })
  grip.addEventListener('keydown', (e) => { const d = keys[e.key]; if (d) { e.preventDefault(); set(size() + d) } })
  let saved = 0
  try { saved = +localStorage.getItem(key) } catch {}
  if (saved) el.style.setProperty(prop, `${saved}px`)
}
resizer({
  grip: $('#side-grip'), el: $('#app'), prop: '--side-w', key: 'lumanav.sideW',
  size: () => $('#side').offsetWidth,
  clamp: (w) => Math.max(220, Math.min(w, 520, innerWidth * 0.5)),
  delta: (dx) => dx, keys: { ArrowRight: 20, ArrowLeft: -20 },
})

function setSideClosed(closed) {
  $('#app')?.classList.toggle('side-closed', closed)
  const openBtn = $('#side-open')
  if (openBtn) openBtn.hidden = !closed
  if (closed) { setPicker(false); setAbout(false); setDatePicker(false) }
  drawDock(); drawSim()
}
$('#side-toggle')?.addEventListener('click', () => setSideClosed(true))
$('#side-open')?.addEventListener('click', () => setSideClosed(false))

function toggleBarCard(cardSel, btnSel, redraw) {
  const card = $(cardSel), btn = $(btnSel)
  if (!card || !btn) return
  const min = card.classList.toggle('min')
  btn.textContent = min ? '▸' : '▾'
  btn.setAttribute('aria-expanded', String(!min))
  if (!min && redraw) redraw()
}
$('#traj-hud-head')?.addEventListener('click', () => toggleBarCard('#traj-hud', '#traj-hud-toggle', drawSim))
$('#traj-details-head')?.addEventListener('click', () => toggleBarCard('#traj-details', '#traj-details-toggle'))

$('#play').onclick = () => {
  if (sim.playing) return
  spaceClock = 'timeline'
  st.playing = !st.playing
  $('#play').textContent = st.playing ? '❚❚' : '▶'
  syncPlayLocks()
  const tick = () => {
    if (!st.playing) return
    setIdx(st.idx >= N - 1 ? 0 : st.idx + 1)
    requestAnimationFrame(tick)
  }
  tick()
}

$('#custom').onsubmit = (e) => {
  e.preventDefault()
  addCustom(parseFloat($('#lat').value), parseFloat($('#lon').value))
  setPicker(false)
}
addEventListener('resize', () => { drawDock(); drawSim() })

// ---------- boot ----------
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon)
const view = createScene($('#view'), { onPick: (lat, lon) => addCustom(lat, lon), onHover })
const timeSel = $('#utc-time')
if (timeSel) {
  timeSel.replaceChildren(...Array.from({ length: 48 }, (_, s) => {
    const m = s * STEP_MIN, opt = document.createElement('option')
    opt.value = String(s)
    opt.textContent = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} UTC`
    return opt
  }))
}
const onUtcPick = () => {
  const d = Number($('#utc-day-off')?.value || 0), s = Number($('#utc-time')?.value || 0)
  const nextIdx = Math.min(N - 1, d * 48 + s)
  landingTargetMs = st.start + nextIdx * STEP_MIN * 60e3
  recCache.key = ''
  setIdx(nextIdx)
  renderMission(true)
}
$('#utc-day-off')?.addEventListener('change', onUtcPick)
$('#utc-time')?.addEventListener('change', onUtcPick)
$('#reset-cam-btn')?.addEventListener('click', () => {
  if (st.surface) { st.surface = false; $('#surface-btn').textContent = 'View from surface'; $('#surface-tools').hidden = true }
  view.resetCamera()
})

const pInit = msPlan(ms.launch)
st.start = dayOf(pInit.land)
st.idx = Math.max(0, Math.min(N - 1, Math.round((pInit.land - st.start) / (STEP_MIN * 60e3))))
landingTargetMs = st.start + st.idx * STEP_MIN * 60e3
ms.launch = msPlanForTarget(landingTargetMs).launch
$('#date-label').textContent = fmtLong(st.start)
syncUtcDayOptions()
computeEphem()

selectSite(st.site)
renderMission(true)
syncPlayLocks()
