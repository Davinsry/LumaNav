// JPL Horizons reference used by both `npm test` and the in-app "Metode & Data" panel.
// Query: CENTER='coord@301', SITE_COORD='-137.56,-89.444,0', QUANTITIES='4' (apparent az/el),
// 2027-01-01..15 step 2d, fetched 2026-11-14.
import { sunEarth } from './astro.js'

export const JPL_SITE = { name: 'Shackleton Connecting Ridge', lat: -89.444, lon: -137.56 }
export const JPL_T0 = Date.UTC(2027, 0, 1)
export const JPL_STEP_DAYS = 2
// [sunAz, sunEl, earthAz, earthEl] in degrees
export const JPL = [
  [40.683423, 1.435566, 144.710548, -6.701946], [16.33959, 1.516412, 143.214054, -7.420065],
  [351.974697, 1.503585, 141.017948, -6.924742], [327.597714, 1.390583, 138.433984, -5.363121],
  [303.218597, 1.18967, 135.706194, -3.004874], [278.846936, 0.929483, 133.103672, -0.222701],
  [254.49097, 0.649155, 131.001653, 2.541716], [230.157074, 0.390397, 129.893944, 4.802955],
]

const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180)

// Recompute every reference point with our model; returns per-row diffs and the worst one.
export function validate() {
  const rows = JPL.map(([sa, se, ea, ee], i) => {
    const t = JPL_T0 + i * JPL_STEP_DAYS * 864e5
    const r = sunEarth(JPL_SITE.lat, JPL_SITE.lon, new Date(t))
    const d = [angDiff(r.sun.az, sa), Math.abs(r.sun.el - se), angDiff(r.earth.az, ea), Math.abs(r.earth.el - ee)]
    return { t, ours: r, jpl: { sun: { az: sa, el: se }, earth: { az: ea, el: ee } }, max: Math.max(...d) }
  })
  return { rows, max: Math.max(...rows.map((r) => r.max)) }
}
