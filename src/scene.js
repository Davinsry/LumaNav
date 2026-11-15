// 3D view: real LOLA terrain around the site, lit by the real Sun direction.
// Local frame: x = east, y = up, z = south (metres, site at origin).
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { makeEarth, makeLanderModel, makeSun } from './bodies.js'
import { offsetLL, R } from './dem.js'

const D = Math.PI / 180
const SKY = 400000
const SKYLINE = 350000 // in front of the Sun/Earth sprites so it can hide them

const dirOf = (az, el) => new THREE.Vector3(
  Math.sin(az * D) * Math.cos(el * D), Math.sin(el * D), -Math.cos(az * D) * Math.cos(el * D))

// Overlay colour ramps (sRGB 0..1): dark → mid → bright, per layer.
const RAMPS = {
  lit: [[0.07, 0.1, 0.16], [0.42, 0.33, 0.13], [1, 0.81, 0.29]],
  see: [[0.07, 0.1, 0.16], [0.11, 0.23, 0.42], [0.36, 0.62, 1]],
  both: [[0.07, 0.1, 0.16], [0.06, 0.29, 0.24], [0.36, 0.79, 0.65]],
}
const ramp = (stops, v) => {
  const t = Math.min(1, Math.max(0, v)) * 2, i = Math.min(1, Math.floor(t)), f = t - i
  return stops[i].map((a, k) => a + (stops[i + 1][k] - a) * f)
}


// Procedural regolith detail (small craters + grain) as a tiling normal map. Purely visual:
// LOLA at 240 m/px is too smooth up close and reads like paper without it.
function regolithNormalMap(size = 512, seed = 7) {
  let r = seed
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647)
  const hgt = new Float32Array(size * size)
  for (let i = 0; i < hgt.length; i++) hgt[i] = (rnd() - 0.5) * 0.12
  // C1-continuous crater profile at bowl, rim (d = 1), and ejecta skirt so no sharp rings appear.
  for (let c = 0; c < 110; c++) {
    const cx = rnd() * size, cy = rnd() * size, rad = 3 + rnd() ** 3 * 34
    const reach = Math.ceil(rad * 1.5)
    for (let y = -reach; y <= reach; y++) for (let x = -reach; x <= reach; x++) {
      const d = Math.hypot(x, y) / rad
      if (d >= 1.5) continue
      const v = d < 1 ? 0.3 - (1 - d * d) ** 2 : 0.3 * Math.cos(((d - 1) / 0.5) * (Math.PI / 2)) ** 2
      const px = ((Math.round(cx + x) % size) + size) % size, py = ((Math.round(cy + y) % size) + size) % size
      hgt[py * size + px] += v * rad * 0.032
    }
  }
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const at = (xx, yy) => hgt[((yy + size) % size) * size + ((xx + size) % size)]
    const dx = at(x + 1, y) - at(x - 1, y), dy = at(x, y + 1) - at(x, y - 1)
    const l = Math.hypot(dx, dy, 1), i = (y * size + x) * 4
    data[i] = (-dx / l * 0.5 + 0.5) * 255; data[i + 1] = (dy / l * 0.5 + 0.5) * 255; data[i + 2] = (1 / l * 0.5 + 0.5) * 255; data[i + 3] = 255
  }
  const tex = new THREE.DataTexture(data, size, size)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(1, 1) // world-space UVs keep terrain and local detail at identical texel scale
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

function textSprite(txt) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64
  const g = c.getContext('2d'); g.font = '600 40px system-ui'; g.fillStyle = '#c9d3e0'; g.textAlign = 'center'
  g.fillText(txt, 64, 46)
  // Fixed on-screen size so far-side labels stay readable.
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false }))
  s.scale.set(0.06, 0.03, 1)
  return s
}

