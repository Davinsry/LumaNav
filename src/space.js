// "Misi 3D": continuous Earth ground-pad liftoff → staging → cislunar coast → real LOLA Moon landing.
// Units: 1 scene unit = 1,000 km (1 m = 1e-6). Frame: J2000 equatorial mapped to three.js as (x, z, -y).
// Floating origin keeps the tracked target near (0,0,0) in Float32 so meter-scale pads & regolith stay sharp.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import * as A from 'astronomy-engine'
import { makeEarth, makeLanderModel, makeSun, orientSphere } from './bodies.js'
import { moonAxes } from './astro.js'
import { offsetLL } from './dem.js'
import { craftPosition, padVec } from './mission.js'

const U = 1 / 1000 // scene units per km
const AU_KM = 149597870.7
const AU_U = AU_KM * U
const J2000_MS = Date.UTC(2000, 0, 1, 12)
const R_EARTH = 6378.137, R_MOON = 1737.4
const M_TO_U = 1e-6 // 1 m in scene units
const PAD_H_U = 5 * M_TO_U // launch mount table height above Earth ground

const toScene = (v, out = new THREE.Vector3()) => out.set(v[0] * U, v[2] * U, -v[1] * U)
const axis = (v, out = new THREE.Vector3()) => out.set(v[0], v[2], -v[1])
const axisArr = (v) => [v[0], v[2], -v[1]]
const dirFromLook = (dir, upRef = new THREE.Vector3(0, 1, 0)) => {
  const m = new THREE.Matrix4()
  const z = dir.clone().normalize()
  const alt = Math.abs(z.dot(upRef)) > 0.98
    ? (Math.abs(z.y) < 0.8 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1))
    : upRef
  const x = new THREE.Vector3().crossVectors(alt, z).normalize()
  const y = new THREE.Vector3().crossVectors(z, x).normalize()
  return new THREE.Quaternion().setFromRotationMatrix(m.makeBasis(x, y, z))
}

function label(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64
  const g = c.getContext('2d'); g.font = '600 30px system-ui'; g.fillStyle = '#dce3ec'; g.textAlign = 'center'
  g.shadowColor = '#000'; g.shadowBlur = 6; g.fillText(text, 128, 42)
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false }))
  s.scale.set(0.09, 0.0225, 1); s.center.set(0.5, -0.6); s.renderOrder = 10
  return s
}

function geoLabel(text) {
  const c = document.createElement('canvas'); c.width = 320; c.height = 56
  const g = c.getContext('2d'); g.font = '600 22px system-ui'; g.textAlign = 'center'
  g.strokeStyle = 'rgba(4, 10, 18, 0.88)'; g.lineWidth = 5; g.lineJoin = 'round'; g.strokeText(text, 160, 36)
  g.fillStyle = '#b4f0cf'; g.fillText(text, 160, 36)
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false, transparent: true, opacity: 0.92 }))
  s.scale.set(0.11, 0.01925, 1); s.center.set(0.5, 0.5); s.renderOrder = 8
  return s
}

function planetLabel(text, color = '#cfd9e6') {
  const c = document.createElement('canvas'); c.width = 256; c.height = 56
  const g = c.getContext('2d'); g.font = '600 24px system-ui'; g.textAlign = 'center'
  g.strokeStyle = 'rgba(0, 0, 0, 0.85)'; g.lineWidth = 5; g.lineJoin = 'round'; g.strokeText(text, 128, 36)
  g.fillStyle = color; g.fillText(text, 128, 36)
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false, transparent: true, opacity: 0.88 }))
  s.scale.set(0.085, 0.0186, 1); s.center.set(0.5, -0.5); s.renderOrder = 10
  return s
}

function dot(color) {
  const c = document.createElement('canvas'); c.width = c.height = 32
  const g = c.getContext('2d'); g.fillStyle = color; g.strokeStyle = '#fff'; g.lineWidth = 4
  g.beginPath(); g.arc(16, 16, 10, 0, 7); g.fill(); g.stroke()
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), sizeAttenuation: false, depthTest: false }))
  s.scale.set(0.007, 0.007, 1); s.renderOrder = 9
  return s
}

function padKind(pad) {
  const n = pad?.name || ''
  if (/Kennedy/i.test(n)) return 'ksc'
  if (/Baikonur/i.test(n)) return 'baikonur'
  if (/Kourou/i.test(n)) return 'kourou'
  if (/Sriharikota/i.test(n)) return 'sriharikota'
  if (/Wenchang/i.test(n)) return 'wenchang'
  return 'biak'
}

function flameCone(r, len, zOff, col = 0xff8c2b) {
  const f = new THREE.Group()
  const outer = new THREE.Mesh(
    new THREE.ConeGeometry(r, len, 14, 1, true),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.78, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  )
  outer.rotation.x = -Math.PI / 2; outer.position.z = zOff - len * 0.45; f.add(outer)
  const core = new THREE.Mesh(
    new THREE.ConeGeometry(r * 0.52, len * 0.65, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xfff5cc, transparent: true, opacity: 0.96, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  )
  core.rotation.x = -Math.PI / 2; core.position.z = zOff - len * 0.3; f.add(core)
  const shock = new THREE.Mesh(
    new THREE.ConeGeometry(r * 0.28, len * 0.40, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.98, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  )
  shock.rotation.x = -Math.PI / 2; shock.position.z = zOff - len * 0.18; f.add(shock)
  f.visible = false
  return f
}

// High-detail multi-stage & strap-on booster launch stack tailored to each spaceport's real launcher.
function makeLaunchStack() {
  const root = new THREE.Group()
  const coreMat = new THREE.MeshStandardMaterial({ color: 0xf0f3f7, metalness: 0.14, roughness: 0.42 })
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf3f6fa, metalness: 0.12, roughness: 0.40 })
  const liveryMat = new THREE.MeshStandardMaterial({ color: 0xd91e18, metalness: 0.18, roughness: 0.42 })
  const boosterMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f9, metalness: 0.14, roughness: 0.42 })
  const boosterBandMat = new THREE.MeshStandardMaterial({ color: 0xd91e18, metalness: 0.2, roughness: 0.45 })
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1d2229, metalness: 0.42, roughness: 0.5 })
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x707985, metalness: 0.62, roughness: 0.34, side: THREE.DoubleSide })
  const fairingInnerMat = new THREE.MeshStandardMaterial({ color: 0x383f49, metalness: 0.5, roughness: 0.55, side: THREE.BackSide })

  // Stage 1 core (z = 0..0.68)
  const stage1 = new THREE.Group()
  const core1 = new THREE.Mesh(new THREE.CylinderGeometry(0.106, 0.112, 0.60, 22), coreMat)
  core1.rotation.x = Math.PI / 2; core1.position.z = 0.35; stage1.add(core1)
  const skirt1 = new THREE.Mesh(new THREE.CylinderGeometry(0.112, 0.124, 0.08, 22), darkMat)
  skirt1.rotation.x = Math.PI / 2; skirt1.position.z = 0.05; stage1.add(skirt1)
  const bandLow = new THREE.Mesh(new THREE.CylinderGeometry(0.113, 0.114, 0.045, 22), liveryMat)
  bandLow.rotation.x = Math.PI / 2; bandLow.position.z = 0.14; stage1.add(bandLow)
  const bandHigh = new THREE.Mesh(new THREE.CylinderGeometry(0.109, 0.109, 0.06, 22), liveryMat)
  bandHigh.rotation.x = Math.PI / 2; bandHigh.position.z = 0.55; stage1.add(bandHigh)
  const interstage1 = new THREE.Mesh(new THREE.CylinderGeometry(0.106, 0.108, 0.065, 22), darkMat)
  interstage1.rotation.x = Math.PI / 2; interstage1.position.z = 0.648; stage1.add(interstage1)

  // External pressurization & avionics raceways along ±Y
  for (const sy of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.014, 0.52), whiteMat)
    pipe.position.set(0, sy * 0.112, 0.36); stage1.add(pipe)
  }

  // 4 grid fins near top, 4 lower aero strakes, and 9-nozzle octaweb cluster
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.085, 0.14), darkMat)
    fin.position.set(Math.cos(a) * 0.14, Math.sin(a) * 0.14, 0.095); fin.rotation.z = a + Math.PI / 2; stage1.add(fin)
    const gfin = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.06, 0.048), steelMat)
    gfin.position.set(Math.cos(a) * 0.128, Math.sin(a) * 0.128, 0.61); gfin.rotation.z = a + Math.PI / 2; stage1.add(gfin)
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const bell = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.065, 10, 1, true), steelMat)
    bell.rotation.x = -Math.PI / 2; bell.position.set(Math.cos(a) * 0.068, Math.sin(a) * 0.068, -0.005); stage1.add(bell)
  }
  const centerBell = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.072, 12, 1, true), steelMat)
  centerBell.rotation.x = -Math.PI / 2; centerBell.position.z = -0.006; stage1.add(centerBell)
  const flame1 = flameCone(0.125, 0.94, -0.01, 0xff9233)
  stage1.add(flame1)

  // 4 Strap-on side boosters (configured to 2 or 4 per pad)
  const boosters = [0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((a, idx) => {
    const bg = new THREE.Group()
    const ca = Math.cos(a), sa = Math.sin(a), baseR = 0.165
    bg.position.set(ca * baseR, sa * baseR, 0.02)

    const body = new THREE.Group()
    const bTank = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.048, 0.43, 14), boosterMat)
    bTank.rotation.x = Math.PI / 2; bTank.position.z = 0.255; body.add(bTank)
    const bSkirt = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.053, 0.05, 14), darkMat)
    bSkirt.rotation.x = Math.PI / 2; bSkirt.position.z = 0.04; body.add(bSkirt)
    const bBand = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.042, 14), boosterBandMat)
    bBand.rotation.x = Math.PI / 2; bBand.position.z = 0.40; body.add(bBand)
    const bShould = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.044, 0.075, 14), boosterMat)
    bShould.rotation.x = Math.PI / 2; bShould.position.z = 0.505; body.add(bShould)
    const bTip = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.068, 14), liveryMat)
    bTip.rotation.x = Math.PI / 2; bTip.position.z = 0.576; body.add(bTip)

    // Tapered Soyuz/Yenisei sleeve option
    const taper = new THREE.Mesh(new THREE.ConeGeometry(0.052, 0.44, 14), boosterMat)
    taper.rotation.x = Math.PI / 2; taper.position.z = 0.31; taper.visible = false; body.add(taper)

    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.018, 0.024), darkMat)
    strut.position.set(-ca * 0.045, -sa * 0.045, 0.42); strut.rotation.z = a; body.add(strut)

    const bBell = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.065, 12, 1, true), steelMat)
    bBell.rotation.x = -Math.PI / 2; bBell.position.z = -0.01; body.add(bBell)

    const bFlame = flameCone(0.050, 0.62, -0.02, 0xffa640)
    bg.add(body, bFlame)
    root.add(bg)
    return { group: bg, body, taper, flame: bFlame, ca, sa, baseR, isTwin: idx === 1 || idx === 3 }
  })

  // Stage 2 upper stage (nominal attached base z = 0.68..1.04)
  const stage2 = new THREE.Group()
  stage2.position.z = 0.68
  const inter = new THREE.Mesh(new THREE.CylinderGeometry(0.104, 0.106, 0.065, 22), darkMat)
  inter.rotation.x = Math.PI / 2; inter.position.z = 0.032; stage2.add(inter)
  const tank2 = new THREE.Mesh(new THREE.CylinderGeometry(0.104, 0.104, 0.24, 22), whiteMat)
  tank2.rotation.x = Math.PI / 2; tank2.position.z = 0.185; stage2.add(tank2)
  const band2 = new THREE.Mesh(new THREE.CylinderGeometry(0.106, 0.106, 0.036, 22), liveryMat)
  band2.rotation.x = Math.PI / 2; band2.position.z = 0.255; stage2.add(band2)
  const adapter = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.104, 0.075, 18), darkMat)
  adapter.rotation.x = Math.PI / 2; adapter.position.z = 0.342; stage2.add(adapter)
  const vacBell = new THREE.Mesh(new THREE.ConeGeometry(0.066, 0.125, 18, 1, true), steelMat)
  vacBell.rotation.x = -Math.PI / 2; vacBell.position.z = -0.02; stage2.add(vacBell)
  const flame2 = flameCone(0.092, 0.65, -0.06, 0x8bc8ff)
  stage2.add(flame2)

  // Clamshell fairing halves with curved ogive profile & dark inner lining (z = 1.02..1.52)
  const fairingHalf = (phiStart) => {
    const fg = new THREE.Group()
    fg.position.z = 1.02
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.118, 0.108, 0.25, 18, 1, false, phiStart, Math.PI), whiteMat)
    cyl.rotation.x = Math.PI / 2; cyl.position.z = 0.125; fg.add(cyl)
    const innerCyl = new THREE.Mesh(new THREE.CylinderGeometry(0.114, 0.104, 0.25, 16, 1, false, phiStart, Math.PI), fairingInnerMat)
    innerCyl.rotation.x = Math.PI / 2; innerCyl.position.z = 0.125; fg.add(innerCyl)
    const fStripe = new THREE.Mesh(new THREE.CylinderGeometry(0.120, 0.118, 0.036, 18, 1, false, phiStart, Math.PI), liveryMat)
    fStripe.rotation.x = Math.PI / 2; fStripe.position.z = 0.21; fg.add(fStripe)
    const mid = new THREE.Mesh(new THREE.CylinderGeometry(0.088, 0.118, 0.12, 18, 1, false, phiStart, Math.PI), whiteMat)
    mid.rotation.x = Math.PI / 2; mid.position.z = 0.31; fg.add(mid)
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.088, 0.13, 18, 1, false, phiStart, Math.PI), whiteMat)
    nose.rotation.x = Math.PI / 2; nose.position.z = 0.435; fg.add(nose)
    return fg
  }
  const fairingL = fairingHalf(Math.PI * 0.5)
  const fairingR = fairingHalf(-Math.PI * 0.5)

  // Stowed lander mounted on top of Stage 2 inside fairing
  const lander = makeLanderModel()
  lander.group.position.z = 1.19
  lander.group.scale.setScalar(0.17)

  let boosterMode = 2
  function configureForPad(pad) {
    const kind = padKind(pad)
    const cfg = {
      biak: { core: 0xf1f4f8, livery: 0xd91e18, booster: 0xf4f6f9, bBand: 0xd91e18, count: 2, scaleR: 0.96, taper: false },
      ksc: { core: 0xd45d1e, livery: 0x1b2028, booster: 0xf3f5f8, bBand: 0x1b2028, count: 2, scaleR: 1.05, taper: false },
      baikonur: { core: 0x3b424b, livery: 0xe06a1b, booster: 0x4c545f, bBand: 0xe06a1b, count: 4, scaleR: 0.94, taper: true },
      kourou: { core: 0xedf1f6, livery: 0x1c4b9c, booster: 0xf4f6f9, bBand: 0x1c4b9c, count: 4, scaleR: 0.92, taper: false },
      sriharikota: { core: 0x464e58, livery: 0xe86c1c, booster: 0xf2f4f7, bBand: 0x1d2229, count: 2, scaleR: 1.14, taper: false },
      wenchang: { core: 0xf2f5f8, livery: 0xc8232c, booster: 0xf4f6f9, bBand: 0x1a4b9c, count: 4, scaleR: 1.04, taper: false },
    }[kind]
    boosterMode = cfg.count
    coreMat.color.setHex(cfg.core)
    liveryMat.color.setHex(cfg.livery)
    boosterMat.color.setHex(cfg.booster)
    boosterBandMat.color.setHex(cfg.bBand)
    for (const b of boosters) {
      b.taper.visible = cfg.taper
      b.body.scale.set(cfg.scaleR, cfg.scaleR, 1)
    }
  }

  root.add(stage1, stage2, fairingL, fairingR, lander.group)
  return { root, stage1, flame1, boosters, stage2, flame2, fairingL, fairingR, lander, configureForPad, get boosterCount() { return boosterMode } }
}

