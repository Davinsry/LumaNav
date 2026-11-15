// Earth and Sun as they appear from the lunar surface.
// Earth: textured sphere (NASA Blue Marble NG + Black Marble city lights) lit by the real Sun
// direction, so its phase is correct; oriented by Greenwich sidereal time so the right side
// faces the Moon. Sun: camera-facing disc with limb darkening and a corona glow.
import * as THREE from 'three'

const D = Math.PI / 180

export function makeEarth() {
  const loader = new THREE.TextureLoader()
  const tex = (url) => {
    const t = loader.load(url)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 16
    return t
  }
  const uniforms = {
    dayMap: { value: tex('./textures/earth_day.jpg') },
    nightMap: { value: tex('./textures/earth_night.jpg') },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    dim: { value: 1 },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv; varying vec3 vN; varying vec3 vP;
      void main() {
        vUv = uv;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D dayMap, nightMap; uniform vec3 sunDir; uniform float dim;
      varying vec2 vUv; varying vec3 vN; varying vec3 vP;
      float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
      float noise2(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float scoreLand(vec3 lin) {
        vec3 s = sqrt(max(lin, vec3(0.0)));
        float dom = max(s.g - s.b * 0.82, s.r - s.b * 0.72);
        float bright = smoothstep(0.085, 0.155, max(s.r, s.g));
        return dom * bright - (1.0 - bright) * 0.025;
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec3 N = normalize(vN);
        float l = dot(N, sunDir);
        float n1 = noise2(vUv * vec2(520.0, 260.0));
        float n2 = noise2(vUv * vec2(1600.0, 800.0));
        float n3 = noise2(vUv * vec2(4200.0, 2100.0));
        float n4 = noise2(vUv * vec2(9600.0, 4800.0));
        float n5 = noise2(vUv * vec2(20000.0, 10000.0));
        float fbm = n1 * 0.38 + n2 * 0.28 + n3 * 0.18 + n4 * 0.10 + n5 * 0.06;
        vec2 uvWarp = vUv + vec2(n1 - 0.5, n2 - 0.5) * 0.0015 + vec2(n3 - 0.5, n4 - 0.5) * 0.00045;
        vec3 day = texture2D(dayMap, uvWarp).rgb;
        vec3 night = texture2D(nightMap, vUv).rgb;
        float rawScore = scoreLand(day);
        float warpedScore = rawScore + (fbm - 0.50) * 0.042;
        float landMask = smoothstep(0.004, 0.016, warpedScore);
        float shelfMask = smoothstep(-0.022, 0.004, warpedScore) * (1.0 - landMask);
        float beachMask = smoothstep(0.002, 0.009, warpedScore) * (1.0 - smoothstep(0.009, 0.022, warpedScore));
        float coastMask = landMask * (1.0 - smoothstep(0.02, 0.14, rawScore));
        float e = 0.0006;
        float s1 = smoothstep(0.004, 0.016, scoreLand(texture2D(dayMap, uvWarp + vec2(e, 0.0)).rgb) + (fbm - 0.50) * 0.042);
        float s2 = smoothstep(0.004, 0.016, scoreLand(texture2D(dayMap, uvWarp - vec2(e, 0.0)).rgb) + (fbm - 0.50) * 0.042);
        float s3 = smoothstep(0.004, 0.016, scoreLand(texture2D(dayMap, uvWarp + vec2(0.0, e * 2.0)).rgb) + (fbm - 0.50) * 0.042);
        float s4 = smoothstep(0.004, 0.016, scoreLand(texture2D(dayMap, uvWarp - vec2(0.0, e * 2.0)).rgb) + (fbm - 0.50) * 0.042);
        float gradEdge = clamp((abs(s1 - landMask) + abs(s2 - landMask) + abs(s3 - landMask) + abs(s4 - landMask)) * 1.15, 0.0, 1.0);
        float coastEdge = clamp(max(gradEdge, beachMask * 0.9), 0.0, 1.0);
        float latW = smoothstep(0.45, 0.12, abs(vUv.y - 0.5));
        float rawNight = max(night.r, max(night.g, night.b * 0.5));
        float city = pow(smoothstep(0.012, 0.28, rawNight), 0.65);
        float towns = smoothstep(0.78, 0.94, n3 * 0.45 + n4 * 0.35 + n5 * 0.20) * smoothstep(0.52, 0.82, n1 * 0.6 + n2 * 0.4);
        float procCity = landMask * latW * (0.25 + 0.75 * coastMask) * towns * 0.65;
        float totalCity = clamp(max(city * 1.25, procCity), 0.0, 1.0);
        float dayW = smoothstep(-0.05, 0.15, l);
        float nightW = 1.0 - dayW;
        float sunlit = max(l, 0.0);
        float ridge = 1.0 - abs(n2 * 1.1 + n3 * 0.7 + n4 * 0.4 - 1.1);
        ridge = clamp(ridge * ridge, 0.0, 1.0);
        float landRelief = 0.68 + 0.48 * fbm + 0.28 * ridge;
        vec3 dayLand = mix(day, vec3(0.045, 0.135, 0.052) * landRelief, 0.35) * (0.85 + 0.35 * landRelief);
        vec3 dayOcean = day + vec3(0.02, 0.16, 0.22) * shelfMask * 0.55;
        vec3 dayBoost = mix(dayOcean, dayLand, landMask) + vec3(0.26, 0.54, 0.42) * coastEdge * 0.38;
        vec3 nightOcean = vec3(0.005, 0.016, 0.038) + vec3(0.016, 0.068, 0.092) * shelfMask;
        vec3 nightLand = vec3(0.022, 0.078, 0.034) * landRelief + vec3(0.028, 0.068, 0.026) * ridge + day * 0.35;
        vec3 nightSurface = (mix(nightOcean, nightLand, landMask) + vec3(0.26, 0.62, 0.48) * coastEdge * 0.72) * nightW;
        vec3 nightLights = (vec3(1.0, 0.76, 0.38) * totalCity * 1.25 + vec3(1.0, 0.95, 0.82) * pow(totalCity, 2.5) * 0.80) * nightW;
        vec3 col = dayBoost * sunlit * 1.9 + vec3(0.05, 0.11, 0.24) * sunlit + nightSurface + nightLights;
        // Thin atmosphere: blue rim, brightest on the sunlit limb.
        vec3 V = normalize(cameraPosition - vP);
        float rim = pow(1.0 - max(dot(N, V), 0.0), 2.5);
        col += vec3(0.25, 0.5, 1.0) * rim * smoothstep(-0.25, 0.3, l);
        gl_FragColor = vec4(col * dim, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), mat)

  // dir: unit vector to Earth (scene frame); pose from astro.skyPose; k: on-screen size factor
  function update({ dir, dist, pose, sunDir, k, dim }) {
    mesh.position.copy(dir).multiplyScalar(dist)
    mesh.scale.setScalar(dist * Math.tan(pose.earthR * k * D))
    orientSphere(mesh, pose.x, pose.y, pose.z)
    uniforms.sunDir.value.copy(sunDir)
    uniforms.dim.value = dim
  }
  return { mesh, update, uniforms }
}

// Orient an equirect-textured SphereGeometry so its texture matches a body-fixed frame.
// x/y/z: the body's axes (prime meridian, 90°E, north pole) expressed in scene coordinates.
// SphereGeometry: +X = longitude 0, −Z = 90°E, +Y = north.
const _m = new THREE.Matrix4(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3()
export function orientSphere(mesh, x, y, z) {
  _a.fromArray(x); _b.fromArray(z); _c.fromArray(y).negate()
  mesh.quaternion.setFromRotationMatrix(_m.makeBasis(_a, _b, _c))
}

export function makeSun() {
  const RATIO = 6 // quad half-size in solar radii (room for the corona)
  const uniforms = { dim: { value: 1 }, uTime: { value: 0 }, uSpin: { value: 0 } }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float dim, uTime, uSpin; varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = (vUv - 0.5) * 2.0 * ${RATIO.toFixed(1)}; // in solar radii
        float r = length(p);
        vec4 c;
        if (r < 1.0) {
          // Limb darkening: the edge is dimmer and redder than the centre.
          float mu = sqrt(1.0 - r * r);
          vec3 ld = vec3(pow(mu, 0.45), pow(mu, 0.65), pow(mu, 0.95));
          // 3D spherical axial rotation around the solar north-south pole (porosnya) with differential rotation.
          float lat = asin(clamp(p.y, -1.0, 1.0));
          float diffSpin = uSpin * (1.0 - 0.18 * sin(lat) * sin(lat));
          float lon = atan(p.x, mu) - diffSpin;
          vec2 ring = vec2(cos(lon), sin(lon)) * cos(lat);
          vec2 sp1 = vec2(ring.x * 9.0 + ring.y * 4.0, lat * 9.0 + ring.y * 3.0);
          vec2 sp2 = vec2(ring.y * 19.0 - ring.x * 7.0, lat * 19.0 + ring.x * 5.0);
          float gran = 0.6 * vnoise(sp1 + vec2(uTime * 0.03, -uTime * 0.02))
                     + 0.4 * vnoise(sp2 - vec2(uTime * 0.04, uTime * 0.03));
          float activeBand = exp(-pow((abs(lat) - 0.32) / 0.18, 2.0));
          float spotMask = smoothstep(0.74, 0.86, vnoise(sp1 * 0.65 + vec2(3.7, 1.9))) * activeBand;
          float surface = clamp(0.88 + 0.24 * gran - 0.26 * spotMask, 0.55, 1.18);
          c = vec4(vec3(1.0, 0.9, 0.74) * ld * surface * 1.25, 1.0);
        } else {
          float ang = atan(p.y, p.x);
          float rays = 0.90 + 0.10 * sin(ang * 12.0 + uTime * 0.12) * cos(ang * 7.0 - uTime * 0.08);
          float glow = 0.9 * pow(r, -2.6) * rays * (1.0 - smoothstep(${(RATIO * 0.6).toFixed(1)}, ${RATIO.toFixed(1)}, r));
          c = vec4(vec3(1.0, 0.86, 0.62) * glow, clamp(glow, 0.0, 1.0));
        }
        gl_FragColor = vec4(c.rgb * dim, c.a * dim);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat)

  function update({ dir, dist, pose, k, dim, camera, spin }) {
    mesh.position.copy(dir).multiplyScalar(dist)
    mesh.scale.setScalar(dist * Math.tan(pose.sunR * k * D) * RATIO)
    mesh.quaternion.copy(camera.quaternion) // billboard
    uniforms.dim.value = dim
    uniforms.uTime.value = performance.now() * 0.001
    uniforms.uSpin.value = spin !== undefined ? spin : performance.now() * 0.00004
  }
  return { mesh, update, uniforms }
}

/**
 * Shared 3D Lunar Lander (~1 unit tall, thrust axis along +Z, footpads at z = -0.52).
 * Used in both the ground-to-Moon simulation (`space.js`) and landed site view (`scene.js`).
 */
export function makeLanderModel() {
  const group = new THREE.Group()
  const foil = new THREE.MeshStandardMaterial({ color: 0xd8b25a, metalness: 0.65, roughness: 0.32 })
  const grey = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.45, roughness: 0.45 })
  const padMat = new THREE.MeshStandardMaterial({ color: 0x7a828c, metalness: 0.5, roughness: 0.5 })
  const bellMat = new THREE.MeshStandardMaterial({ color: 0x454c56, metalness: 0.6, roughness: 0.4, side: THREE.DoubleSide })
  const pvMat = new THREE.MeshStandardMaterial({ color: 0x1b3a73, metalness: 0.35, roughness: 0.35, emissive: 0x09162e })
  const tankMat = new THREE.MeshStandardMaterial({ color: 0xd9dfe6, metalness: 0.25, roughness: 0.4 })

  // Descent stage (octagonal foil bus) & upper avionics/ascent stage
  const descent = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.34, 8), foil)
  descent.rotation.x = Math.PI / 2; descent.position.z = -0.14; group.add(descent)

  const ascent = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.32, 0.22, 10), grey)
  ascent.rotation.x = Math.PI / 2; ascent.position.z = 0.14; group.add(ascent)

  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.24, 0.12, 10), foil)
  cap.rotation.x = Math.PI / 2; cap.position.z = 0.31; group.add(cap)

  // Propellant side tanks + high-gain dish antenna + RCS quads
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2
    const tank = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), tankMat)
    tank.position.set(Math.cos(a) * 0.31, Math.sin(a) * 0.31, -0.06)
    group.add(tank)

    const rcs = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), padMat)
    rcs.position.set(Math.cos(a + Math.PI / 4) * 0.29, Math.sin(a + Math.PI / 4) * 0.29, 0.2)
    group.add(rcs)
  }

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 6), grey)
  mast.rotation.x = Math.PI / 2; mast.position.set(0.08, 0.1, 0.42); group.add(mast)
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.02, 0.04, 14, 1, true), tankMat)
  dish.rotation.x = Math.PI / 2 + 0.35; dish.position.set(0.08, 0.12, 0.49); group.add(dish)
  const tracker = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.03, 0.07, 8), foil)
  tracker.rotation.x = Math.PI / 2 - 0.35; tracker.position.set(-0.09, -0.07, 0.39); group.add(tracker)

  // Deployable solar panel wings (can fold/unfold in space.js)
  const panels = new THREE.Group()
  for (const sgn of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 6), grey)
    arm.rotation.z = Math.PI / 2; arm.position.set(sgn * 0.34, 0, 0.12); panels.add(arm)
    const hinge = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.036, 0.05), foil)
    hinge.position.set(sgn * 0.43, 0, 0.12); panels.add(hinge)
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.018, 0.24), pvMat)
    wing.position.set(sgn * 0.72, 0, 0.12); panels.add(wing)
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.012, 0.26), grey)
    frame.position.set(sgn * 0.72, -0.005, 0.12); panels.add(frame)
    for (const bx of [-0.18, 0, 0.18]) {
      const batten = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.022, 0.25), grey)
      batten.position.set(sgn * 0.72 + bx, 0, 0.12); panels.add(batten)
    }
  }
  group.add(panels)

  // 4 landing legs + diagonal struts + circular footpads ending cleanly at z = -0.52 + ladder on leg 0
  const strutGeo = new THREE.CylinderGeometry(0.018, 0.015, 1, 6)
  const footGeo = new THREE.CylinderGeometry(0.08, 0.09, 0.022, 12)
  const hipZ = -0.1, footZ = -0.509, hipR = 0.34, footR = 0.54
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4, ca = Math.cos(a), sa = Math.sin(a)
    const hip = new THREE.Vector3(ca * hipR, sa * hipR, hipZ)
    const foot = new THREE.Vector3(ca * footR, sa * footR, footZ)
    const legVec = foot.clone().sub(hip)
    const leg = new THREE.Mesh(strutGeo, padMat)
    leg.position.copy(hip).addScaledVector(legVec, 0.5)
    leg.scale.y = legVec.length()
    leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), legVec.clone().normalize())
    group.add(leg)
    if (i === 0) {
      for (let r = 1; r <= 4; r++) {
        const rung = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.01, 0.01), foil)
        rung.position.copy(hip).lerp(foot, r / 5).add(new THREE.Vector3(ca * 0.022, sa * 0.022, 0))
        rung.rotation.z = a + Math.PI / 2
        group.add(rung)
      }
    }

    const lowHub = new THREE.Vector3(ca * 0.25, sa * 0.25, -0.28)
    const braceVec = foot.clone().sub(lowHub)
    const brace = new THREE.Mesh(strutGeo, grey)
    brace.position.copy(lowHub).addScaledVector(braceVec, 0.5)
    brace.scale.set(0.75, braceVec.length(), 0.75)
    brace.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), braceVec.clone().normalize())
    group.add(brace)

    const pad = new THREE.Mesh(footGeo, padMat)
    pad.rotation.x = Math.PI / 2
    pad.position.set(foot.x, foot.y, -0.509)
    group.add(pad)
  }

  // Main engine bell + multi-layer exhaust flame (-Z)
  const bell = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.24, 16, 1, true), bellMat)
  bell.rotation.x = -Math.PI / 2; bell.position.z = -0.39; group.add(bell)

  const flame = new THREE.Group()
  const outer = new THREE.Mesh(
    new THREE.ConeGeometry(0.15, 0.78, 14, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff8c2b, transparent: true, opacity: 0.78, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  )
  outer.rotation.x = -Math.PI / 2; outer.position.z = -0.88; flame.add(outer)
  const core = new THREE.Mesh(
    new THREE.ConeGeometry(0.08, 0.48, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xfff2c2, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  )
  core.rotation.x = -Math.PI / 2; core.position.z = -0.72; flame.add(core)
  flame.visible = false
  group.add(flame)

  const beamG = new THREE.ConeGeometry(2.6, 5.5, 24, 1, true)
  beamG.translate(0, -2.75, 0)
  const beamM = new THREE.MeshBasicMaterial({
    color: 0xffe4a8,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const nightBeam = new THREE.Mesh(beamG, beamM)
  nightBeam.rotation.x = Math.PI / 2
  nightBeam.position.z = -0.45
  nightBeam.visible = false
  group.add(nightBeam)

  return { group, flame, panels, nightBeam }
}
