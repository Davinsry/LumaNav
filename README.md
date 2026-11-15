# LumaNav: Lunar Landing Site Navigator

> See the terrain. Predict the windows. Plan the landing.

NASA Space Apps Challenge 2026 · Challenge: **Lunar Landing Site Navigator** · Team Flashover

**Live demo:** https://lumanav-eta.vercel.app

LumaNav helps mission planners decide **where and when to land on the Moon**. Choose a launch site, a target landing date and a route, and LumaNav works out the launch time, then ranks candidate landing sites for that exact moment by what a lander needs most: **sunlight for solar power** and a **direct line of sight to Earth for communication**.

## Features

- **Launch planner**: 6 launch pads, landing date and time (UTC), and three routes to the Moon (Fast ~3 days, Standard ~5 days, Low-energy ~110 days, based on Apollo 11, Artemis I and CAPSTONE). The launch time is solved backward from the landing moment.
- **Site recommendations**: 15 candidate sites (south pole, near side, far side, north pole) ranked over the first 7 days on the surface. Hover a recommendation to preview it in 3D at the exact landing moment.
- **Site analysis**: Sun and Earth status, 30-day timeline, 360° horizon profile, yearly calendar of good landing days, illumination map, and side-by-side comparison of sites and launch delays.
- **3D terrain**: NASA LOLA elevation with shadows from the real Sun direction.
- **Flight simulation**: a real-scale Earth-Moon flight from the launch pad to touchdown on the exact coordinates, then a 7-day surface timelapse of real light and shadow.

## Run

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # checks against NASA JPL Horizons, LOLA map orientation, mission physics
npm run build   # static site in dist/ (base './', works on any static host)
```

## How it works

1. **Terrain**: NASA LRO LOLA elevation maps, 240 m per pixel at both poles (latitude 75.2° and beyond) and ~1.9 km per pixel everywhere else.
2. **Horizon**: from the landing point, rays are cast in 720 directions (every 0.5°) out to 150 km, including the Moon's curvature. The highest terrain angle in each direction forms the horizon line.
3. **Sky**: Sun and Earth azimuth and elevation are computed every 30 minutes for 30 days with `astronomy-engine` (VSOP87 and the IAU lunar rotation model, including libration). The Sun counts as lit when its 0.53° disc is above the horizon; Earth is visible when its centre is above it.
4. **Score (0-100)**: sunlit at touchdown (+20), Earth visible at touchdown (+10), share of time with both (+35), share of time sunlit (+20), continuous light at the start of the stay (+15). The same inputs always give the same ranking. A site whose terrain map is not loaded can never be ranked first.
5. **Mission**: Tsiolkovsky rocket equation with typical delta-v per phase, a Kepler transfer ellipse, a 100 km polar lunar orbit and a descent to the chosen coordinates. The launch pad turns with Earth's rotation.

## Validation

Sun and Earth positions were compared with NASA JPL Horizons at 8 epochs (1-15 Jan 2027): the maximum difference is **0.0055°**. The comparison is recomputed in the browser from the **Method** panel. `npm test` also checks that touchdown lands within 1 km of the target, flight speeds stay physical, the launch-time solver hits the landing time within 1 second, rankings are deterministic, and the LOLA maps are oriented correctly (including far-side and equator cases).

## Data and credits

- NASA LRO / LOLA gridded elevation data (PDS Geosciences Node): `LDEM_75S_240M`, `LDEM_75N_240M` and `LDEM_16`.
- NASA JPL Horizons: reference positions used for validation.
- NASA Scientific Visualization Studio, CGI Moon Kit (LRO LROC colour mosaic): Moon texture (`public/textures/moon.jpg`).
- NASA GIBS Blue Marble Next Generation and NASA Earth Observatory Black Marble 2016: Earth textures (`public/textures/`).
- [astronomy-engine](https://github.com/cosinekitty/astronomy) (MIT), [Three.js](https://threejs.org/) (MIT) and [Vite](https://vitejs.dev/) (MIT).
- The open-source Artemis II tracker by Javilop (MIT) was viewed for inspiration only; none of its code or assets are used.

## Limitations

- LumaNav analyses **lighting and line-of-sight geometry**. It is not a guarantee of landing success or radio link quality.
- Terrain away from the poles is ~1.9 km per pixel, so hills and craters smaller than ~2 km are not resolved there.
- The illumination map uses a coarser grid for speed, so its values are approximate.
- The mission planner uses typical delta-v values per phase. It is an early-planning estimate, not trajectory optimisation, and the low-energy path is drawn for illustration.
- Coordinates of some commercial landers are approximate.

## Use of AI

Claude (Anthropic) was used to help write and review code, tests and documentation, and to cross-check calculations against NASA JPL Horizons. Design decisions and testing were carried out by the team. The product itself contains no AI or machine-learning model: every result comes from deterministic, verifiable formulas.