// 3D Earth Ground Terrain (16 km x 16 km) + Authentic Regional Launch Complex, Villages, Forests & Spaceport Town
function createPadComplex() {
  const root = new THREE.Group()
  const S = 0.00012 // 120 m structural scale in scene units
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0x5c626a, roughness: 0.9, metalness: 0.05 })
  const towerMat = new THREE.MeshStandardMaterial({ color: 0xaab2bc, roughness: 0.5, metalness: 0.6 })
  const orangeMat = new THREE.MeshStandardMaterial({ color: 0xd95a2b, roughness: 0.45, metalness: 0.45 })
  const tankMat = new THREE.MeshStandardMaterial({ color: 0xedf1f5, roughness: 0.35, metalness: 0.15 })
  const redMat = new THREE.MeshStandardMaterial({ color: 0xff3b2f, emissive: 0x991100 })
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b6743, roughness: 0.88 })
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82 })
  const palmMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78 })
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 })
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78 })
  const winMat = new THREE.MeshStandardMaterial({ color: 0xffca6b, emissive: 0xd9821e, emissiveIntensity: 0.7 })
  const hangarMat = new THREE.MeshStandardMaterial({ color: 0xe6ebf0, roughness: 0.55, metalness: 0.25 })
  const navyMat = new THREE.MeshStandardMaterial({ color: 0x25384d, roughness: 0.5, metalness: 0.4 })

  // Ground terrain mesh (local +X = East, +Y = Up, +Z = South)
  const HALF_M = 8000, SEG = 112
  const groundGeo = new THREE.PlaneGeometry((HALF_M * 2) * M_TO_U, (HALF_M * 2) * M_TO_U, SEG, SEG).rotateX(-Math.PI / 2)
  const groundCol = new Float32Array(groundGeo.attributes.position.count * 3)
  groundGeo.setAttribute('color', new THREE.BufferAttribute(groundCol, 3))
  const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.05 })
  const ground = new THREE.Mesh(groundGeo, groundMat)
  root.add(ground)

  // Launch complex scaled cleanly around (0,0,0) in pad frame (+Y up)
  const complex = new THREE.Group()
  complex.scale.setScalar(S)
  root.add(complex)

  const apron = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.03, 1.8), concreteMat)
  apron.position.set(-0.18, 0.015, 0); complex.add(apron)
  const mount = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.055, 0.56), concreteMat)
  mount.position.y = 0.025; complex.add(mount)
  const trench = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 1.4), new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.95 }))
  trench.position.set(0.35, 0.03, 0); complex.add(trench)

  const tower = new THREE.Mesh(new THREE.BoxGeometry(0.24, 1.12, 0.24), orangeMat)
  tower.position.set(-0.34, 0.56, 0); complex.add(tower)
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.022, 0.28, 8), towerMat)
  mast.position.set(-0.34, 1.25, 0); complex.add(mast)
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8), redMat)
  beacon.position.set(-0.34, 1.39, 0); complex.add(beacon)

  const arms = [0.46, 0.82].map((h) => {
    const pivot = new THREE.Group()
    pivot.position.set(-0.22, h, 0)
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.045), towerMat)
    arm.position.x = 0.11; pivot.add(arm)
    complex.add(pivot)
    return pivot
  })

  for (const [lx, lz] of [[-0.95, -0.78], [-0.95, 0.78], [0.62, -0.78], [0.62, 0.78]]) {
    const lt = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.035, 1.22, 6), towerMat)
    lt.position.set(lx, 0.61, lz); complex.add(lt)
  }
  for (const [tx, tz] of [[-0.86, -0.35], [-0.86, 0.35]]) {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 10), tankMat)
    sphere.position.set(tx, 0.16, tz); complex.add(sphere)
  }

  // Shared unit geometries + GPU-instanced meshes for forests, palms, wooden coastal houses, town blocks & boats
  const boxGeo = new THREE.BoxGeometry(1, 1, 1)
  const cylGeo = new THREE.CylinderGeometry(0.45, 0.65, 1, 6)
  const cone7Geo = new THREE.ConeGeometry(1, 1, 7)
  const roofGeo = new THREE.ConeGeometry(0.78, 0.6, 4).rotateY(Math.PI / 4)
  const dodecaGeo = new THREE.DodecahedronGeometry(1, 0)
  const sphereGeo = new THREE.SphereGeometry(1, 12, 10)

  const MAX_TREES = 4800, MAX_PALMS = 650, MAX_HOUSES = 90, MAX_TOWN = 70, MAX_BOATS = 12
  const treeTrunks = new THREE.InstancedMesh(cylGeo, woodMat, MAX_TREES)
  const treeCrowns = new THREE.InstancedMesh(dodecaGeo, leafMat, MAX_TREES)
  const treeTops = new THREE.InstancedMesh(cone7Geo, leafMat, MAX_TREES)
  const palmTrunks = new THREE.InstancedMesh(cylGeo, woodMat, MAX_PALMS)
  const palmCrowns = new THREE.InstancedMesh(cone7Geo, palmMat, MAX_PALMS)
  const houseBodies = new THREE.InstancedMesh(boxGeo, wallMat, MAX_HOUSES)
  const houseRoofs = new THREE.InstancedMesh(roofGeo, roofMat, MAX_HOUSES)
  const houseWins = new THREE.InstancedMesh(boxGeo, winMat, MAX_HOUSES)
  const townBlocks = new THREE.InstancedMesh(boxGeo, wallMat, MAX_TOWN)
  const boatHulls = new THREE.InstancedMesh(boxGeo, woodMat, MAX_BOATS)
  const boatCabins = new THREE.InstancedMesh(boxGeo, hangarMat, MAX_BOATS)
  for (const im of [treeTrunks, treeCrowns, treeTops, palmTrunks, palmCrowns, houseBodies, houseRoofs, houseWins, townBlocks, boatHulls, boatCabins]) {
    im.frustumCulled = false
    root.add(im)
  }

  // Regional landmark buildings (VAB/MIK hangars, wooden piers, radar dishes, rail/crawlerway) using shared geometries
  const structures = new THREE.Group()
  root.add(structures)

  function shoreE(kind, n) {
    if (kind === 'wenchang') return 130 + 95 * Math.cos(n / 420) + 25 * Math.sin(n / 180)
    if (kind === 'ksc' || kind === 'sriharikota') return 145 + 32 * Math.sin(n / 540)
    return 125 + 52 * Math.sin(n / 340) + 24 * Math.cos(n / 145)
  }

  function evalTerrain(kind, e, n) {
    const coastal = kind !== 'baikonur'
    const r = Math.hypot(e, n)
    const curveDrop = (e * e + n * n) / (2 * R_EARTH * 1000)
    const clearW = Math.min(1, Math.max(0, (r - 220) / 480))
    const hills = (28 * Math.sin(e / 1400) * Math.cos(n / 1200) + 18 * Math.cos((e - n) / 800) + 46 * Math.max(0, -e / HALF_M)) * clearW
    let h = 0, cr = 0.25, cg = 0.34, cb = 0.22, kindSurf = 'land'
    if (coastal) {
      const ce = shoreE(kind, n)
      const backLagoon = (kind === 'ksc' || kind === 'sriharikota') && Math.abs(e - (-480 + 90 * Math.sin(n / 480))) < 105
      if (e > ce + 220) {
        h = -2.5; kindSurf = 'ocean'
        cr = kind === 'biak' || kind === 'wenchang' ? 0.05 : 0.06
        cg = kind === 'biak' || kind === 'wenchang' ? 0.28 : 0.24
        cb = kind === 'biak' || kind === 'wenchang' ? 0.56 : 0.50
      } else if (e > ce + 34) {
        const t = Math.min(1, (e - (ce + 34)) / 186)
        h = -1.1 - 1.4 * t; kindSurf = 'lagoon'
        cr = 0.14 + (0.05 - 0.14) * t; cg = 0.72 + (0.26 - 0.72) * t; cb = 0.84 + (0.54 - 0.84) * t
      } else if (e > ce + 10) {
        h = -0.2; kindSurf = 'surf'
        cr = 0.90; cg = 0.96; cb = 0.99
      } else if (e > ce - 48) {
        const s = (ce + 10 - e) / 58
        h = 1.6 * s; kindSurf = 'sand'
        if (kind === 'ksc' || kind === 'wenchang') { cr = 0.90; cg = 0.85; cb = 0.70 }
        else { cr = 0.88; cg = 0.78; cb = 0.55 }
      } else if (backLagoon) {
        h = -1.6; kindSurf = 'lagoon'
        cr = 0.10; cg = 0.44; cb = 0.62
      } else {
        h = Math.max(0.7, hills + 4 * clearW)
        const patch = 0.72 + 0.22 * Math.sin(e / 260 + n / 230) + 0.12 * Math.cos((e - n) / 140)
        if (kind === 'kourou') { cr = 0.09 * patch; cg = 0.34 * patch; cb = 0.11 * patch }
        else if (kind === 'sriharikota') { cr = 0.17 * patch; cg = 0.37 * patch; cb = 0.14 * patch }
        else { cr = 0.11 * patch; cg = 0.39 * patch; cb = 0.14 * patch }
      }
      const roadW = kind === 'ksc' ? 15 : 10
      if ((Math.abs(n) < roadW && e < -30 && e > -2400 && !backLagoon) || (e < ce - 52 && Math.abs(e - (ce - 76)) < 8)) {
        kindSurf = 'road'
        if (kind === 'ksc') { cr = 0.42; cg = 0.36; cb = 0.30 }
        else { cr = 0.26; cg = 0.28; cb = 0.32 }
      }
      if (r < 120 && e < ce - 42) {
        const fl = Math.max(0, 1 - Math.max(0, r - 76) / 44)
        h *= (1 - fl); kindSurf = 'pad'
        cr = cr * (1 - fl) + 0.36 * fl; cg = cg * (1 - fl) + 0.38 * fl; cb = cb * (1 - fl) + 0.42 * fl
      }
    } else {
      const riverDist = Math.abs(n + 520 - 160 * Math.sin(e / 460))
      if (riverDist < 52 && r > 220) {
        h = -2.4; kindSurf = 'river'
        cr = 0.12; cg = 0.36; cb = 0.46
      } else if (riverDist < 95 && r > 220) {
        h = Math.max(0.3, hills * 0.35)
        cr = 0.30; cg = 0.40; cb = 0.24
      } else {
        h = Math.max(0, hills)
        const v = 0.90 + 0.16 * Math.sin(e / 520 - n / 480)
        cr = 0.52 * v; cg = 0.43 * v; cb = 0.32 * v
      }
      if (Math.abs(n) < 10 && e < -30 && e > -2400) {
        kindSurf = 'road'; cr = 0.30; cg = 0.29; cb = 0.31
      }
      if (r < 140) {
        const fl = Math.max(0, 1 - Math.max(0, r - 85) / 55)
        h *= (1 - fl); kindSurf = 'pad'
        cr = cr * (1 - fl) + 0.36 * fl; cg = cg * (1 - fl) + 0.38 * fl; cb = cb * (1 - fl) + 0.42 * fl
      }
    }
    const edgeFade = Math.max(0, (r - HALF_M * 0.72) / (HALF_M * 0.28))
    h -= edgeFade * edgeFade * 35
    return { yU: (h - curveDrop) * M_TO_U, cr, cg, cb, surf: kindSurf }
  }

  function addBox(xM, yOffM, zM, wM, hM, dM, mat, kind, ry = 0) {
    const t = evalTerrain(kind, xM, -zM)
    const m = new THREE.Mesh(boxGeo, mat)
    m.scale.set(wM * M_TO_U, hM * M_TO_U, dM * M_TO_U)
    m.position.set(xM * M_TO_U, t.yU + (yOffM + hM * 0.5) * M_TO_U, zM * M_TO_U)
    m.rotation.y = ry
    structures.add(m)
    return m
  }

  function populateLocaleProps(kind) {
    structures.clear()
    let seed = kind.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7)
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const dummy = new THREE.Object3D(), col = new THREE.Color()

    const addWoodPier = (zM, lenM) => {
      const nOff = -zM
      const startX = shoreE(kind, nOff) - 18
      addBox(startX + lenM * 0.5, 2.2, zM, lenM, 1.2, 8, woodMat, kind)
      for (let s = 0; s <= 5; s++) {
        const px = startX + (lenM * s) / 5
        addBox(px, 0, zM - 3.2, 1.2, 4.4, 1.2, woodMat, kind)
        addBox(px, 0, zM + 3.2, 1.2, 4.4, 1.2, woodMat, kind)
      }
      // Shelter pavilion at end of main pier
      const endX = startX + lenM - 6
      addBox(endX, 2.8, zM, 10, 4.5, 9, wallMat, kind)
      addBox(endX, 7.3, zM, 12, 2.2, 11, orangeMat, kind)
    }

    // 1. Unique authentic spaceport landmarks & piers
    if (kind !== 'baikonur') {
      addWoodPier(-110, 125)
      if (kind === 'biak' || kind === 'wenchang' || kind === 'kourou') addWoodPier(240, 88)
    } else {
      // Baikonur rail cars & radar dishes along corridor
      for (let i = 0; i < 4; i++) addBox(-260 - i * 32, 0.2, 0, 26, 5.5, 5.5, navyMat, kind)
    }

    if (kind === 'ksc') {
      // Iconic Kennedy VAB + Launch Control Center + Crawlerway
      addBox(-620, 0, -210, 145, 110, 125, tankMat, kind)
      addBox(-545, 0, -210, 8, 108, 42, navyMat, kind)
      addBox(-780, 0, -140, 85, 32, 65, hangarMat, kind)
      const wt = new THREE.Mesh(sphereGeo, tankMat)
      const wtPos = evalTerrain(kind, -460, 180)
      wt.scale.setScalar(18 * M_TO_U); wt.position.set(-460 * M_TO_U, wtPos.yU + 52 * M_TO_U, -180 * M_TO_U); structures.add(wt)
      addBox(-460, 0, -180, 12, 50, 12, towerMat, kind)
    } else if (kind === 'baikonur') {
      // Soviet MIK horizontal integration halls + Leninsk radar domes
      addBox(-560, 0, -190, 175, 42, 90, hangarMat, kind)
      addBox(-560, 0, 170, 140, 36, 75, navyMat, kind)
      for (const rz of [-120, 130]) {
        addBox(-380, 0, rz, 14, 34, 14, towerMat, kind)
        const dish = new THREE.Mesh(sphereGeo, tankMat)
        const dPos = evalTerrain(kind, -380, -rz)
        dish.scale.setScalar(16 * M_TO_U); dish.position.set(-380 * M_TO_U, dPos.yU + 42 * M_TO_U, rz * M_TO_U); structures.add(dish)
      }
    } else {
      // Biak, Kourou, Sriharikota, Wenchang modern vertical VAB + control complex
      const vabColor = kind === 'biak' ? hangarMat : kind === 'kourou' ? tankMat : hangarMat
      addBox(-520, 0, -170, 115, 78, 95, vabColor, kind)
      addBox(-462, 0, -170, 6, 74, 36, kind === 'biak' ? redMat : kind === 'kourou' ? navyMat : orangeMat, kind)
      addBox(-660, 0, -120, 75, 28, 55, tankMat, kind)
    }

    // 2. Wooden coastal houses (rumah kayu) along beachfront road & kampung clusters
    let hIdx = 0
    const houseRoofCols = kind === 'biak' ? [0xb8462c, 0x7a4e2d, 0x3b6d8c, 0xc26530]
      : kind === 'baikonur' ? [0x6e4f3a, 0x5c646d, 0x8a5138]
      : [0xb8492e, 0x3b698a, 0x805636]
    const targetHouses = kind === 'baikonur' ? 42 : 82
    for (let attempt = 0; attempt < 550 && hIdx < targetHouses; attempt++) {
      let xM, zM
      if (kind !== 'baikonur' && attempt < 360) {
        zM = (rnd() - 0.5) * 4200
        if (Math.abs(zM) < 95) continue
        const ce = shoreE(kind, -zM)
        xM = ce - 55 - rnd() * 140
      } else {
        xM = -220 - rnd() * 2000
        zM = (rnd() > 0.5 ? 1 : -1) * (55 + rnd() * 1100)
      }
      const t = evalTerrain(kind, xM, -zM)
      if (t.surf !== 'land') continue
      const w = 13 + rnd() * 8, h = 6.5 + rnd() * 3.5, d = 10 + rnd() * 6
      const ry = rnd() * 0.45 - 0.22
      // Raised wooden house body
      dummy.position.set(xM * M_TO_U, t.yU + (h * 0.5 + 1.5) * M_TO_U, zM * M_TO_U)
      dummy.rotation.set(0, ry, 0)
      dummy.scale.set(w * M_TO_U, h * M_TO_U, d * M_TO_U)
      dummy.updateMatrix()
      houseBodies.setMatrixAt(hIdx, dummy.matrix)
      col.setHex(kind === 'baikonur' ? 0xb59b7c : 0x9c7046).offsetHSL(0, 0, (rnd() - 0.5) * 0.08)
      houseBodies.setColorAt(hIdx, col)

      // Pitched timber/terracotta roof
      dummy.position.set(xM * M_TO_U, t.yU + (h + 3.4) * M_TO_U, zM * M_TO_U)
      dummy.scale.set(w * 1.18 * M_TO_U, h * 0.72 * M_TO_U, d * 1.18 * M_TO_U)
      dummy.updateMatrix()
      houseRoofs.setMatrixAt(hIdx, dummy.matrix)
      col.setHex(houseRoofCols[hIdx % houseRoofCols.length])
      houseRoofs.setColorAt(hIdx, col)

      // Warm lit window band
      dummy.position.set(xM * M_TO_U, t.yU + (h * 0.55 + 1.5) * M_TO_U, zM * M_TO_U)
      dummy.scale.set(w * 1.02 * M_TO_U, h * 0.26 * M_TO_U, d * 1.02 * M_TO_U)
      dummy.updateMatrix()
      houseWins.setMatrixAt(hIdx, dummy.matrix)
      hIdx++
    }
    houseBodies.count = houseRoofs.count = houseWins.count = hIdx
    houseBodies.instanceMatrix.needsUpdate = houseRoofs.instanceMatrix.needsUpdate = houseWins.instanceMatrix.needsUpdate = true
    if (houseBodies.instanceColor) houseBodies.instanceColor.needsUpdate = true
    if (houseRoofs.instanceColor) houseRoofs.instanceColor.needsUpdate = true

    // 3. Multi-story city/spaceport town blocks in inland sector
    let bIdx = 0
    for (let attempt = 0; attempt < 360 && bIdx < MAX_TOWN; attempt++) {
      const xM = -320 - rnd() * 2400, zM = (rnd() > 0.5 ? 1 : -1) * (100 + rnd() * 1600)
      if (Math.abs(xM + 580) < 200 && Math.abs(zM + 190) < 160) continue
      const t = evalTerrain(kind, xM, -zM)
      if (t.surf !== 'land') continue
      const w = 22 + rnd() * 24, h = 16 + rnd() * 28, d = 18 + rnd() * 22
      dummy.position.set(xM * M_TO_U, t.yU + h * 0.5 * M_TO_U, zM * M_TO_U)
      dummy.rotation.set(0, rnd() * 0.3, 0)
      dummy.scale.set(w * M_TO_U, h * M_TO_U, d * M_TO_U)
      dummy.updateMatrix()
      townBlocks.setMatrixAt(bIdx, dummy.matrix)
      col.setHex(kind === 'baikonur' ? 0xbab0a0 : 0xcad3de).offsetHSL(0, 0, (rnd() - 0.5) * 0.12)
      townBlocks.setColorAt(bIdx, col)
      bIdx++
    }
    townBlocks.count = bIdx
    townBlocks.instanceMatrix.needsUpdate = true
    if (townBlocks.instanceColor) townBlocks.instanceColor.needsUpdate = true

    // 4. Coastal coconut palms (along tropical beaches)
    let pIdx = 0
    const palmTarget = kind === 'baikonur' ? 0 : kind === 'ksc' ? 320 : 620
    for (let attempt = 0; attempt < 2400 && pIdx < palmTarget; attempt++) {
      const zM = (rnd() - 0.5) * 7200
      if (Math.abs(zM) < 55) continue
      const ce = shoreE(kind, -zM)
      const xM = ce - 16 - rnd() * 260
      const t = evalTerrain(kind, xM, -zM)
      if (t.surf !== 'sand' && t.surf !== 'land') continue
      const h = 12 + rnd() * 10, tilt = (rnd() - 0.5) * 0.28, yaw = rnd() * 6
      dummy.position.set(xM * M_TO_U, t.yU + h * 0.45 * M_TO_U, zM * M_TO_U)
      dummy.rotation.set(tilt, yaw, -0.16)
      dummy.scale.set(1.15 * M_TO_U, h * M_TO_U, 1.15 * M_TO_U)
      dummy.updateMatrix()
      palmTrunks.setMatrixAt(pIdx, dummy.matrix)

      dummy.position.set(xM * M_TO_U, t.yU + h * 0.92 * M_TO_U, zM * M_TO_U)
      dummy.rotation.set(0, yaw, 0)
      dummy.scale.set(8.2 * M_TO_U, 5.2 * M_TO_U, 8.2 * M_TO_U)
      dummy.updateMatrix()
      palmCrowns.setMatrixAt(pIdx, dummy.matrix)
      col.setHex(0x2d8a34).offsetHSL((rnd() - 0.5) * 0.05, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.1)
      palmCrowns.setColorAt(pIdx, col)
      pIdx++
    }
    palmTrunks.count = palmCrowns.count = pIdx
    palmTrunks.instanceMatrix.needsUpdate = palmCrowns.instanceMatrix.needsUpdate = true
    if (palmCrowns.instanceColor) palmCrowns.instanceColor.needsUpdate = true

    // 5. Wide multi-zone dense rainforest / Florida pine / steppe scrub canopy
    let tIdx = 0
    const treeTarget = kind === 'baikonur' ? 1400 : MAX_TREES
    const baseHex = kind === 'baikonur' ? 0x6c6e46 : kind === 'kourou' ? 0x1b6123 : kind === 'ksc' ? 0x255f27 : 0x216f29
    const addForestTree = (xM, zM, yU, horizonBoost) => {
      const h = (kind === 'baikonur' ? 3.5 + rnd() * 3.8 : 13 + rnd() * 14) * horizonBoost
      const cw = (kind === 'baikonur' ? 4.5 + rnd() * 3.8 : kind === 'ksc' ? 7.5 + rnd() * 5 : 10 + rnd() * 9) * horizonBoost
      const ch = (kind === 'ksc' ? h * 0.88 : kind === 'baikonur' ? h * 0.78 : h * 0.72)
      const yaw = rnd() * Math.PI * 2, lean = (rnd() - 0.5) * 0.08
      const hueJ = (rnd() - 0.5) * 0.055, satJ = (rnd() - 0.5) * 0.12, lumJ = (rnd() - 0.5) * 0.12

      dummy.position.set(xM * M_TO_U, yU + h * 0.30 * M_TO_U, zM * M_TO_U)
      dummy.rotation.set(lean, yaw, lean * 0.5)
      dummy.scale.set(1.7 * horizonBoost * M_TO_U, h * 0.62 * M_TO_U, 1.7 * horizonBoost * M_TO_U)
      dummy.updateMatrix()
      treeTrunks.setMatrixAt(tIdx, dummy.matrix)

      // Tier 1: broad lower/mid canopy foliage
      dummy.position.set(xM * M_TO_U, yU + h * 0.66 * M_TO_U, zM * M_TO_U)
      dummy.rotation.set(lean * 0.4, yaw, 0)
      dummy.scale.set(cw * 0.62 * M_TO_U, ch * 0.54 * M_TO_U, cw * 0.62 * M_TO_U)
      dummy.updateMatrix()
      treeCrowns.setMatrixAt(tIdx, dummy.matrix)
      col.setHex(baseHex).offsetHSL(hueJ, satJ, lumJ - 0.04)
      treeCrowns.setColorAt(tIdx, col)

      // Tier 2: sunlit emergent upper treetop crown
      dummy.position.set((xM + (rnd() - 0.5) * cw * 0.14) * M_TO_U, yU + h * 0.98 * M_TO_U, (zM + (rnd() - 0.5) * cw * 0.14) * M_TO_U)
      dummy.rotation.set(lean * 0.3, yaw + 0.7, 0)
      dummy.scale.set(cw * 0.58 * M_TO_U, ch * 0.64 * M_TO_U, cw * 0.58 * M_TO_U)
      dummy.updateMatrix()
      treeTops.setMatrixAt(tIdx, dummy.matrix)
      col.setHex(baseHex).offsetHSL(hueJ, satJ, lumJ + 0.035)
      treeTops.setColorAt(tIdx, col)
      tIdx++
    }

    const qA = Math.round(treeTarget * 0.35), qAB = Math.min(treeTarget, qA + Math.round(treeTarget * 0.40))
    const zones = [
      {
        limit: qA, scale: 1.0,
        sample: () => {
          const ang = rnd() * Math.PI * 2, rad = 118 + Math.pow(rnd(), 0.78) * 1382
          return [Math.cos(ang) * rad, Math.sin(ang) * rad]
        },
      },
      {
        limit: qAB, scale: 1.15,
        sample: () => {
          const zM = (rnd() - 0.5) * 8400
          if (kind === 'baikonur') return [3600 - rnd() * 7800, zM]
          const ce = shoreE(kind, -zM) - 38
          return [ce - Math.pow(rnd(), 1.15) * (ce + 4200), zM]
        },
      },
      {
        limit: treeTarget, scale: 1.55,
        sample: () => [
          kind === 'baikonur' ? (rnd() - 0.5) * 13200 : -900 - rnd() * 5900,
          (rnd() - 0.5) * 12400,
        ],
      },
    ]

    for (const z of zones) {
      for (let attempt = 0; attempt < 9000 && tIdx < z.limit; attempt++) {
        const [xM, zM] = z.sample()
        const r = Math.hypot(xM, zM)
        if (r < 118 || r > HALF_M * 0.94) continue
        if (Math.abs(xM + 580) < 210 && Math.abs(zM + 190) < 160) continue
        if (kind === 'baikonur' && ((Math.abs(xM + 560) < 180 && Math.abs(zM - 170) < 120) || (Math.abs(xM + 310) < 90 && Math.abs(zM) < 35))) continue
        const t = evalTerrain(kind, xM, -zM)
        if (t.surf !== 'land') continue
        if (kind !== 'baikonur' && xM > shoreE(kind, -zM) - 42) continue
        const grove = 0.55 + 0.45 * Math.sin(xM / 280 + Math.cos(zM / 260) * 1.4) * Math.cos(zM / 310)
        if (rnd() > grove + 0.18) continue
        addForestTree(xM, zM, t.yU, z.scale)
      }
    }
    treeTrunks.count = treeCrowns.count = treeTops.count = tIdx
    treeTrunks.instanceMatrix.needsUpdate = treeCrowns.instanceMatrix.needsUpdate = treeTops.instanceMatrix.needsUpdate = true
    if (treeCrowns.instanceColor) treeCrowns.instanceColor.needsUpdate = true
    if (treeTops.instanceColor) treeTops.instanceColor.needsUpdate = true

    // 6. Floating boats (perahu) off the beach / pier
    let boatIdx = 0
    if (kind !== 'baikonur') {
      for (let b = 0; b < 6; b++) {
        const zM = -180 + b * 95 + (rnd() - 0.5) * 35
        const xM = shoreE(kind, -zM) + 65 + rnd() * 190
        const ry = (rnd() - 0.5) * 0.9
        dummy.position.set(xM * M_TO_U, -1.1 * M_TO_U, zM * M_TO_U)
        dummy.rotation.set(0, ry, 0)
        dummy.scale.set(18 * M_TO_U, 3.2 * M_TO_U, 5.5 * M_TO_U)
        dummy.updateMatrix()
        boatHulls.setMatrixAt(boatIdx, dummy.matrix)

        dummy.position.set(xM * M_TO_U, 1.4 * M_TO_U, zM * M_TO_U)
        dummy.scale.set(7.5 * M_TO_U, 3.0 * M_TO_U, 4.0 * M_TO_U)
        dummy.updateMatrix()
        boatCabins.setMatrixAt(boatIdx, dummy.matrix)
        boatIdx++
      }
    }
    boatHulls.count = boatCabins.count = boatIdx
    boatHulls.instanceMatrix.needsUpdate = boatCabins.instanceMatrix.needsUpdate = true
  }

  function buildPadTerrain(pad) {
    const kind = padKind(pad)
    const pos = groundGeo.attributes.position
    const col = groundGeo.attributes.color
    for (let i = 0; i < pos.count; i++) {
      const e = pos.getX(i) / M_TO_U, n = -pos.getZ(i) / M_TO_U
      const t = evalTerrain(kind, e, n)
      pos.setY(i, t.yU)
      col.setXYZ(i, t.cr, t.cg, t.cb)
    }
    pos.needsUpdate = true; col.needsUpdate = true
    groundGeo.computeVertexNormals()
    populateLocaleProps(kind)
  }

  // Local atmospheric sky dome right above the beach pad (vanishes cleanly by ~1.2 km so continents stay visible)
  const skyMat = new THREE.MeshBasicMaterial({ color: 0x4d8fd6, side: THREE.BackSide, transparent: true, opacity: 0.32, depthWrite: false })
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(0.024, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.53), skyMat)
  root.add(skyDome)

  function update(sunElDot, altKm, kAscent, phase) {
    const armAngle = phase === 'ascent' ? Math.min(1, kAscent / 0.004) * 1.35 : phase === 'landed' || phase !== 'ascent' ? 1.35 : 0
    for (const a of arms) a.rotation.y = armAngle

    const altFade = Math.max(0, 1 - altKm / 1.2)
    if (altFade <= 0.01) {
      skyDome.visible = false
    } else {
      skyDome.visible = true
      if (sunElDot > 0.12) skyMat.color.setHex(0x4b8dd4), skyMat.opacity = 0.32 * altFade
      else if (sunElDot > -0.08) skyMat.color.setHex(0xc96f3e), skyMat.opacity = 0.25 * altFade
      else skyMat.color.setHex(0x091326), skyMat.opacity = 0.15 * altFade
    }
  }

  return { root, buildPadTerrain, update }
}