export function createScene(el, { onPick, onHover }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  el.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)
  let patchHalf = 40000, siteDem = null, siteH0 = 0
  const camera = new THREE.PerspectiveCamera(45, 1, 10, SKY * 3)
  camera.position.set(-18000, 9000, 18000)
  const controls = new OrbitControls(camera, renderer.domElement)
  const ORBIT = { maxPolarAngle: Math.PI / 2 - 0.02, minPolarAngle: 0, minDistance: 500, maxDistance: patchHalf * 1.1, enableZoom: true, enablePan: true, rotateSpeed: 1 }
  Object.assign(controls, ORBIT)

  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.15
  // Soft lunar earthshine fill so crater bowls & shadow transitions show clear 3D detail.
  scene.add(new THREE.HemisphereLight(0xc2cde0, 0x2d2b28, 0.45))
  const fill = new THREE.DirectionalLight(0xaec0dc, 0.48)
  fill.position.copy(dirOf(315, 35)).multiplyScalar(1000)
  scene.add(fill)
  const sun = new THREE.DirectionalLight(0xffffff, 3)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  Object.assign(sun.shadow.camera, { left: -patchHalf * 1.5, right: patchHalf * 1.5, top: patchHalf * 1.5, bottom: -patchHalf * 1.5, near: 1, far: 250000 })
  sun.shadow.bias = -0.0006
  sun.shadow.normalBias = 12
  scene.add(sun, sun.target)

  const sky = new THREE.Group(); scene.add(sky)
  const starPos = new Float32Array(3000 * 3)
  for (let i = 0; i < 3000; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(SKY * 1.2)
    starPos.set([v.x, v.y, v.z], i * 3)
  }
  const starGeo = new THREE.BufferGeometry(); starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
  sky.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.2, sizeAttenuation: false })))
  // Orbit view draws the discs ~4× real size so they read; surface view uses ~1.5×.
  // Real-looking Earth (phase, rotation, true angular size) and Sun (limb darkening + corona).
  // Orbit view draws them 3× larger so they read; surface view is true size (scroll to zoom).
  const earthBody = makeEarth(), sunBody = makeSun()
  const BODY_K = { orbit: 3, surface: 1 }
  sky.add(sunBody.mesh, earthBody.mesh)
  let skyState = null

  // True skyline from the full 150 km horizon, shown in surface view only.
  const skyline = new THREE.Group(); skyline.visible = false; sky.add(skyline)

  const compass = new THREE.Group(); scene.add(compass)
  const compassItems = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([t, az]) => {
    const s = textSprite(t), d = dirOf(az, 0)
    s.position.set(d.x * patchHalf * 0.7, 1500, d.z * patchHalf * 0.7)
    compass.add(s)
    return { s, d }
  })

  const marker = new THREE.Mesh(new THREE.CylinderGeometry(60, 60, 600, 12), new THREE.MeshBasicMaterial({ color: 0xff5a36 }))
  marker.position.y = 300
  scene.add(marker)

  const lander = makeLanderModel()
  lander.flame.visible = false
  lander.group.rotation.x = -Math.PI / 2
  lander.group.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true } })
  const placeLanderOrbit = () => {
    const k = patchHalf / 40000
    lander.group.scale.setScalar(45 * k)
    lander.group.position.set(0, 22 * k, 0)
    lander.group.rotation.set(-Math.PI / 2, 0, 0)
  }
  placeLanderOrbit()
  scene.add(lander.group)

  const engineLight = new THREE.PointLight(0xffb454, 0, 1600, 0.65)
  const landerLight = new THREE.PointLight(0xffe6b8, 0, 2200, 0.55)
  const landerSpot = new THREE.SpotLight(0xfff0d0, 0, 3200, Math.PI * 0.38, 0.55, 0.55)
  landerSpot.target.position.set(0, 0, 0)
  scene.add(engineLight, landerLight, landerSpot, landerSpot.target)
  const J2000_MS = Date.UTC(2000, 0, 1, 12)
  let skySpin = null

  const dustGroup = new THREE.Group()
  const dustGeo = new THREE.SphereGeometry(1, 8, 6)
  const dustPuffs = Array.from({ length: 16 }, () => {
    const mat = new THREE.MeshBasicMaterial({ color: 0xc2bcb2, transparent: true, opacity: 0, depthWrite: false })
    const m = new THREE.Mesh(dustGeo, mat)
    dustGroup.add(m)
    return { m, mat }
  })
  dustGroup.visible = false
  scene.add(dustGroup)

  const descentGeo = new THREE.BufferGeometry()
  const descentMat = new THREE.LineBasicMaterial({ color: 0xff8c42, transparent: true, opacity: 0.6 })
  const descentLine = new THREE.Line(descentGeo, descentMat)
  descentLine.visible = false
  descentLine.frustumCulled = false
  scene.add(descentLine)

  let flightState = null
  function rebuildDescentArc() {
    if (!site) return
    const k = patchHalf / 40000, pts = []
    for (let i = 0; i <= 40; i++) {
      const u = i / 40, gx = (1 - u) * 12000 * k, gz = (1 - u) * -3500 * k
      const gy = (terrain ? groundAt(gx, gz) : 0) + 0.04 * 1000 + (1 - u) ** 2 * 18000 * k
      pts.push(new THREE.Vector3(gx, u === 1 ? (terrain ? groundAt(0, 0) : 0) + 1 : gy, gz))
    }
    descentLine.geometry.setFromPoints(pts)
  }

  function updateMarkerScale() {
    const k = patchHalf / 40000
    const y0 = terrain ? groundAt(0, 0) : 0
    const camTargetDist = camera.position.distanceTo(controls.target)
    if (mode !== 'orbit' || flightState) {
      marker.visible = false
      return
    }
    marker.visible = true
    const mK = Math.min(k, Math.max(0.06, camTargetDist / 16000))
    marker.scale.setScalar(mK)
    marker.position.y = y0 + 300 * mK
  }

  function applyFlight(tSec) {
    const k = patchHalf / 40000
    const gy0 = terrain ? groundAt(0, 0) : 0
    const isDark = !skyState || (skyState.sunVis ?? 1) < 0.5 || (skyState.sunEl ?? 10) <= 0.8
    updateMarkerScale()
    if (!flightState) {
      lander.group.visible = true
      lander.flame.visible = false
      engineLight.intensity = 0
      dustGroup.visible = false
      descentLine.visible = false
      if (mode === 'surface') {
        lander.group.scale.setScalar(3.2)
        lander.group.position.set(0, gy0 + 1.65, 0)
        lander.group.rotation.set(-Math.PI / 2, 0, 0)
      } else {
        placeLanderOrbit()
      }
      const lp = lander.group.position, s = lander.group.scale.x
      lander.nightBeam.visible = isDark
      lander.nightBeam.scale.set(0.75, 0.25, 0.75)
      landerLight.position.set(lp.x, lp.y + 1.2 * s, lp.z)
      landerLight.distance = Math.max(450, 180 * s)
      landerLight.intensity = isDark ? 36 : 0
      landerSpot.position.set(lp.x, lp.y + 2.4 * s, lp.z)
      landerSpot.target.position.set(lp.x, gy0, lp.z)
      landerSpot.target.updateMatrixWorld()
      landerSpot.distance = Math.max(900, 320 * s)
      landerSpot.intensity = isDark ? 65 : 0
      return
    }
    if (flightState.phase === 'landed') {
      lander.group.visible = true
      lander.flame.visible = false
      engineLight.intensity = 0
      dustGroup.visible = false
      descentLine.visible = false
      const s = mode === 'surface' ? 3.2 : Math.max(10 * k, Math.min(55 * k, camera.position.length() * 0.022))
      lander.group.scale.setScalar(s)
      lander.group.position.set(0, gy0 + 0.52 * s, 0)
      lander.group.rotation.set(-Math.PI / 2, 0, 0)
      lander.nightBeam.visible = isDark
      lander.nightBeam.scale.set(0.75, 0.25, 0.75)
      landerLight.position.set(0, gy0 + 1.72 * s, 0)
      landerLight.distance = Math.max(450, 180 * s)
      landerLight.intensity = isDark ? 36 : 0
      landerSpot.position.set(0, gy0 + 2.92 * s, 0)
      landerSpot.target.position.set(0, gy0, 0)
      landerSpot.target.updateMatrixWorld()
      landerSpot.distance = Math.max(900, 320 * s)
      landerSpot.intensity = isDark ? 65 : 0
      return
    }
    if (flightState.phase !== 'descent') {
      lander.group.visible = false
      lander.flame.visible = false
      lander.nightBeam.visible = false
      engineLight.intensity = 0
      landerLight.intensity = 0
      landerSpot.intensity = 0
      dustGroup.visible = false
      descentLine.visible = false
      return
    }
    const rawAltM = (flightState.alt ?? 0) * 1000
    const inFinal = (flightState.rem ?? 99) <= 10.2
    const altM = inFinal ? rawAltM : 260 + Math.min(340, (rawAltM - 260) * 0.005)
    const gy = gy0
    if (mode === 'orbit' && inFinal) controls.target.y = gy + Math.min(85 * k, altM * 0.34) + 12 * k
    const camDist = camera.position.distanceTo(new THREE.Vector3(0, gy + altM, 0))
    const s = mode === 'surface' ? 3.2 : Math.max(10 * k, Math.min(48 * k, camDist * 0.025))
    lander.group.visible = true
    lander.group.scale.setScalar(s)
    lander.group.position.set(0, gy + altM + 0.52 * s, 0)
    lander.group.rotation.set(-Math.PI / 2, 0, 0)

    lander.flame.visible = true
    const flicker = 0.9 + 0.35 * Math.sin(tSec * 37)
    const fW = mode === 'surface' ? 1 : 1.25
    lander.flame.scale.set(fW, fW, flicker * (mode === 'surface' ? 1 : 1.35))
    engineLight.position.set(0, gy + Math.max(6, altM * 0.4), 0)
    const groundLit = isDark && altM < 280
    engineLight.distance = Math.max(1200, 360 * s + altM * 1.4)
    engineLight.intensity = groundLit ? 88 + 14 * Math.sin(tSec * 29) : 0
    const lp = lander.group.position
    lander.nightBeam.visible = groundLit
    const beamLen = Math.max(0.35, Math.min(2.8, altM / (5.5 * s || 1)))
    lander.nightBeam.scale.set(1, beamLen, 1)
    landerLight.position.set(0, lp.y + 1.2 * s, 0)
    landerLight.distance = Math.max(600, 220 * s)
    landerLight.intensity = groundLit ? 42 : 0
    landerSpot.position.set(0, lp.y + 0.5 * s, 0)
    landerSpot.target.position.set(0, gy, 0)
    landerSpot.target.updateMatrixWorld()
    landerSpot.distance = Math.max(1600, altM * 2.2 + 400 * s)
    landerSpot.intensity = groundLit ? 92 : 0
    descentLine.visible = false

    const dustStrength = Math.max(0, 1 - altM / 80)
    dustGroup.visible = dustStrength > 0.01
    if (dustGroup.visible) {
      const span = mode === 'surface' ? 1 : Math.max(1.2, s * 0.32)
      dustGroup.position.set(0, gy + 0.5, 0)
      dustPuffs.forEach((p, idx) => {
        const cyc = (tSec * 0.85 + idx / dustPuffs.length) % 1
        const ang = (idx / dustPuffs.length) * Math.PI * 2 + cyc * 0.4
        const rad = (1.8 + cyc * 22) * span
        const sz = (1.4 + cyc * 4.2) * span
        p.m.position.set(Math.cos(ang) * rad, cyc * 3.8 * span, Math.sin(ang) * rad)
        p.m.scale.setScalar(sz)
        p.mat.opacity = dustStrength * (1 - cyc) * 0.55
      })
    }
  }

  const NORM_TILE_M = 900
  const normTex = regolithNormalMap()
  normTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  const matLit = new THREE.MeshStandardMaterial({ color: 0xa7a49d, vertexColors: true, roughness: 1, metalness: 0, normalMap: normTex, normalScale: new THREE.Vector2(0.55, 0.55) })
  // Orbit view exaggerates relief 2× so 80 km of terrain doesn't look flat; surface view is true scale.
  const RELIEF = { orbit: 2, surface: 1 }
  const matFlat = new THREE.MeshBasicMaterial({ vertexColors: true })
  let terrain = null, localMesh = null, site = null, fade = null, shade = null, overlay = null, layer = 'normal', mode = 'orbit'
  let savedOrbit = null
  const landingDetail = new THREE.Group()
  scene.add(landingDetail)
  const localFade = [], localShade = []
  const boulders = []

  const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }
  const hash2 = (ix, iy) => {
    const h = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453123
    return h - Math.floor(h)
  }
  const vnoise2 = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
    const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
  }
  // Rotated multi-octave isotropic noise so close-up micro-relief has no axis-aligned sine stripes.
  function fbm2(e, n) {
    const c1 = 0.8, s1 = 0.6, e1 = (e * c1 - n * s1) / 58, n1 = (e * s1 + n * c1) / 58
    const c2 = -0.35, s2 = 0.9367, e2 = (e * c2 - n * s2) / 24, n2 = (e * s2 + n * c2) / 24
    const c3 = 0.54, s3 = -0.8417, e3 = (e * c3 - n * s3) / 11, n3 = (e * s3 + n * c3) / 11
    return (vnoise2(e1, n1) - 0.5) * 1.4 + (vnoise2(e2 + 19.3, n2 - 7.1) - 0.5) * 0.65 + (vnoise2(e3 - 11.7, n3 + 23.4) - 0.5) * 0.25
  }

  function buildSkyline(hz) {
    skyline.clear()
    const n = hz.length, pos = new Float32Array((n + 1) * 6), top = new Float32Array((n + 1) * 3)
    for (let k = 0; k <= n; k++) {
      const az = (k % n) * 360 / n
      const a = dirOf(az, hz[k % n]).multiplyScalar(SKYLINE), b = dirOf(az, -25).multiplyScalar(SKYLINE)
      pos.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6); top.set([a.x, a.y, a.z], k * 3)
    }
    const idx = []
    for (let k = 0; k < n; k++) { const i = k * 2; idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2) }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx)
    skyline.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x1c1b19, side: THREE.DoubleSide })))
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(top, 3))
    skyline.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xb9b4a8 })))
  }

  function buildLandingDetail(dem, s, h0, half, localHalf, localSeg, terrainPatchAt) {
    landingDetail.clear(); localFade.length = 0; localShade.length = 0; boulders.length = 0
    if (localMesh) { localMesh.geometry.dispose(); localMesh = null }

    const geo = new THREE.PlaneGeometry(localHalf * 2, localHalf * 2, localSeg, localSeg).rotateX(-Math.PI / 2)
    const p = geo.attributes.position, uv = geo.attributes.uv

    // Deterministic C1 lunar craters & isotropic micro-relief (flat pad inside r < 22 m, seamless border merge)
    let rs = 1337
    const rnd = () => ((rs = (rs * 16807) % 2147483647) / 2147483647)
    const maxCraterR = localHalf * 0.56
    const craters = Array.from({ length: 22 }, () => {
      const ang = rnd() * Math.PI * 2
      const rad = 16 + rnd() ** 1.4 * 46
      const dist = 56 + Math.sqrt(rnd()) * Math.max(40, maxCraterR - rad - 56)
      return { x: Math.cos(ang) * dist, z: Math.sin(ang) * dist, rad, depth: rad * 0.14 }
    })

    const detailOffset = (e, n) => {
      const r = Math.hypot(e, n)
      const boxMax = Math.max(Math.abs(e), Math.abs(n))
      const mask = smoothstep(22, 42, r) * (1 - smoothstep(localHalf * 0.58, localHalf * 0.78, boxMax))
      if (mask <= 0) return 0
      let dh = fbm2(e, n) * mask
      for (const c of craters) {
        const u = Math.hypot(e - c.x, -n - c.z) / c.rad
        if (u < 1.0) dh += c.depth * (0.28 - (1 - u * u) ** 2) * mask
        else if (u < 1.5) dh += c.depth * 0.28 * Math.cos(((u - 1.0) / 0.5) * (Math.PI / 2)) ** 2 * mask
      }
      return dh
    }

    const edgeBlend = new Float32Array(p.count)
    const edgePatches = new Array(p.count)
    for (let i = 0; i < p.count; i++) {
      const e = p.getX(i), z = p.getZ(i), n = -z, r = Math.hypot(e, n)
      uv.setXY(i, e / NORM_TILE_M, n / NORM_TILE_M)
      let base = -(e * e + n * n) / (2 * R)
      if (dem) {
        const [lat, lon] = offsetLL(s.lat, s.lon, e, n)
        const h = dem.height(lat, lon)
        base += (Number.isNaN(h) ? h0 : h) - h0
      }
      const rawY = base + detailOffset(e, n)
      const bt = smoothstep(localHalf * 0.68, localHalf * 0.99, Math.max(Math.abs(e), Math.abs(n)))
      edgeBlend[i] = bt
      if (bt > 0) {
        const tp = terrainPatchAt(e, z)
        edgePatches[i] = tp
        p.setY(i, rawY + (tp.y - rawY) * bt)
      } else {
        p.setY(i, rawY)
      }
      const ft = Math.min(1, Math.max(0, (half - r) / (0.35 * half)))
      localFade[i] = ft * ft * (3 - 2 * ft)
    }
    uv.needsUpdate = true
    geo.computeVertexNormals()
    const nrm = geo.attributes.normal, L = dirOf(315, 45)
    for (let i = 0; i < p.count; i++) {
      const bt = edgeBlend[i]
      if (bt > 0) {
        const tp = edgePatches[i]
        const nx = nrm.getX(i) * (1 - bt) + tp.nx * bt
        const ny = nrm.getY(i) * (1 - bt) + tp.ny * bt
        const nz = nrm.getZ(i) * (1 - bt) + tp.nz * bt
        const nl = Math.hypot(nx, ny, nz) || 1
        nrm.setXYZ(i, nx / nl, ny / nl, nz / nl)
      }
      localShade[i] = 0.35 + 0.65 * Math.max(0, nrm.getX(i) * L.x + nrm.getY(i) * L.y + nrm.getZ(i) * L.z)
    }
    nrm.needsUpdate = true
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(p.count * 3), 3))

    localMesh = new THREE.Mesh(geo, matLit)
    localMesh.scale.y = RELIEF[mode]
    localMesh.castShadow = false
    localMesh.receiveShadow = true
    landingDetail.add(localMesh)

    // Scatter deterministic faceted lunar boulders inside the unblended inner zone
    const rockGeo = new THREE.DodecahedronGeometry(1, 0)
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x8d8a83, roughness: 0.96, metalness: 0.04 })
    const maxRockR = Math.min(340, localHalf * 0.56)
    for (let b = 0; b < 48; b++) {
      const ang = rnd() * Math.PI * 2, r = 28 + Math.pow(rnd(), 0.75) * Math.max(40, maxRockR - 28)
      const bx = Math.cos(ang) * r, bz = Math.sin(ang) * r
      let by = -(bx * bx + bz * bz) / (2 * R)
      if (dem) {
        const [lat, lon] = offsetLL(s.lat, s.lon, bx, -bz)
        const h = dem.height(lat, lon)
        by += (Number.isNaN(h) ? h0 : h) - h0
      }
      by += detailOffset(bx, -bz)
      const sz = 0.55 + Math.pow(rnd(), 1.8) * 3.1
      const m = new THREE.Mesh(rockGeo, rockMat)
      m.scale.set(sz * (0.8 + rnd() * 0.7), sz * (0.45 + rnd() * 0.5), sz * (0.75 + rnd() * 0.65))
      m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3)
      m.userData.baseY = by
      m.position.set(bx, by * RELIEF[mode] - 0.15 * m.scale.y, bz)
      m.castShadow = m.receiveShadow = true
      boulders.push(m)
      landingDetail.add(m)
    }
  }

  function setSite(s, dem, hz) {
    site = s; overlay = null
    if (terrain) { scene.remove(terrain); terrain.geometry.dispose() }
    const hasDem = !!(dem && dem.covers(s.lat, s.lon))
    siteDem = hasDem ? dem : null
    const half = hasDem && dem.kind === 'cyl' ? 120000 : 40000
    const rawSeg = hasDem ? (dem.kind === 'cyl' ? 320 : Math.round((2 * half) / dem.res)) : 128
    const seg = rawSeg + (rawSeg % 2)

    if (half !== patchHalf) {
      const k = half / patchHalf
      patchHalf = half
      ORBIT.maxDistance = half * 1.1
      ORBIT.minDistance = half > 60000 ? 1500 : 500
      Object.assign(sun.shadow.camera, { left: -half * 1.5, right: half * 1.5, top: half * 1.5, bottom: -half * 1.5, near: 1, far: Math.max(250000, half * 5) })
      sun.shadow.camera.updateProjectionMatrix()
      sun.shadow.normalBias = half > 60000 ? 36 : 12
      for (const c of compassItems) c.s.position.set(c.d.x * half * 0.7, 1500 * (half / 40000), c.d.z * half * 0.7)
      marker.scale.setScalar(half / 40000)
      marker.position.y = 300 * (half / 40000)
      if (mode === 'orbit') {
        Object.assign(controls, ORBIT)
        camera.position.sub(controls.target).multiplyScalar(k).add(controls.target)
        controls.update()
      } else if (savedOrbit) {
        savedOrbit.pos.sub(savedOrbit.target).multiplyScalar(k).add(savedOrbit.target)
      }
    }

    const geo = new THREE.PlaneGeometry(half * 2, half * 2, seg, seg).rotateX(-Math.PI / 2)
    const p = geo.attributes.position, uv = geo.attributes.uv
    let h0 = 0
    if (hasDem) {
      const hRaw = dem.height(s.lat, s.lon)
      h0 = Number.isFinite(hRaw) ? hRaw : 0
      siteH0 = h0
      for (let i = 0; i < p.count; i++) {
        const e = p.getX(i), n = -p.getZ(i)
        uv.setXY(i, e / NORM_TILE_M, n / NORM_TILE_M)
        const [lat, lon] = offsetLL(s.lat, s.lon, e, n)
        const h = dem.height(lat, lon)
        p.setY(i, (Number.isNaN(h) ? h0 : h) - h0 - (e * e + n * n) / (2 * R))
      }
    } else {
      siteH0 = 0
      for (let i = 0; i < p.count; i++) {
        const e = p.getX(i), n = -p.getZ(i)
        uv.setXY(i, e / NORM_TILE_M, n / NORM_TILE_M)
        p.setY(i, -(e * e + n * n) / (2 * R))
      }
    }
    uv.needsUpdate = true
    geo.computeVertexNormals()
    // Radial fade over the outer 35% → the patch reads as a disc dissolving into space.
    // Hillshade (fixed light from the north-west) keeps relief readable under overlay colours.
    fade = new Float32Array(p.count); shade = new Float32Array(p.count)
    const nrm = geo.attributes.normal, L = dirOf(315, 45)
    for (let i = 0; i < p.count; i++) {
      const t = Math.min(1, Math.max(0, (half - Math.hypot(p.getX(i), p.getZ(i))) / (0.35 * half)))
      fade[i] = t * t * (3 - 2 * t)
      shade[i] = 0.35 + 0.65 * Math.max(0, nrm.getX(i) * L.x + nrm.getY(i) * L.y + nrm.getZ(i) * L.z)
    }

    // Punch a square central opening in terrain's index buffer after normals are computed, so localMesh
    // stitches flush to terrain's edges with zero overlap, zero sunken bowl, and matching boundary normals.
    const dx = (2 * half) / seg, stride = seg + 1, cIdx = seg / 2
    const m = Math.max(1, Math.min(Math.floor(seg / 4), Math.round(750 / dx)))
    const K = Math.min(64, Math.max(8, Math.round(dx / 12)))
    const localHalf = m * dx, localSeg = 2 * m * K
    const srcIdx = geo.index.array, kept = []
    for (let tri = 0; tri < srcIdx.length; tri += 6) {
      const cell = tri / 6, ix = cell % seg, iy = Math.floor(cell / seg)
      if (ix >= cIdx - m && ix < cIdx + m && iy >= cIdx - m && iy < cIdx + m) continue
      kept.push(srcIdx[tri], srcIdx[tri + 1], srcIdx[tri + 2], srcIdx[tri + 3], srcIdx[tri + 4], srcIdx[tri + 5])
    }
    geo.setIndex(kept)

    const terrainPatchAt = (x, z) => {
      const fx = (x + half) / dx, fz = (z + half) / dx
      const vx = Math.min(cIdx + m - 1, Math.max(cIdx - m, Math.floor(fx)))
      const vz = Math.min(cIdx + m - 1, Math.max(cIdx - m, Math.floor(fz)))
      const u = fx - vx, v = fz - vz
      const ia = vz * stride + vx, ib = (vz + 1) * stride + vx, id = ia + 1, ic = ib + 1
      let y
      if (u + v <= 1) {
        const ya = p.getY(ia)
        y = ya + u * (p.getY(id) - ya) + v * (p.getY(ib) - ya)
      } else {
        const yc = p.getY(ic)
        y = yc + (1 - u) * (p.getY(ib) - yc) + (1 - v) * (p.getY(id) - yc)
      }
      const nx = (1 - u) * (1 - v) * nrm.getX(ia) + u * (1 - v) * nrm.getX(id) + (1 - u) * v * nrm.getX(ib) + u * v * nrm.getX(ic)
      const ny = (1 - u) * (1 - v) * nrm.getY(ia) + u * (1 - v) * nrm.getY(id) + (1 - u) * v * nrm.getY(ib) + u * v * nrm.getY(ic)
      const nz = (1 - u) * (1 - v) * nrm.getZ(ia) + u * (1 - v) * nrm.getZ(id) + (1 - u) * v * nrm.getZ(ib) + u * v * nrm.getZ(ic)
      const nl = Math.hypot(nx, ny, nz) || 1
      return { y, nx: nx / nl, ny: ny / nl, nz: nz / nl }
    }

    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(p.count * 3), 3))
    terrain = new THREE.Mesh(geo, matLit)
    terrain.scale.y = RELIEF[mode]
    terrain.castShadow = terrain.receiveShadow = true
    matLit.color.set(hasDem ? 0xa7a49d : 0x6d6b66)
    scene.add(terrain)
    buildLandingDetail(siteDem, s, h0, half, localHalf, localSeg, terrainPatchAt)
    paint()
    buildSkyline(hz)
    if (mode === 'surface') enterSurface()
    else placeLanderOrbit()
    rebuildDescentArc()
    applyFlight(performance.now() / 1000)
    return hasDem
  }

  function sample(arr, x, z) {
    const { n, spacing } = overlay, c = (n - 1) / 2
    const fi = Math.min(n - 1.001, Math.max(0, x / spacing + c)), fj = Math.min(n - 1.001, Math.max(0, -z / spacing + c))
    const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j, k = j * n + i
    return arr[k] * (1 - a) * (1 - b) + arr[k + 1] * a * (1 - b) + arr[k + n] * (1 - a) * b + arr[k + n + 1] * a * b
  }

  // Normal view: grey + fade under real sunlight. Overlay: unlit ramp × hillshade × fade.
  function paintMesh(mesh, fArr, sArr, tmp, on) {
    if (!mesh) return
    const p = mesh.geometry.attributes.position, col = mesh.geometry.attributes.color
    for (let i = 0; i < p.count; i++) {
      if (!on) { col.setXYZ(i, fArr[i], fArr[i], fArr[i]); continue }
      const [r, g, b] = ramp(RAMPS[layer], sample(overlay[layer], p.getX(i), p.getZ(i)))
      const k = sArr[i] * fArr[i]
      tmp.setRGB(r * k, g * k, b * k, THREE.SRGBColorSpace)
      col.setXYZ(i, tmp.r, tmp.g, tmp.b)
    }
    col.needsUpdate = true
    mesh.material = on ? matFlat : matLit
  }

  function paint() {
    if (!terrain) return
    const tmp = new THREE.Color(), on = layer !== 'normal' && overlay
    paintMesh(terrain, fade, shade, tmp, on)
    paintMesh(localMesh, localFade, localShade, tmp, on)
  }

  const setOverlay = (o) => { overlay = o; paint() }
  const setLayer = (l) => { layer = l; paint() }

  function setSky(state) {
    skyState = state
    const sd = dirOf(state.sunAz, state.sunEl), k = BODY_K[mode]
    const lightEl = state.sunEl > -0.5 ? Math.max(state.sunEl, 2) : state.sunEl
    sun.position.copy(dirOf(state.sunAz, lightEl)).multiplyScalar(Math.max(100000, patchHalf * 2.5))
    sun.intensity = state.sunEl > -0.3 ? 3 : 0
    skySpin = state.t != null ? ((state.t - J2000_MS) / 86400e3) * ((2 * Math.PI) / 25.38) : null
    // Dimmed when the far terrain (up to 150 km) hides it from the landing site.
    sunBody.update({ dir: sd, dist: SKY * 0.99, pose: state.pose, k, dim: state.sunVis > 0 ? 1 : 0.35, camera, spin: skySpin ?? undefined })
    earthBody.update({ dir: dirOf(state.earthAz, state.earthEl), dist: SKY * 0.95, pose: state.pose, sunDir: sd, k, dim: state.earthVis ? 1 : 0.4 })
    marker.material.color.set(state.sunVis > 0.5 ? 0xffcf4a : 0xff5a36)
    applyFlight(performance.now() / 1000)
  }

  // ---------- surface view ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2()
  let eye = new THREE.Vector3(0, 10, 0)

  function groundAt(x, z) {
    if (!site) return 0
    if (x === 0 && z === 0) return 0
    const drop = (x * x + z * z) / (2 * R)
    if (!siteDem) return -drop * RELIEF[mode]
    const [lat, lon] = offsetLL(site.lat, site.lon, x, -z)
    const h = siteDem.height(lat, lon)
    return ((Number.isFinite(h) ? h - siteH0 : 0) - drop) * RELIEF[mode]
  }

  function lookDir(dir) {
    controls.target.copy(eye).addScaledVector(dir, 0.5)
    camera.position.copy(eye).addScaledVector(dir, -0.5)
    controls.update()
  }

  function enterSurface() {
    const yLander = groundAt(0, 0) + 1.65
    lander.group.scale.setScalar(3.2)
    lander.group.position.set(0, yLander, 0)
    eye = new THREE.Vector3(0, groundAt(0, 12) + 2.6, 12)
    Object.assign(controls, { minDistance: 1, maxDistance: 1, minPolarAngle: 0.05, maxPolarAngle: Math.PI - 0.05, enableZoom: false, enablePan: false, rotateSpeed: -0.35 })
    camera.near = 0.5; setFov(60)
    lookDir(new THREE.Vector3(0, yLander + 0.4 - eye.y, -12).normalize())
  }

  // Surface view zooms like a telescope (narrower field of view), so Earth's phase and the
  // Sun's limb are visible at their true angular sizes.
  function setFov(f) {
    camera.fov = Math.max(1.5, Math.min(70, f))
    camera.updateProjectionMatrix()
    if (mode === 'surface') controls.rotateSpeed = -0.35 * camera.fov / 60
  }
  renderer.domElement.addEventListener('wheel', (e) => {
    if (mode !== 'surface') return
    e.preventDefault()
    setFov(camera.fov * Math.exp(e.deltaY * 0.0012))
  }, { passive: false })

  function setMode(m) {
    if (m === mode) return
    mode = m
    const surf = m === 'surface'
    skyline.visible = surf; marker.visible = !surf
    if (terrain) terrain.scale.y = RELIEF[m]
    if (localMesh) localMesh.scale.y = RELIEF[m]
    for (const b of boulders) b.position.y = b.userData.baseY * RELIEF[m] - 0.15 * b.scale.y
    if (surf) {
      savedOrbit = { pos: camera.position.clone(), target: controls.target.clone() }
      enterSurface()
    } else {
      Object.assign(controls, ORBIT)
      camera.near = 10; setFov(45)
      placeLanderOrbit()
      camera.position.copy(savedOrbit.pos); controls.target.copy(savedOrbit.target); controls.update()
    }
    rebuildDescentArc()
    applyFlight(performance.now() / 1000)
    if (skyState) setSky(skyState) // re-size Earth/Sun for the new mode
  }

  function setFlight(s) {
    if (!s && !flightState) return
    flightState = s
    if (!s && mode === 'orbit') controls.minDistance = ORBIT.minDistance
    applyFlight(performance.now() / 1000)
  }

  function focusLanding() {
    if (mode !== 'orbit') setMode('orbit')
    const k = patchHalf / 40000, y0 = terrain ? groundAt(0, 0) : 0
    controls.minDistance = Math.min(controls.minDistance, 140 * k)
    camera.position.set(-340 * k, y0 + 145 * k, 420 * k)
    controls.target.set(0, y0 + 42 * k, 0)
    controls.update()
    applyFlight(performance.now() / 1000)
  }

  function focusLapse() {
    if (mode !== 'orbit') setMode('orbit')
    const k = patchHalf / 40000, y0 = terrain ? groundAt(0, 0) : 0
    controls.minDistance = Math.min(controls.minDistance, 140 * k)
    camera.position.set(-7200 * k, y0 + 4400 * k, 7200 * k)
    controls.target.set(0, y0, 0)
    controls.update()
    applyFlight(performance.now() / 1000)
  }

  function resetCamera() {
    if (mode !== 'orbit') setMode('orbit')
    const k = patchHalf / 40000, y0 = terrain ? groundAt(0, 0) : 0
    Object.assign(controls, ORBIT, { maxDistance: patchHalf * 1.1 })
    setFov(45)
    camera.position.set(-18000 * k, y0 + 9000 * k, 18000 * k)
    controls.target.set(0, y0, 0)
    controls.update()
    applyFlight(performance.now() / 1000)
  }

  // Aim at a body and zoom so it fills a good part of the view (fov in degrees).
  const lookAt = (az, el, fov) => {
    if (mode !== 'surface') return
    lookDir(dirOf(az, el))
    if (fov) setFov(fov)
  }

  // ---------- picking ----------
  function hitGround(ev) {
    const r = renderer.domElement.getBoundingClientRect()
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    const meshes = [localMesh, terrain].filter(Boolean)
    const hit = meshes.length ? ray.intersectObjects(meshes)[0] : null
    return hit && Math.hypot(hit.point.x, hit.point.z) < patchHalf * 0.9 ? hit.point : null
  }

  // Double-click the ground → new site at that spot ("what if we land 3 km east?").
  renderer.domElement.addEventListener('dblclick', (ev) => {
    if (!site || !siteDem || mode === 'surface') return
    const pt = hitGround(ev)
    if (!pt) return
    onPick(...offsetLL(site.lat, site.lon, pt.x, -pt.z))
  })

  // Hover readout of overlay values; throttled because raycasting 200k triangles is not free.
  let lastHover = 0
  renderer.domElement.addEventListener('pointermove', (ev) => {
    if (ev.buttons || mode === 'surface' || !overlay || layer === 'normal' || performance.now() - lastHover < 120) return
    lastHover = performance.now()
    const pt = hitGround(ev)
    onHover(pt && { km: Math.hypot(pt.x, pt.z) / 1000, lit: sample(overlay.lit, pt.x, pt.z), see: sample(overlay.see, pt.x, pt.z), both: sample(overlay.both, pt.x, pt.z) })
  })
  renderer.domElement.addEventListener('pointerleave', () => onHover(null))

  function resize() {
    const w = el.clientWidth, h = el.clientHeight
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(el)

  renderer.setAnimationLoop(() => {
    controls.update()
    if (flightState?.phase === 'descent') applyFlight(performance.now() / 1000)
    else updateMarkerScale()
    sky.position.copy(camera.position)
    if (sunBody.uniforms?.uTime) sunBody.uniforms.uTime.value = performance.now() * 0.001
    if (sunBody.uniforms?.uSpin) sunBody.uniforms.uSpin.value = skySpin ?? performance.now() * 0.00004
    if (skySpin === null) earthBody.mesh.rotateY(7.2921159e-5 / 60)
    sunBody.mesh.quaternion.copy(camera.quaternion) // keep the Sun disc facing the camera
    renderer.render(scene, camera)
  })

  return { setSite, setSky, setOverlay, setLayer, setMode, lookAt, setFlight, focusLanding, focusLapse, resetCamera }
}