// 3D Particle System for Rocket Plume, Flame-Trench Steam, Staging Puffs & Lunar Regolith Dust
function createSmokeSystem(max = 260) {
  const c = document.createElement('canvas'); c.width = c.height = 64
  const ctx = c.getContext('2d')
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30)
  grad.addColorStop(0, 'rgba(255,255,255,0.95)')
  grad.addColorStop(0.45, 'rgba(240,240,240,0.45)')
  grad.addColorStop(1, 'rgba(220,220,220,0)')
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 64, 64)
  const map = new THREE.CanvasTexture(c)

  const posArr = new Float32Array(max * 3)
  const colArr = new Float32Array(max * 3)
  const sizeArr = new Float32Array(max)
  const alphaArr = new Float32Array(max)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3))
  geo.setAttribute('aColor', new THREE.BufferAttribute(colArr, 3))
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizeArr, 1))
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphaArr, 1))

  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uScale: { value: 380 } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
      varying vec3 vColor; varying float vAlpha;
      uniform float uScale;
      void main() {
        vColor = aColor; vAlpha = aAlpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(aSize * uScale / max(-mvPosition.z, 1e-6), 0.0, 220.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D uMap;
      varying vec3 vColor; varying float vAlpha;
      void main() {
        #include <logdepthbuf_fragment>
        vec4 tex = texture2D(uMap, gl_PointCoord);
        float a = tex.a * vAlpha;
        if (a < 0.005) discard;
        gl_FragColor = vec4(vColor * tex.rgb, a);
      }`,
  })

  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  const pool = Array.from({ length: max }, () => ({
    age: 99, life: 1, wx: 0, wy: 0, wz: 0, vx: 0, vy: 0, vz: 0,
    s0: 0.00002, s1: 0.00015, r: 1, g: 1, b: 1,
  }))
  let cursor = 0, seed = 13
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2

  function emit({ world, vel, s0, s1, life, color }) {
    const p = pool[cursor]
    cursor = (cursor + 1) % max
    p.age = 0; p.life = life
    p.wx = world.x; p.wy = world.y; p.wz = world.z
    p.vx = vel.x; p.vy = vel.y; p.vz = vel.z
    p.s0 = s0; p.s1 = s1; p.r = color[0]; p.g = color[1]; p.b = color[2]
  }

  function step(dt, origin, screenH) {
    mat.uniforms.uScale.value = Math.max(150, screenH * 0.72)
    for (let i = 0; i < max; i++) {
      const p = pool[i]
      p.age += dt
      if (p.age >= p.life) {
        alphaArr[i] = 0; sizeArr[i] = 0; continue
      }
      const k = p.age / p.life
      p.wx += p.vx * dt; p.wy += p.vy * dt; p.wz += p.vz * dt
      p.vx *= Math.max(0, 1 - dt * 0.7); p.vy *= Math.max(0, 1 - dt * 0.7); p.vz *= Math.max(0, 1 - dt * 0.7)
      posArr[i * 3] = p.wx - origin.x
      posArr[i * 3 + 1] = p.wy - origin.y
      posArr[i * 3 + 2] = p.wz - origin.z
      colArr[i * 3] = p.r; colArr[i * 3 + 1] = p.g; colArr[i * 3 + 2] = p.b
      sizeArr[i] = p.s0 + (p.s1 - p.s0) * Math.sqrt(k)
      alphaArr[i] = (1 - k) * (k < 0.12 ? k / 0.12 : 1) * 0.78
    }
    geo.attributes.position.needsUpdate = true
    geo.attributes.aColor.needsUpdate = true
    geo.attributes.aSize.needsUpdate = true
    geo.attributes.aAlpha.needsUpdate = true
  }

  function clear() {
    for (const p of pool) p.age = 99
    alphaArr.fill(0); sizeArr.fill(0)
    geo.attributes.aAlpha.needsUpdate = true
    geo.attributes.aSize.needsUpdate = true
  }

  return { points, emit, step, clear, rnd }
}

export function createSpace(el) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.domElement.className = 'space-canvas'
  renderer.domElement.hidden = true
  el.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)
  const camera = new THREE.PerspectiveCamera(45, 1, 1e-6, 60000)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.minDistance = 4e-5; controls.maxDistance = 6000

  scene.add(new THREE.AmbientLight(0x334466, 0.18))
  scene.add(new THREE.HemisphereLight(0x9ec5ff, 0x2a3542, 0.55))
  const sunLight = new THREE.DirectionalLight(0xffffff, 2.7)
  const craftLight = new THREE.DirectionalLight(0xdce8ff, 1.35)
  const plumeLight = new THREE.PointLight(0xffa448, 0, 0.01, 0)
  scene.add(sunLight, sunLight.target, craftLight, craftLight.target, plumeLight)

  const starPos = new Float32Array(4000 * 3)
  for (let i = 0; i < 4000; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(40000); starPos.set([v.x, v.y, v.z], i * 3) }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
  const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.1, sizeAttenuation: false, depthTest: false, depthWrite: false }))
  stars.renderOrder = -10
  scene.add(stars)

  const earth = makeEarth()
  earth.mesh.scale.setScalar(R_EARTH * U)
  scene.add(earth.mesh)

  const moonTex = new THREE.TextureLoader().load('./textures/moon.jpg')
  moonTex.colorSpace = THREE.SRGBColorSpace; moonTex.anisotropy = 4
  const moon = new THREE.Mesh(new THREE.SphereGeometry(R_MOON * U, 96, 48), new THREE.MeshStandardMaterial({ map: moonTex, bumpMap: moonTex, bumpScale: 0.0025, emissive: new THREE.Color(0x141820), emissiveIntensity: 0.28, roughness: 1, metalness: 0 }))
  scene.add(moon)

  const sun = makeSun()
  scene.add(sun.mesh)

  const moonOrbitGroup = new THREE.Group()
  const solarOrbitsGroup = new THREE.Group()
  const planetsGroup = new THREE.Group()
  moonOrbitGroup.visible = solarOrbitsGroup.visible = planetsGroup.visible = false
  scene.add(moonOrbitGroup, solarOrbitsGroup, planetsGroup)

  const PLANET_SPECS = [
    { body: A.Body.Mercury, name: 'Mercury', periodDays: 87.97,  color: 0xc2bcb2, hex: '#c2bcb2', radiusKm: 2439.7, steps: 96 },
    { body: A.Body.Venus,   name: 'Venus',     periodDays: 224.70, color: 0xf4dca8, hex: '#f4dca8', radiusKm: 6051.8, steps: 120 },
    { body: A.Body.Mars,    name: 'Mars',      periodDays: 686.98, color: 0xe2724b, hex: '#e2724b', radiusKm: 3389.5, steps: 140 },
    { body: A.Body.Jupiter, name: 'Jupiter',   periodDays: 4332.6, color: 0xe3b982, hex: '#e3b982', radiusKm: 69911,  steps: 180 },
    { body: A.Body.Saturn,  name: 'Saturn',  periodDays: 10759,  color: 0xe9d399, hex: '#e9d399', radiusKm: 58232,  steps: 180, ring: true },
    { body: A.Body.Uranus,  name: 'Uranus',    periodDays: 30687,  color: 0x89dce8, hex: '#89dce8', radiusKm: 25362,  steps: 180 },
    { body: A.Body.Neptune, name: 'Neptune',  periodDays: 60190,  color: 0x5d8eff, hex: '#5d8eff', radiusKm: 24622,  steps: 180 },
  ]
  const planetGeo = new THREE.SphereGeometry(1, 24, 16)
  const saturnRingGeo = new THREE.RingGeometry(1.35, 2.25, 36)
  const planets = PLANET_SPECS.map((spec) => {
    const mat = new THREE.MeshStandardMaterial({
      color: spec.color,
      emissive: new THREE.Color(spec.color).multiplyScalar(0.36),
      roughness: 0.72,
      metalness: 0.05,
    })
    const mesh = new THREE.Mesh(planetGeo, mat)
    if (spec.ring) {
      const ring = new THREE.Mesh(
        saturnRingGeo,
        new THREE.MeshBasicMaterial({ color: 0xdcc89a, side: THREE.DoubleSide, transparent: true, opacity: 0.72 }),
      )
      ring.rotation.x = Math.PI / 2 - 0.466
      mesh.add(ring)
    }
    const lbl = planetLabel(spec.name, spec.hex)
    planetsGroup.add(mesh, lbl)
    return { ...spec, mesh, lbl, worldPos: new THREE.Vector3() }
  })

  let moonOrbitLine = null, lastMoonOrbitT = NaN, solarOrbitsBuilt = false
  function rebuildSolarOrbits(epochMs) {
    solarOrbitsBuilt = true
    for (const c of [...solarOrbitsGroup.children]) { solarOrbitsGroup.remove(c); c.geometry?.dispose() }
    const addHelioLoop = (body, periodDays, steps, color, opacity) => {
      const pts = []
      const dMs = periodDays * 86400e3
      for (let k = 0; k < steps; k++) {
        const hv = A.HelioVector(body, A.MakeTime(new Date(epochMs + (k / steps) * dMs)))
        pts.push(new THREE.Vector3(hv.x * AU_U, hv.z * AU_U, -hv.y * AU_U))
      }
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
      )
      line.frustumCulled = false
      solarOrbitsGroup.add(line)
    }
    addHelioLoop(A.Body.Earth, 365.256, 180, 0x5b9dff, 0.36)
    for (const spec of PLANET_SPECS) addHelioLoop(spec.body, spec.periodDays, spec.steps, spec.color, 0.25)
  }

  function rebuildMoonOrbit(epochMs) {
    lastMoonOrbitT = epochMs
    if (moonOrbitLine) { moonOrbitGroup.remove(moonOrbitLine); moonOrbitLine.geometry.dispose() }
    const pts = [], steps = 128, periodMs = 27.321661 * 86400e3
    for (let k = 0; k < steps; k++) {
      const mv = A.GeoMoon(A.MakeTime(new Date(epochMs + (k / steps - 0.5) * periodMs)))
      pts.push(new THREE.Vector3(mv.x * AU_U, mv.z * AU_U, -mv.y * AU_U))
    }
    moonOrbitLine = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x8cc8ff, transparent: true, opacity: 0.52, depthWrite: false }),
    )
    moonOrbitLine.frustumCulled = false
    moonOrbitGroup.add(moonOrbitLine)
  }

  const padComplex = createPadComplex()
  scene.add(padComplex.root)

  // Target site beacon ring on Moon surface (close-up surface terrain renders in scene.js)
  const moonPatchRoot = new THREE.Group()
  const siteBeacon = new THREE.Mesh(new THREE.TorusGeometry(0.000045, 0.000008, 8, 24), new THREE.MeshBasicMaterial({ color: 0xffcf4a }))
  siteBeacon.rotation.x = Math.PI / 2; siteBeacon.position.y = 2 * M_TO_U
  moonPatchRoot.add(siteBeacon)
  scene.add(moonPatchRoot)

  const stack = makeLaunchStack()
  const soloCraft = makeLanderModel()
  const padDot = dot('#ff5a36')
  scene.add(stack.root, soloCraft.group, padDot)

  const smoke = createSmokeSystem(260)
  scene.add(smoke.points)

  const labels = { earth: label('Earth'), moon: label('Moon'), sun: label('Sun'), craft: label('Lander'), rocket: label('Rocket'), pad: label('') }
  for (const l of Object.values(labels)) scene.add(l)
  const geoLabels = [
    ['INDONESIA', -2.2, 118.0],
    ['Biak, Papua', -1.8, 136.5],
    ['Teluk Cenderawasih', -2.5, 137.2],
    ['Papua (Indonesia)', -3.1, 138.4],
    ['Peg. Jayawijaya (Papua)', -3.3, 139.5],
    ['Jayapura (Papua)', -2.6, 140.4],
    ['Papua Barat', -1.9, 133.8],
    ['Papua Nugini', -3.8, 146.4],
    ['Kep. Bismarck', -3.3, 147.2],
    ['Maluku', -3.2, 128.5],
    ['Sulawesi', -1.8, 120.8],
    ['Kalimantan', 0.2, 114.2],
    ['Jawa', -7.2, 110.0],
    ['Australia', -21.0, 134.5],
    ['Filipina', 12.2, 122.0],
    ['Tiongkok', 28.0, 111.0],
    ['India', 18.0, 79.0],
    ['Kazakhstan', 46.5, 65.0],
    ['Amerika Serikat', 30.0, -82.0],
    ['Amerika Selatan', -2.0, -54.0],
  ].map(([name, lat, lon]) => {
    const sprite = geoLabel(name)
    sprite.visible = false
    scene.add(sprite)
    const la = (lat * Math.PI) / 180
    return { sprite, cl: Math.cos(la), sl: Math.sin(la), lonRad: (lon * Math.PI) / 180 }
  })

  const pathMat = new THREE.LineBasicMaterial({ color: 0xff5a36, transparent: true, opacity: 0.45 })
  const doneMat = new THREE.LineBasicMaterial({ color: 0xff7a50 })
  const pathGroup = new THREE.Group()
  pathGroup.visible = false
  scene.add(pathGroup)
  let path = null, done = null, pathT = []

  let plan = null, site = null, siteDem = null, mode = 'craft', visible = false
  const origin = new THREE.Vector3(), earthWorld = new THREE.Vector3(0, 0, 0), moonWorld = new THREE.Vector3(), sunWorld = new THREE.Vector3(0, 0, -AU_U)
  const craftWorld = new THREE.Vector3(), aheadWorld = new THREE.Vector3(), padWorld = new THREE.Vector3(), sitePatchWorld = new THREE.Vector3(), vehicleWorld = new THREE.Vector3()
  const padEast = new THREE.Vector3(1, 0, 0), padUp = new THREE.Vector3(0, 1, 0), padSouth = new THREE.Vector3(0, 0, 1)
  const siteEast = new THREE.Vector3(1, 0, 0), siteUp = new THREE.Vector3(0, 1, 0), siteSouth = new THREE.Vector3(0, 0, 1)
  const sunDir = new THREE.Vector3(0, 1, 0)
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), mat4 = new THREE.Matrix4()
  const WORLD_UP = new THREE.Vector3(0, 1, 0)
  let lastT = 0, lastStage = null, lastCloseupRegime = null, prevChaseK = null, activeVehicle = soloCraft.group, curState = null, curAltKm = 0, earthAltKm = 0, moonAltKm = 0, curScale = 0.00012
  let animSpin = 0, baseG = 0, curG = 0, basePlumeIntensity = 0, isTimelineDriven = false
  const baseSunDir = new THREE.Vector3(0, 1, 0), lastCraftDir = new THREE.Vector3(0, 1, 0), plumeWorld = new THREE.Vector3()

  function setPlan(p, s, dem = siteDem) {
    plan = p; site = s; siteDem = dem; lastT = 0
    scene.remove(labels.pad); labels.pad.material.map.dispose(); labels.pad = label(p.pad.name.split(',')[0]); scene.add(labels.pad)
    padComplex.buildPadTerrain(p.pad)
    stack.configureForPad(p.pad)
    smoke.clear()

    const pts = []; pathT = []
    const add = (t) => { pts.push(toScene(craftPosition(p, t, s).pos)); pathT.push(t) }
    for (let t = p.launch; t < p.tli; t += 4 * 60e3) add(t)
    const N = 600
    for (let k = 0; k <= N; k++) add(p.tli + ((p.arrive - p.tli) * k) / N)
    for (const o of [path, done]) if (o) { pathGroup.remove(o); o.geometry.dispose() }
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    path = new THREE.Line(geo, pathMat)
    done = new THREE.Line(geo, doneMat)
    pathGroup.add(path, done)
    setMode(mode, true)
  }

  function setCamUp(v) {
    camera.up.copy(v).normalize()
    if (controls._quat) {
      controls._quat.setFromUnitVectors(camera.up, WORLD_UP)
      controls._quatInverse.copy(controls._quat).invert()
    }
  }

  function camStage() {
    if (!curState) return 'pad'
    const ph = curState.phase, k = curState.k || 0
    if (ph === 'ascent' && k < 0.90) return 'pad'
    if (ph === 'ascent' || ph === 'leo') return 'earthOrbit'
    if (ph === 'tli' || ph === 'coast') return 'coast'
    return 'moonOrbit'
  }

  function computeOrigin() {
    const stg = mode === 'craft' ? camStage() : null
    if (mode === 'closeup') origin.copy(craftWorld)
    else if (mode === 'craft') {
      if (stg === 'earthOrbit') origin.copy(earthWorld)
      else if (stg === 'moonOrbit') origin.copy(moonWorld)
      else origin.copy(craftWorld)
    } else if (mode === 'moon') origin.copy(moonWorld)
    else origin.set(0, 0, 0)
  }

  function updateGeoLabels() {
    const camVec = tmp2.copy(camera.position).sub(earth.mesh.position)
    const camDistE = camVec.length()
    const camFromEarth = camDistE > 1e-9 ? camVec.divideScalar(camDistE) : WORLD_UP
    const horizonCos = camDistE > R_EARTH * U ? (R_EARTH * U) / camDistE : 1
    const minDot = Math.max(0.25, horizonCos + 0.0005)
    const show = mode !== 'overview' && mode !== 'landing' && earthAltKm > 3 && earthAltKm < 3500
    for (const gl of geoLabels) {
      if (!show) { gl.sprite.visible = false; continue }
      const lam = curG + gl.lonRad
      tmp.set(gl.cl * Math.cos(lam), gl.sl, -gl.cl * Math.sin(lam))
      const front = tmp.dot(camFromEarth) > minDot
      gl.sprite.visible = front
      if (front) gl.sprite.position.copy(earth.mesh.position).addScaledVector(tmp, R_EARTH * U * 1.0005)
    }
  }

  function updateCosmosVisuals() {
    const showCosmos = mode === 'moon' || mode === 'overview'
    moonOrbitGroup.visible = solarOrbitsGroup.visible = planetsGroup.visible = showCosmos
    labels.sun.visible = showCosmos
    if (!showCosmos) return

    const sunRel = tmp.copy(sunWorld).sub(origin)
    const sunCamDist = Math.max(camera.position.distanceTo(sunRel), 1)
    const sunCoreR = Math.max(695.7, sunCamDist * 0.009)
    sun.mesh.position.copy(sunRel)
    sun.mesh.scale.setScalar(sunCoreR * 6)
    sun.mesh.quaternion.copy(camera.quaternion)
    labels.sun.position.copy(sunRel).addScaledVector(WORLD_UP, sunCoreR * 1.15)

    for (const pl of planets) {
      pl.mesh.position.copy(pl.worldPos).sub(origin)
      const dCam = Math.max(camera.position.distanceTo(pl.mesh.position), 1)
      const visR = Math.max(pl.radiusKm * U, dCam * (pl.ring ? 0.007 : 0.0052))
      pl.mesh.scale.setScalar(visR)
      pl.lbl.position.copy(pl.mesh.position).addScaledVector(WORLD_UP, visR * 1.45)
    }
  }

  function updateOrigins() {
    computeOrigin()
    earth.mesh.position.copy(earthWorld).sub(origin)
    moon.position.copy(moonWorld).sub(origin)
    pathGroup.position.copy(origin).negate()
    moonOrbitGroup.position.copy(earthWorld).sub(origin)
    solarOrbitsGroup.position.copy(sunWorld).sub(origin)
    padComplex.root.position.copy(padWorld).sub(origin)
    moonPatchRoot.position.copy(sitePatchWorld).sub(origin)
    padDot.position.copy(padWorld).addScaledVector(padUp, R_EARTH * U * 0.012).sub(origin)
    activeVehicle.position.copy(vehicleWorld).sub(origin)
    plumeLight.position.copy(plumeWorld).sub(origin)
    craftLight.target.position.copy(craftWorld).sub(origin)
    craftLight.target.updateMatrixWorld()

    const camFromEarth = tmp2.copy(camera.position).sub(earth.mesh.position).normalize()
    const padFront = padUp.dot(camFromEarth) > 0.12 && earthAltKm > 20
    padDot.visible = padFront && mode === 'overview' && earthAltKm > 2500
    labels.pad.visible = padFront && (mode === 'overview' || (earthAltKm >= 3500 && mode !== 'moon'))
    updateGeoLabels()
    updateCosmosVisuals()

    labels.earth.position.copy(earth.mesh.position).add(tmp.set(0, R_EARTH * U, 0))
    labels.moon.position.copy(moon.position).add(tmp.set(0, R_MOON * U, 0))
    labels.pad.position.copy(padDot.position)
    const lblOff = Math.max(curScale * 1.65, 0.00018)
    const upVec = earthAltKm < 75 ? padUp : moonAltKm < 30 ? siteUp : WORLD_UP
    labels.craft.position.copy(craftWorld).sub(origin).addScaledVector(upVec, lblOff)
    labels.rocket.position.copy(labels.craft.position)
  }

  function snapControls() {
    const damp = controls.enableDamping
    controls.enableDamping = false
    controls.update()
    controls.enableDamping = damp
  }

  function syncCamera(forceReset = false) {
    if (!plan || mode === 'overview' || mode === 'moon' || mode === 'landing') return
    if (mode === 'craft') {
      const stg = camStage()
      const switched = forceReset || stg !== lastStage
      lastStage = stg
      if (stg === 'pad') {
        setCamUp(padUp)
        const tgtOff = 0.45 * curScale * (1 - Math.min(1, curAltKm / 5))
        controls.target.copy(padUp).multiplyScalar(tgtOff)
        const k = curAltKm < 0.25 ? 0.00032 : 0.00032 + Math.min(1, (curAltKm - 0.1) / 120) * 0.0014
        if (switched || prevChaseK === null) {
          camera.position.copy(controls.target).addScaledVector(padEast, -0.38 * k).addScaledVector(padSouth, -0.78 * k).addScaledVector(padUp, 0.42 * k)
          snapControls()
        } else if (Math.abs(k - prevChaseK) > 1e-7) {
          const off = camera.position.clone().sub(controls.target).multiplyScalar(k / prevChaseK)
          camera.position.copy(controls.target).add(off)
        }
        prevChaseK = k
      } else if (stg === 'earthOrbit') {
        if (switched) {
          setCamUp(WORLD_UP)
          controls.target.set(0, 0, 0)
          const n = axis(plan.plane.n, new THREE.Vector3()).normalize()
          const e1 = axis(plan.plane.e1, new THREE.Vector3()).normalize()
          const e2 = axis(plan.plane.e2, new THREE.Vector3()).normalize()
          const dir = e1.clone().multiplyScalar(-0.75).addScaledVector(e2, -0.35).addScaledVector(n, 0.55).normalize()
          camera.position.copy(dir.multiplyScalar(R_EARTH * U * 2.65))
          prevChaseK = null
          snapControls()
        }
      } else if (stg === 'coast') {
        if (switched) {
          setCamUp(WORLD_UP)
          controls.target.set(0, 0, 0)
          const toMoon = moonWorld.clone().sub(craftWorld)
          if (toMoon.lengthSq() < 1e-12) toMoon.set(1, 0, 0); else toMoon.normalize()
          const camSide = WORLD_UP.clone().cross(toMoon)
          if (camSide.lengthSq() < 0.01) camSide.set(1, 0, 0); else camSide.normalize()
          const dir = toMoon.clone().multiplyScalar(-0.72).addScaledVector(camSide, 0.62).addScaledVector(WORLD_UP, 0.22).normalize()
          camera.position.copy(dir.multiplyScalar(0.038))
          prevChaseK = null
          snapControls()
        }
      } else {
        if (switched) {
          setCamUp(WORLD_UP)
          controls.target.set(0, 0, 0)
          const dir = sunDir.clone().multiplyScalar(0.55).addScaledVector(siteUp, 0.65).addScaledVector(siteEast, 0.52)
          if (dir.lengthSq() < 1e-12) dir.set(1, 0.6, 1); else dir.normalize()
          camera.position.copy(dir.multiplyScalar(R_MOON * U * 2.85))
          prevChaseK = null
          snapControls()
        }
      }
      return
    }

    // mode === 'closeup' ("Fokus Roket"): frames rocket/lander up close without spinning
    const regime = earthAltKm < 185 ? 'earth' : moonAltKm < 30 ? 'moon' : 'space'
    const switched = forceReset || lastStage !== 'closeup' || regime !== lastCloseupRegime
    lastStage = 'closeup'; lastCloseupRegime = regime
    if (regime === 'earth') {
      setCamUp(padUp)
      const tgtOff = 0.45 * curScale * (1 - Math.min(1, curAltKm / 5))
      controls.target.copy(padUp).multiplyScalar(tgtOff)
      const k = 0.00026 + Math.min(1, curAltKm / 120) * 0.0012
      if (switched || prevChaseK === null) {
        camera.position.copy(controls.target).addScaledVector(padEast, -0.38 * k).addScaledVector(padSouth, -0.78 * k).addScaledVector(padUp, 0.42 * k)
        snapControls()
      } else if (Math.abs(k - prevChaseK) > 1e-7) {
        const off = camera.position.clone().sub(controls.target).multiplyScalar(k / prevChaseK)
        camera.position.copy(controls.target).add(off)
      }
      prevChaseK = k
    } else if (regime === 'moon') {
      setCamUp(siteUp)
      controls.target.set(0, 0, 0)
      const k = 0.00016 + Math.min(1, curAltKm / 25) * 0.005
      if (switched || prevChaseK === null) {
        camera.position.copy(siteEast).multiplyScalar(0.75 * k).addScaledVector(siteSouth, 0.55 * k).addScaledVector(siteUp, 0.35 * k)
        snapControls()
      } else if (Math.abs(k - prevChaseK) > 1e-7) {
        const off = camera.position.clone().sub(controls.target).multiplyScalar(k / prevChaseK)
        camera.position.copy(controls.target).add(off)
      }
      prevChaseK = k
    } else {
      setCamUp(WORLD_UP)
      controls.target.set(0, 0, 0)
      if (switched) {
        const toMoon = moonWorld.clone().sub(craftWorld)
        if (toMoon.lengthSq() < 1e-12) toMoon.set(1, 0, 0); else toMoon.normalize()
        const side = WORLD_UP.clone().cross(toMoon)
        if (side.lengthSq() < 0.01) side.set(1, 0, 0); else side.normalize()
        camera.position.copy(toMoon.multiplyScalar(-0.72).addScaledVector(side, 0.62).addScaledVector(WORLD_UP, 0.22).normalize().multiplyScalar(0.030))
        prevChaseK = null
        snapControls()
      }
    }
  }

  function updateVisibility() {
    const autoLanding = (mode === 'craft' || mode === 'closeup') && !!curState && ((curState.phase === 'descent' && (curState.rem ?? 99) <= 10.2) || curState.phase === 'landed')
    renderer.domElement.hidden = !visible || mode === 'landing' || autoLanding
  }

  function updateCelestialSpin() {
    if (!plan) return
    const sunSec = Math.max(0, (lastT - J2000_MS) / 1000)
    // True astronomical Sun direction from ephemeris at time `lastT` (with Moon parallax in Moon POV)
    if (mode === 'moon') {
      sunDir.copy(sunWorld).sub(moonWorld).normalize()
    } else {
      sunDir.copy(baseSunDir).normalize()
    }
    earth.uniforms.sunDir.value.copy(baseSunDir).normalize()
    sunLight.position.copy(sunDir).multiplyScalar(20000)
    // Sun axial rotation around its own pole: Carrington sidereal period (25.38 days) + subtle live axial drift
    const sunAxialSpin = (sunSec / (25.38 * 86400)) * Math.PI * 2 + animSpin * 0.04
    sun.update({ dir: sunDir, dist: 30000, pose: { sunR: 0.267 }, k: 4, dim: 1, camera, spin: sunAxialSpin })
    if (mode === 'moon' || mode === 'overview') updateCosmosVisuals()

    // Earth axial rotation: `baseG` already has the exact Greenwich Sidereal Time for `lastT`.
    // Only add real-time sidereal rotation (7.2921159e-5 rad/s) when viewing from space while time is paused/1x.
    const earthSpinW = mode === 'overview' || mode === 'moon' ? 1 : THREE.MathUtils.smoothstep(earthAltKm, 6, 32)
    curG = baseG + earthSpinW * (animSpin * 7.2921159e-5)
    orientSphere(earth.mesh, axisArr([Math.cos(curG), Math.sin(curG), 0]), axisArr([-Math.sin(curG), Math.cos(curG), 0]), axisArr([0, 0, 1]))
  }

  function setTime(t, opts = {}) {
    if (!plan) return
    const timelineDriven = !!opts.timelineDriven
    isTimelineDriven = timelineDriven
    if (timelineDriven) smoke.clear()
    const jumped = Math.abs(t - lastT) > 90e3
    lastT = t
    const astroT = A.MakeTime(new Date(t))
    if (!solarOrbitsBuilt) rebuildSolarOrbits(t)
    if (!Number.isFinite(lastMoonOrbitT) || Math.abs(t - lastMoonOrbitT) > 6 * 3600e3) rebuildMoonOrbit(t)

    const c = craftPosition(plan, t, site)
    curState = c.s
    toScene(c.moon, moonWorld); toScene(c.pos, craftWorld)
    const dtAhead = c.s.phase === 'ascent' ? 20e3 : 120e3
    toScene(craftPosition(plan, t + dtAhead, site).pos, aheadWorld)

    // Earth & Pad basis (+X = East, +Y = Up, +Z = South)
    baseG = A.SiderealTime(astroT) * 15 * Math.PI / 180
    const pVec = padVec(plan.pad, t)
    axis(pVec, padUp).normalize()
    padEast.set(0, 1, 0).cross(padUp).normalize()
    padSouth.copy(padEast).cross(padUp).normalize()
    padComplex.root.quaternion.setFromRotationMatrix(mat4.makeBasis(padEast, padUp, padSouth))
    padWorld.copy(padUp).multiplyScalar(R_EARTH * U)

    // Moon & Site Patch basis
    const ax = moonAxes(new Date(t))
    orientSphere(moon, axisArr(ax.x), axisArr(ax.y), axisArr(ax.z))
    const la = site.lat * Math.PI / 180, lo = site.lon * Math.PI / 180
    const cl = Math.cos(la), sl = Math.sin(la), clo = Math.cos(lo), slo = Math.sin(lo)
    const mUp = [0, 1, 2].map((i) => ax.x[i] * cl * clo + ax.y[i] * cl * slo + ax.z[i] * sl)
    const mEast = [0, 1, 2].map((i) => -ax.x[i] * slo + ax.y[i] * clo)
    axis(mUp, siteUp).normalize()
    axis(mEast, siteEast).normalize()
    siteSouth.copy(siteEast).cross(siteUp).normalize()
    moonPatchRoot.quaternion.setFromRotationMatrix(mat4.makeBasis(siteEast, siteUp, siteSouth))
    sitePatchWorld.copy(moonWorld).addScaledVector(siteUp, R_MOON * U)

    // Sun & Solar System planets (geocentric J2000 equatorial -> scene)
    const sv = A.GeoVector(A.Body.Sun, astroT, false)
    sunWorld.set(sv.x * AU_U, sv.z * AU_U, -sv.y * AU_U)
    baseSunDir.copy(sunWorld).normalize()
    for (const pl of planets) {
      const pv = A.GeoVector(pl.body, astroT, false)
      pl.worldPos.set(pv.x * AU_U, pv.z * AU_U, -pv.y * AU_U)
    }

    earthAltKm = Math.max(0, craftWorld.length() / U - R_EARTH)
    moonAltKm = Math.max(0, craftWorld.distanceTo(moonWorld) / U - R_MOON)
    curAltKm = Math.min(earthAltKm, moonAltKm)
    updateCelestialSpin()

    // Slightly tuck coarse Earth sphere polygons under local high-res pad beach terrain at low altitude
    earth.mesh.scale.setScalar(R_EARTH * U * (earthAltKm < 8 ? 0.9998 : 1))
    moon.scale.setScalar(1)
    const preLaunchTimeline = timelineDriven && t < plan.launch
    padComplex.root.visible = !preLaunchTimeline && earthAltKm < 35
    moonPatchRoot.visible = moonAltKm < 800 || mode === 'moon'

    // Vehicle stages & separation
    const ph = c.s.phase, k = c.s.k || 0, postTliSec = (t - plan.tli) / 1000
    const inStage2Sep = ph === 'coast' && postTliSec >= 0 && postTliSec < 480
    const onStack = !preLaunchTimeline && (ph === 'ascent' || ph === 'leo' || ph === 'tli' || inStage2Sep)
    stack.root.visible = labels.rocket.visible = onStack
    soloCraft.group.visible = labels.craft.visible = !preLaunchTimeline && !onStack
    activeVehicle = onStack ? stack.root : soloCraft.group

    if (jumped || timelineDriven) smoke.clear()
    computeOrigin()
    if (!timelineDriven) syncCamera(jumped)

    const stgNow = mode === 'craft' ? camStage() : null
    const scaleMult = mode === 'closeup' || stgNow === 'coast' || (stgNow === 'pad' && curAltKm > 20) ? 0.058 : 0.038
    const craftRel = tmp.copy(craftWorld).sub(origin)
    const camDist = Math.max(camera.position.distanceTo(craftRel), controls.minDistance)
    const altBlend = Math.min(1, curAltKm / 55)
    const baseLocal = ph === 'landed' || (c.s.ref === 'moon' && curAltKm < 25) ? 0.000065 : 0.00012
    curScale = THREE.MathUtils.lerp(baseLocal, Math.max(camDist * scaleMult, 0.0004), altBlend)
    activeVehicle.scale.setScalar(curScale)

    // Update craftLight from camera-sun blend so rocket, stages, and beach pad stay legible
    const lightDir = camera.position.clone().sub(controls.target)
    if (lightDir.lengthSq() < 1e-12) lightDir.copy(WORLD_UP)
    else lightDir.normalize()
    lightDir.multiplyScalar(0.55).addScaledVector(sunDir, 0.45).addScaledVector(WORLD_UP, 0.35).normalize()
    craftLight.position.copy(craftRel).addScaledVector(lightDir, 5)

    // Keep liftoff base cleanly on pad table & touchdown cleanly on footpads
    vehicleWorld.copy(craftWorld)
    if (ph === 'ascent' && c.s.alt < 0.5) vehicleWorld.addScaledVector(padUp, PAD_H_U * (1 - c.s.alt / 0.5))
    if (ph === 'landed' || (ph === 'descent' && c.s.alt < 0.1)) {
      const wLand = ph === 'landed' ? 1 : 1 - c.s.alt / 0.1
      vehicleWorld.addScaledVector(siteUp, 0.52 * curScale * wLand)
    }

    // Determine +Z forward/up orientation and level horizontal solar-panel reference without crooked roll
    const velDir = aheadWorld.clone().sub(craftWorld)
    if (velDir.lengthSq() < 1e-16) velDir.copy(ph === 'landed' ? siteUp : padUp)
    else velDir.normalize()

    const radialEarth = craftWorld.clone().normalize()
    let dir = velDir.clone(), upRef = WORLD_UP
    if (onStack) {
      if (ph === 'ascent') {
        const dt = c.s.dt ?? k * 540
        if (dt <= 5) dir.copy(padUp)
        else if (dt < 25) dir.copy(padUp).lerp(velDir, (dt - 5) / 20).normalize()
        upRef = padSouth.clone().negate().lerp(radialEarth, Math.min(1, Math.max(0, (dt - 8) / 17))).normalize()
      } else if (ph === 'leo' || ph === 'tli') {
        dir.copy(velDir)
        upRef = radialEarth
      } else {
        dir.copy(moonWorld).sub(craftWorld).normalize()
        upRef = WORLD_UP
      }
    } else if (mode === 'closeup' && moonAltKm < 30) {
      dir.copy(siteUp)
      if (ph === 'descent') dir.addScaledVector(velDir, -0.18).normalize()
      upRef = siteSouth.clone().negate()
    } else {
      // Keep the lunar lander upright (+Z top cap up, -Z landing legs down, ±X solar panels horizontal)
      dir.copy(WORLD_UP)
      if (ph === 'loi' || ph === 'descent') dir.addScaledVector(velDir, -0.18).normalize()
      else if (ph === 'coast' || ph === 'llo') dir.addScaledVector(velDir, 0.12).normalize()
      const camDir = tmp2.copy(camera.position).sub(craftRel)
      camDir.y = 0
      if (camDir.lengthSq() < 1e-8) camDir.set(0, 0, 1)
      else camDir.normalize()
      upRef = camDir
    }

    lastCraftDir.copy(dir)
    activeVehicle.quaternion.copy(dirFromLook(dir, upRef))

    if (onStack) {
      // Side Boosters: attached 0..0.30 ascent, peel radially outward (Korolev Cross / twin peel)
      const sepB = ph === 'ascent' && k >= 0.30 ? Math.min(1, (k - 0.30) / 0.24) : 0
      const activeBoosters = stack.boosterCount
      for (const b of stack.boosters) {
        const enabled = ph === 'ascent' && (activeBoosters === 4 || b.isTwin)
        b.group.visible = enabled
        b.flame.visible = enabled && k < 0.30
        if (enabled) {
          const rDist = b.baseR + 1.15 * sepB
          b.group.position.set(b.ca * rDist, b.sa * rDist, 0.02 - 4.2 * sepB * sepB)
          b.group.rotation.set(-b.sa * 0.85 * sepB, b.ca * 0.85 * sepB, 0)
        }
      }

      // Stage 1 core: detaches cleanly at k >= 0.50 after side boosters fall away
      const sep1 = ph === 'ascent' && k >= 0.50 ? Math.min(1, (k - 0.50) / 0.32) : 0
      stack.stage1.visible = ph === 'ascent'
      stack.stage1.position.set(0, 0, -4.5 * sep1 * sep1)
      stack.stage1.rotation.set(0.45 * sep1, 0.25 * sep1, 0)
      stack.flame1.visible = ph === 'ascent' && k < 0.50

      // Fairing halves jettison at k >= 0.66 during ascent
      const openF = ph === 'ascent' && k >= 0.66 ? Math.min(1, (k - 0.66) / 0.26) : 0
      stack.fairingL.visible = stack.fairingR.visible = ph === 'ascent'
      stack.fairingL.position.set(-1.2 * openF, 0, 1.02 - 2.8 * openF * openF)
      stack.fairingL.rotation.set(0, -1.1 * openF, 0)
      stack.fairingR.position.set(1.2 * openF, 0, 1.02 - 2.8 * openF * openF)
      stack.fairingR.rotation.set(0, 1.1 * openF, 0)

      // Stage 2: fires after Stage 1 sep & during TLI, separates visibly over 8 min into coast
      const sep2 = inStage2Sep ? Math.min(1, postTliSec / 420) : 0
      stack.stage2.position.set(0, -0.35 * sep2 * sep2, 0.68 - 2.8 * sep2 * sep2)
      stack.stage2.rotation.set(-0.4 * sep2, 0.22 * sep2, 0)
      stack.flame2.visible = (ph === 'ascent' && k >= 0.50) || ph === 'tli'

      // Stowed lander unfolds horizontal solar panels once detached from Stage 2
      const panelDeploy = inStage2Sep ? Math.min(1, 0.08 + Math.max(0, (sep2 - 0.15) / 0.7) * 0.92) : 0.08
      stack.lander.panels.scale.set(panelDeploy, 1, 1)
      stack.lander.group.scale.setScalar(inStage2Sep ? THREE.MathUtils.lerp(0.17, 0.42, Math.min(1, sep2 * 1.3)) : 0.17)
      stack.lander.flame.visible = false
    } else {
      soloCraft.panels.scale.set(1, 1, 1)
      soloCraft.flame.visible = !timelineDriven && (ph === 'loi' || (ph === 'descent' && moonAltKm < 15))
    }

    padComplex.update(padUp.dot(sunDir), earthAltKm, k, ph)

    const burning = !timelineDriven && (ph === 'ascent' || ph === 'tli' || ph === 'loi' || ph === 'descent')
    const nearPadSurface = ph === 'ascent' && earthAltKm < 2.5
    const nearMoonSurface = (ph === 'descent' || ph === 'landed') && moonAltKm < 2.5
    const inDark = (nearPadSurface && padUp.dot(sunDir) < 0.12) || (nearMoonSurface && siteUp.dot(sunDir) < 0.12)
    if (burning && nearPadSurface) {
      plumeWorld.copy(padWorld).addScaledVector(padUp, Math.max(0.25 * curScale, PAD_H_U))
    } else if (burning && nearMoonSurface) {
      plumeWorld.copy(vehicleWorld).addScaledVector(lastCraftDir, -0.55 * curScale)
    } else {
      plumeWorld.copy(vehicleWorld)
    }
    plumeLight.distance = 0.0022
    plumeLight.color.setHex(burning ? 0xff9f45 : 0xffe4b0)
    basePlumeIntensity = !timelineDriven && inDark && (nearPadSurface || nearMoonSurface) ? (burning ? 4.8 : 2.0) : 0
    plumeLight.intensity = basePlumeIntensity

    let n = 0
    while (n < pathT.length && pathT[n] <= t) n++
    done.geometry.setDrawRange(0, Math.max(0, n))

    updateOrigins()
    updateVisibility()
  }

  function setMode(m) {
    mode = m
    lastStage = null
    lastCloseupRegime = null
    prevChaseK = null
    const wide = m === 'moon' || m === 'overview'
    camera.far = wide ? 5e7 : 60000
    camera.updateProjectionMatrix()
    controls.maxDistance = wide ? 4e6 : 6000
    controls.minDistance = m === 'moon' ? 2.4 : 4e-5
    updateVisibility()
    if (!plan || m === 'landing') return
    if (!renderer.domElement.hidden) resize()
    if (m === 'overview') {
      setCamUp(WORLD_UP)
      origin.set(0, 0, 0)
      const mA = toScene(craftPosition(plan, plan.arrive, site).moon), mB = toScene(craftPosition(plan, plan.arrive - 3600e3, site).moon)
      const n = mB.clone().cross(mA).normalize(), e2 = n.clone().cross(mA.clone().normalize())
      const pts = [new THREE.Vector3(), mA]
      for (let k = 0; k <= 12; k++) pts.push(toScene(craftPosition(plan, plan.launch + ((plan.arrive - plan.launch) * k) / 12, site).moon))
      const pos = path.geometry.attributes.position
      for (let i = 0; i < pos.count; i += 10) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i))
      const box = new THREE.Box3().setFromPoints(pts), center = box.getCenter(new THREE.Vector3())
      const radius = Math.max(...pts.map((q) => q.distanceTo(center)))
      const vfov = (camera.fov * Math.PI) / 180, hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect)
      const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05
      controls.target.copy(center)
      camera.position.copy(center).addScaledVector(n.clone().multiplyScalar(1.15).addScaledVector(e2, -0.5).normalize(), dist)
      updateOrigins()
      snapControls()
    } else if (m === 'moon') {
      setCamUp(WORLD_UP)
      origin.copy(moonWorld)
      controls.target.set(0, 0, 0)
      const toEarth = earthWorld.clone().sub(moonWorld)
      if (toEarth.lengthSq() < 1e-6) toEarth.set(1, 0, 0); else toEarth.normalize()
      const side = WORLD_UP.clone().cross(toEarth)
      if (side.lengthSq() < 1e-4) side.set(0, 0, 1); else side.normalize()
      const camDir = toEarth.clone().multiplyScalar(-0.88).addScaledVector(side, 0.36).addScaledVector(WORLD_UP, 0.31).normalize()
      camera.position.copy(camDir.multiplyScalar(R_MOON * U * 6.5))
      updateOrigins()
      snapControls()
    } else {
      computeOrigin()
      syncCamera(true)
      updateOrigins()
    }
  }

  function resize() {
    const w = el.clientWidth, h = el.clientHeight
    if (!w || !h) return
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(el)

  let lastAnim = performance.now()
  function frame() {
    if (!visible || renderer.domElement.hidden) return
    const now = performance.now(), dt = Math.min(0.05, Math.max(0.001, (now - lastAnim) / 1000))
    lastAnim = now
    animSpin += dt

    if ((mode === 'craft' || mode === 'closeup') && curState) {
      syncCamera(false)
    }

    controls.update()
    updateCelestialSpin()
    updateGeoLabels()
    if (curState) padComplex.update(padUp.dot(sunDir), earthAltKm, curState.k || 0, curState.phase)

    // Emit live flame-trench steam, exhaust trails, staging cold-gas & lunar regolith dust
    if (curState && !isTimelineDriven) {
      const ph = curState.phase, k = curState.k || 0, postTliSec = (lastT - plan.tli) / 1000
      const flicker = 0.88 + Math.random() * 0.24
      if (stack.flame1.visible) stack.flame1.scale.set(1, 1, flicker)
      for (const b of stack.boosters) if (b.flame.visible) b.flame.scale.set(1, 1, flicker)
      if (stack.flame2.visible) stack.flame2.scale.set(1, 1, flicker)
      if (soloCraft.flame.visible) soloCraft.flame.scale.set(1, 1, flicker)
      if (basePlumeIntensity > 0) plumeLight.intensity = basePlumeIntensity * (0.9 + 0.18 * (flicker - 0.88))

      if (ph === 'ascent' && curState.alt < 45) {
        // Billowing pad clouds & ascent exhaust trail
        const count = curState.alt < 1.5 ? 5 : 2
        for (let i = 0; i < count; i++) {
          const isTrench = curState.alt < 1.2 && Math.random() < 0.65
          const wPos = isTrench
            ? padWorld.clone().addScaledVector(padEast, 18 * M_TO_U * Math.random()).addScaledVector(padUp, 2 * M_TO_U)
            : craftWorld.clone().addScaledVector(padUp, -15 * M_TO_U)
          const vel = isTrench
            ? padEast.clone().multiplyScalar((80 + Math.random() * 140) * M_TO_U).addScaledVector(padSouth, smoke.rnd() * 90 * M_TO_U).addScaledVector(padUp, (25 + Math.random() * 35) * M_TO_U)
            : padUp.clone().multiplyScalar(-90 * M_TO_U).addScaledVector(padEast, smoke.rnd() * 35 * M_TO_U).addScaledVector(padSouth, smoke.rnd() * 35 * M_TO_U)
          const warm = isTrench && Math.random() < 0.35
          smoke.emit({
            world: wPos, vel,
            s0: 14 * M_TO_U, s1: (isTrench ? 140 : 190) * M_TO_U,
            life: isTrench ? 2.4 : 1.6,
            color: warm ? [1.0, 0.72, 0.42] : [0.92, 0.93, 0.96],
          })
        }
      } else if ((ph === 'ascent' && ((k >= 0.30 && k < 0.36) || (k >= 0.50 && k < 0.57) || (k >= 0.66 && k < 0.73))) || (ph === 'coast' && postTliSec >= 0 && postTliSec < 120)) {
        // Cold-gas puffs around stage/fairing separation plane
        for (let i = 0; i < 2; i++) {
          const dir = tmp2.set(smoke.rnd(), smoke.rnd(), smoke.rnd()).normalize()
          smoke.emit({ world: craftWorld.clone(), vel: dir.multiplyScalar(curScale * 1.4), s0: curScale * 0.14, s1: curScale * 0.95, life: 1.2, color: [0.85, 0.92, 1.0] })
        }
      } else if (ph === 'descent' && curState.alt < 15) {
        // Radial lunar regolith dust plume kicking up from surface under lander
        const surfaceW = sitePatchWorld.clone()
        for (let i = 0; i < 4; i++) {
          const a = Math.random() * Math.PI * 2
          const rad = siteEast.clone().multiplyScalar(Math.cos(a)).addScaledVector(siteSouth, Math.sin(a))
          smoke.emit({
            world: surfaceW.clone().addScaledVector(rad, 15 * M_TO_U).addScaledVector(siteUp, 3 * M_TO_U),
            vel: rad.clone().multiplyScalar((75 + Math.random() * 90) * M_TO_U).addScaledVector(siteUp, (14 + Math.random() * 18) * M_TO_U),
            s0: 16 * M_TO_U, s1: 115 * M_TO_U, life: 1.9, color: [0.76, 0.72, 0.65],
          })
        }
      }
      smoke.step(dt, origin, el.clientHeight)
    }

    sun.mesh.quaternion.copy(camera.quaternion)
    stars.position.copy(camera.position)
    renderer.render(scene, camera)
  }
  renderer.setAnimationLoop(frame)

  function show(on) {
    visible = on
    updateVisibility()
    if (on) { resize(); if (plan) { setTime(lastT || plan.launch); setMode(mode) } }
  }

  const onScreen = () => ({
    moonOk: !Number.isNaN(moon.quaternion.x) && moon.visible,
    earthOk: !Number.isNaN(earth.mesh.quaternion.x) && earth.mesh.visible,
    camAlt: +((camera.position.distanceTo(earth.mesh.position) - R_EARTH * U) * 1000).toFixed(0),
    camMoonAlt: +((camera.position.distanceTo(moon.position) - R_MOON * U) * 1000).toFixed(0),
    plumeIntensity: +plumeLight.intensity.toFixed(2),
    padDotVisible: padDot.visible,
    planetsVisible: planetsGroup.visible,
    moonOrbitVisible: moonOrbitGroup.visible,
    solarOrbitsVisible: solarOrbitsGroup.visible,
    planets: planets.map((p) => {
      const pv = p.mesh.position.clone().project(camera)
      return [p.name, p.mesh.visible, p.lbl.visible, +pv.x.toFixed(3), +pv.y.toFixed(3), pv.z < 1]
    }),
    sunDir: [+sunDir.x.toFixed(4), +sunDir.y.toFixed(4), +sunDir.z.toFixed(4)],
    moonQuatY: +moon.quaternion.y.toFixed(5),
    ...Object.fromEntries([['earth', earth.mesh], ['moon', moon], ['sun', sun.mesh], ['craft', activeVehicle], ['pad', padDot]].map(([k, o]) => {
      const v = o.position.clone().project(camera)
      return [k, [+v.x.toFixed(3), +v.y.toFixed(3), v.z < 1]]
    })),
  })

  return { setPlan, setTime, setMode, show, onScreen, frame, get visible() { return visible } }
}
