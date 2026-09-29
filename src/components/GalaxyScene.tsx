import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { MediaItem } from '../lib/media'
import { AlbumVideoPool, type AlbumVideo } from '../lib/videoTextures'
import { findJourneyView } from '../lib/journey'
import { memoryMoment } from '../lib/timeline'
import {
  AlbumTexturePool,
  FEATURED_COUNT,
  GALAXY_AXIS_X,
  GALAXY_FLATTENING,
  createGalaxyPositions,
  makeGlowTexture,
  makeLabelTexture,
  makePlaceholderTexture,
  makePlayTexture,
  seededRandom,
} from '../lib/galaxy'

export type GalaxyHandle = {
  reset: () => void
  zoom: (direction: 1 | -1) => void
  focus: (id: string) => void
  setRoaming: (enabled: boolean) => void
  /** Fly to the given memory, or to a random highlighted one. */
  beginJourney: (targetId?: string) => void
  cancelJourney: () => void
  /** Burst the gathered sphere into the full universe. */
  expand: () => void
}

export type JourneyState = 'flying' | 'arrived' | 'cancelled'
export type GalaxyFilter = 'all' | 'image' | 'video'
export type FormationState = 'sphere' | 'forming' | 'galaxy'

interface GalaxySceneProps {
  /** Every memory, newest first; positions never depend on the filter. */
  items: MediaItem[]
  filter: GalaxyFilter
  autoRotate: boolean
  active: boolean
  onSelect: (item: MediaItem) => void
  onReady: () => void
  onError: (message: string) => void
  onJourneyChange?: (state: JourneyState, targetId: string | null) => void
  /** Year of the dated memory nearest to the view centre. */
  onEraChange?: (year: number | null) => void
  /** Skip the gathered sphere and open directly as the universe. */
  startFormed: boolean
  onFormationChange?: (state: FormationState) => void
}

interface Card {
  item: MediaItem
  group: THREE.Group
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  badge?: THREE.Sprite
  home: THREE.Vector3
  /** Place on the gathered sphere; memories beyond the sphere's capacity emerge from its core. */
  sphere: THREE.Vector3 | null
  burstDelay: number
  baseY: number
  roll: number
  width: number
  height: number
  year: number | null
  highlighted: boolean
  poster: THREE.Texture
  posterAspect: number
  posterSource?: string
  fit: (aspect: number) => void
  video?: AlbumVideo
}

interface PosterEntry {
  cards: Card[]
  state: 'idle' | 'loading' | 'ready' | 'failed'
  lastSeen: number
}

interface CameraTransition {
  purpose: 'navigation' | 'roaming'
  fromPosition: THREE.Vector3
  toPosition: THREE.Vector3
  fromTarget: THREE.Vector3
  toTarget: THREE.Vector3
  startedAt: number
  duration: number
}

interface CameraJourney {
  positionCurve: THREE.CubicBezierCurve3
  targetCurve: THREE.CubicBezierCurve3
  startedAt: number
  duration: number
}

const isTyping = (target: EventTarget | null) =>
  target instanceof Element &&
  ((target instanceof HTMLElement && target.isContentEditable) || Boolean(target.closest('input, textarea, select, button, a, video, audio, [role="button"], [role="textbox"], [role="slider"]')))

const DIMMED_OPACITY = 0.13
// The gathered sphere shows the newest memories; the rest burst out of its core.
const SPHERE_CAPACITY = 120
const BURST_MS = 2600
const BURST_STAGGER = 0.28
const memoryStarVertex = `
  attribute float aHighlight;
  attribute float aPhase;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uNear;
  uniform float uFar;
  uniform float uReveal;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float viewDistance = length(mvPosition.xyz);
    // Takes over exactly as the photo card fades out with distance.
    vAlpha = smoothstep(uNear, uFar, viewDistance) * mix(0.16, 1.0, aHighlight) * (0.82 + 0.18 * sin(uTime * 0.7 + aPhase)) * uReveal;
    vColor = color;
    gl_PointSize = clamp(1300.0 * uPixelRatio / max(1.0, viewDistance), 2.2 * uPixelRatio, 9.0 * uPixelRatio);
    gl_Position = projectionMatrix * mvPosition;
  }
`
const memoryStarFragment = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float radius = length(gl_PointCoord - vec2(0.5));
    float alpha = (exp(-radius * 16.0) + exp(-radius * 6.0) * 0.3) * vAlpha;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`

export const GalaxyScene = forwardRef<GalaxyHandle, GalaxySceneProps>(function GalaxyScene(
  props,
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const apiRef = useRef<GalaxyHandle | null>(null)
  // Keep the previous stop across resets and category changes.
  const lastJourneyTarget = useRef<string | null>(null)
  const wakeRef = useRef<(() => void) | null>(null)
  const applyFilterRef = useRef<(() => void) | null>(null)
  // Editing captions should preserve the camera, loaded textures and playback.
  const assetSignature = JSON.stringify(props.items.map(({ id, type, src, thumbnail, previewSrc, aspect, color, takenAt, date }) => [id, type, src, thumbnail, previewSrc, aspect, color, takenAt, date]))

  useImperativeHandle(ref, () => ({
    reset: () => apiRef.current?.reset(),
    zoom: (direction) => apiRef.current?.zoom(direction),
    focus: (id) => apiRef.current?.focus(id),
    setRoaming: (enabled) => apiRef.current?.setRoaming(enabled),
    beginJourney: (targetId) => apiRef.current?.beginJourney(targetId),
    cancelJourney: () => apiRef.current?.cancelJourney(),
    expand: () => apiRef.current?.expand(),
  }), [])

  useEffect(() => {
    wakeRef.current?.()
  }, [props.active, props.autoRotate])

  useEffect(() => {
    applyFilterRef.current?.()
  }, [props.filter])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const items = propsRef.current.items
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    } catch {
      propsRef.current.onError('当前浏览器无法启用 3D 星空，请开启硬件加速或更换浏览器。')
      return
    }
    const scene = new THREE.Scene()
    const fog = new THREE.FogExp2('#091018', 0.003)
    scene.fog = fog
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.domElement.setAttribute('aria-label', '可拖动旋转、滚轮缩放的三维照片星空')
    renderer.domElement.tabIndex = 0
    renderer.domElement.style.touchAction = 'none'
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.cursor = 'grab'
    container.appendChild(renderer.domElement)

    const camera = new THREE.PerspectiveCamera(43, container.clientWidth / Math.max(1, container.clientHeight), 0.15, 1200)
    const homePosition = new THREE.Vector3(0, 0, container.clientWidth < 650 ? 68 : 47)
    const homeTarget = new THREE.Vector3(0, 0, 0)
    camera.position.copy(homePosition)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.065
    controls.rotateSpeed = 0.45
    controls.panSpeed = 0.6
    controls.zoomSpeed = 0.68
    controls.minDistance = 3
    controls.maxDistance = 170
    controls.autoRotateSpeed = 0.095
    controls.screenSpacePanning = true
    controls.target.copy(homeTarget)
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
    controls.update()

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reducedMotion = motionQuery.matches
    controls.enableDamping = !reducedMotion
    let disposed = false
    let frame = 0
    let animating = false
    let lastTime = performance.now()
    let elapsed = 0
    let transition: CameraTransition | null = null
    let journey: CameraJourney | null = null
    let journeyTargetId: string | null = null
    // 0 is the gathered sphere, 1 the full universe.
    let formation = propsRef.current.startFormed || reducedMotion ? 1 : 0
    let burstStartedAt: number | null = null
    let pendingJourney: { targetId?: string } | null = null
    let hovered: Card | null = null
    let pointerDown: { x: number; y: number; time: number; id: number; moved: boolean } | null = null
    let dragging = false
    let interactionAt = 0
    let lastCameraPublication = 0
    let cameraPublicationTimer: number | null = null
    const pointers = new Set<number>()
    const keys = new Set<string>()
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    const textures = new Set<THREE.Texture>()
    const mobileViewport = container.clientWidth < 650
    const pool = new AlbumTexturePool(Math.min(4, renderer.capabilities.getMaxAnisotropy()), mobileViewport ? 512 : 768, mobileViewport ? 2 : 4)
    const videoPool = new AlbumVideoPool(container, () => {
      videoPool.publishState(renderer.domElement)
      wake()
    })
    const random = seededRandom(8371)

    // Small, read-only diagnostics also let browser tests verify real camera movement.
    function publishCameraState(force = false) {
      if (disposed) return
      const sinceLast = performance.now() - lastCameraPublication
      if (!force && sinceLast < 120) {
        if (cameraPublicationTimer === null) {
          cameraPublicationTimer = window.setTimeout(() => {
            cameraPublicationTimer = null
            publishCameraState(true)
          }, 120 - sinceLast)
        }
        return
      }
      if (cameraPublicationTimer !== null) window.clearTimeout(cameraPublicationTimer)
      cameraPublicationTimer = null
      lastCameraPublication = performance.now()
      const roundedVector = (vector: THREE.Vector3) => JSON.stringify(vector.toArray().map((value) => Number(value.toFixed(4))))
      renderer.domElement.dataset.cameraPosition = roundedVector(camera.position)
      renderer.domElement.dataset.cameraTarget = roundedVector(controls.target)
      renderer.domElement.dataset.cameraDistance = camera.position.distanceTo(controls.target).toFixed(4)
      renderer.domElement.dataset.cameraTransition = transition?.purpose ?? 'none'
      renderer.domElement.dataset.sceneState = propsRef.current.active && !document.hidden ? 'active' : 'paused'
      renderer.domElement.dataset.autoRotate = String(controls.autoRotate)
      renderer.domElement.dataset.reducedMotion = String(reducedMotion)
      publishEra()
    }
    renderer.domElement.dataset.cardCount = String(items.length)
    renderer.domElement.dataset.journeyState = 'idle'
    renderer.domElement.dataset.journeyProgress = '0'
    const onControlsChange = () => publishCameraState()
    controls.addEventListener('change', onControlsChange)

    const positionsForCards = createGalaxyPositions(items.length)
    const deepest = positionsForCards.reduce((value, position) => Math.min(value, position.z), 0)
    const phoneStars = container.clientWidth < 650
    // Dust follows the memories back in time; the distant sky travels with the camera.
    const dustNear = 12.5
    const dustFar = Math.min(-72.5, deepest + 12)
    const dustScale = Math.min(4, (dustNear - dustFar) / 85)
    const dustCount = Math.round((phoneStars ? 1860 : 3360) * dustScale)
    const skyCount = phoneStars ? 1240 : 2240
    const brightStarCount = Math.round((phoneStars ? 100 : 180) * dustScale)
    renderer.domElement.dataset.starCount = String(dustCount + skyCount)
    renderer.domElement.dataset.brightStarCount = String(brightStarCount)
    const palette = ['#fff2cc', '#bddffb', '#edc987', '#d5c8f7', '#edfaff'].map((color) => new THREE.Color(color))
    function makeStars(count: number, brightCount: number, place: (index: number, target: Float32Array) => void) {
      const geometry = new THREE.BufferGeometry()
      const positions = new Float32Array(count * 3)
      const colors = new Float32Array(count * 3)
      const sizes = new Float32Array(count)
      const phases = new Float32Array(count)
      const sparks = new Float32Array(count)
      for (let i = 0; i < count; i += 1) {
        place(i, positions)
        const color = palette[Math.floor(random() * palette.length)]!
        colors.set([color.r, color.g, color.b], i * 3)
        const bright = i < brightCount
        sizes[i] = bright ? 10 + random() * 15 : random() < 0.05 ? 2.4 + random() * 1.5 : 0.5 + random() * 1.3
        phases[i] = random() * Math.PI * 2
        sparks[i] = bright ? 1 : 0
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
      geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))
      geometry.setAttribute('aSpark', new THREE.BufferAttribute(sparks, 1))
      geometries.add(geometry)
      return geometry
    }
    const dustGeometry = makeStars(dustCount, brightStarCount, (i, target) => {
      const radius = 8 + random() * 105
      const angle = random() * Math.PI * 2
      target[i * 3] = Math.cos(angle) * radius
      target[i * 3 + 1] = Math.sin(angle) * radius * 0.38 + (random() - 0.5) * 19
      target[i * 3 + 2] = dustNear + random() * (dustFar - dustNear)
    })
    const skyGeometry = makeStars(skyCount, 0, (i, target) => {
      const radius = 90 + random() * 120
      const theta = random() * Math.PI * 2
      const phi = Math.acos(2 * random() - 1)
      target[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
      target[i * 3 + 1] = radius * Math.cos(phi)
      target[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
    })
    const starMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() }, uJourney: { value: 0 } },
      vertexShader: `
        attribute float aSize;
        attribute float aPhase;
        attribute float aSpark;
        varying vec3 vColor;
        varying float vBrightness;
        varying float vSpark;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uJourney;
        void main() {
          vColor = color;
          vSpark = aSpark;
          vBrightness = (0.8 + 0.2 * sin(uTime * 0.55 + aPhase)) * (1.0 + uJourney * 0.28);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(aSize * uPixelRatio * (100.0 / max(10.0, -mvPosition.z)), 0.65, mix(7.5, 44.0, aSpark) * uPixelRatio);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vBrightness;
        varying float vSpark;
        void main() {
          vec2 p = gl_PointCoord - vec2(0.5);
          float radius = length(p);
          float alpha = pow(max(0.0, 1.0 - radius * 2.0), 1.4) * vBrightness;
          if (vSpark > 0.5) {
            float core = exp(-radius * 44.0);
            float halo = exp(-radius * 9.0) * 0.13;
            float vertical = exp(-abs(p.x) * 100.0) * pow(max(0.0, 1.0 - abs(p.y) * 2.0), 2.5);
            float horizontal = exp(-abs(p.y) * 100.0) * pow(max(0.0, 1.0 - abs(p.x) * 2.0), 2.5);
            alpha = (core + halo + (vertical + horizontal) * 0.68) * vBrightness;
          }
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const dust = new THREE.Points(dustGeometry, starMaterial)
    const sky = new THREE.Points(skyGeometry, starMaterial)
    dust.frustumCulled = false
    sky.frustumCulled = false
    sky.position.copy(camera.position)
    scene.add(dust, sky)
    materials.add(starMaterial)

    const glowTexture = makeGlowTexture()
    textures.add(glowTexture)
    // Nebulae, year rings and labels belong to the universe and appear as the sphere bursts.
    const galaxyDecor: Array<{ material: THREE.Material; opacity: number }> = []
    function addNebula(position: THREE.Vector3Tuple, scale: [number, number], color: THREE.ColorRepresentation, opacity: number, rotation: number) {
      const material = new THREE.SpriteMaterial({ map: glowTexture, color, opacity, rotation, blending: THREE.AdditiveBlending, depthWrite: false })
      const nebula = new THREE.Sprite(material)
      nebula.position.set(...position)
      nebula.scale.set(scale[0], scale[1], 1)
      scene.add(nebula)
      materials.add(material)
      galaxyDecor.push({ material, opacity })
    }
    const nebulaPalette = ['#72829d', '#ad9984', '#88809c']
    addNebula([8, 1, -54], [130, 35], nebulaPalette[0]!, 0.19, -0.28)
    addNebula([-24, -8, -66], [100, 32], nebulaPalette[1]!, 0.13, 0.2)
    addNebula([40, 13, -75], [100, 45], nebulaPalette[2]!, 0.12, 0.42)

    function addRing(radius: number, flattening: number, centre: THREE.Vector3Tuple, tilt: number, opacity: number, rotation: number) {
      const points: THREE.Vector3[] = []
      for (let step = 0; step <= 180; step += 1) {
        const angle = (step / 180) * Math.PI * 2
        points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius * flattening, Math.sin(angle) * tilt))
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points)
      const material = new THREE.LineBasicMaterial({ color: '#a9b3bf', transparent: true, opacity, depthWrite: false })
      const orbit = new THREE.Line(geometry, material)
      orbit.position.set(...centre)
      orbit.rotation.z = rotation
      scene.add(orbit)
      geometries.add(geometry)
      materials.add(material)
      galaxyDecor.push({ material, opacity })
    }

    const planeGeometry = new THREE.PlaneGeometry(1, 1)
    geometries.add(planeGeometry)
    const imagePlaceholder = makePlaceholderTexture()
    const videoPlaceholder = makePlaceholderTexture(true)
    const playTexture = makePlayTexture()
    textures.add(imagePlaceholder)
    textures.add(videoPlaceholder)
    textures.add(playTexture)
    const cards: Card[] = []
    const cardsById = new Map<string, Card>()
    const posters = new Map<string, PosterEntry>()
    const nearPhotoColor = new THREE.Color('#f3f3f3')
    const distantPhotoColor = new THREE.Color('#77818c')
    const raycastMeshes: THREE.Mesh[] = []
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()

    function showPoster(card: Card) {
      // A playing preview keeps its live frame; the poster is only its fallback.
      if (card.video && card.video.ready && card.video.hasPlayed && !card.video.failed) return
      const material = card.mesh.material
      if (material.map !== card.poster) {
        material.map = card.poster
        material.needsUpdate = true
      }
      card.fit(card.posterAspect)
    }

    function requestPoster(source: string | undefined) {
      const entry = source ? posters.get(source) : undefined
      if (!source || !entry || entry.state !== 'idle') return
      entry.state = 'loading'
      pool.load(source).then(({ texture, aspect }) => {
        if (disposed) return
        entry.state = 'ready'
        entry.cards.forEach((card) => {
          card.poster = texture
          card.posterAspect = aspect
          showPoster(card)
        })
        renderOnce()
      }).catch(() => {
        // Individual missing or unsupported media keep a selectable placeholder.
        if (!disposed) entry.state = 'failed'
      }).finally(() => { if (!disposed) wake() })
    }

    const sphereCount = Math.min(items.length, mobileViewport ? SPHERE_CAPACITY / 2 : SPHERE_CAPACITY)
    const sphereRadius = 5.2 + Math.sqrt(sphereCount) * 0.28
    const goldenAngle = Math.PI * (3 - Math.sqrt(5))
    const burstRandom = seededRandom(2718)
    items.forEach((item, index) => {
      const position = positionsForCards[index]!
      const group = new THREE.Group()
      group.position.set(position.x, position.y, position.z)
      let sphere: THREE.Vector3 | null = null
      if (index < sphereCount) {
        const height = 1 - (2 * (index + 0.5)) / sphereCount
        const ring = Math.sqrt(1 - height * height)
        sphere = new THREE.Vector3(Math.cos(index * goldenAngle) * ring, height, Math.sin(index * goldenAngle) * ring).multiplyScalar(sphereRadius)
      }
      const placeholder = item.type === 'video' ? videoPlaceholder : imagePlaceholder
      const material = new THREE.MeshBasicMaterial({
        map: placeholder,
        transparent: true,
        alphaTest: 0.04,
        side: THREE.DoubleSide,
        color: index < FEATURED_COUNT ? '#f3f3f3' : '#77818c',
        depthWrite: true,
      })
      const mesh = new THREE.Mesh(planeGeometry, material)
      const card: Card = {
        item,
        group,
        mesh,
        home: new THREE.Vector3(position.x, position.y, position.z),
        sphere,
        burstDelay: burstRandom() * BURST_STAGGER,
        baseY: position.y,
        roll: position.roll,
        width: position.width,
        height: position.width / 1.5,
        year: memoryMoment(item)?.year ?? null,
        highlighted: true,
        poster: placeholder,
        posterAspect: item.aspect || 1.5,
        posterSource: (item.type === 'image' ? item.previewSrc || item.thumbnail || item.src : item.thumbnail) || undefined,
        fit: (aspect) => {
          // Keep a similar footprint for portraits and landscapes without cropping.
          card.width = position.width * Math.sqrt(Math.min(2, Math.max(0.45, aspect)) / 1.5)
          card.height = card.width / aspect
          if (card.height > position.width * 1.45) {
            card.height = position.width * 1.45
            card.width = card.height * aspect
          }
          mesh.scale.set(card.width, card.height, 1)
        },
      }
      card.fit(card.posterAspect)
      mesh.userData.card = card
      group.add(mesh)
      if (item.type === 'video') {
        const playMaterial = new THREE.SpriteMaterial({ map: playTexture, transparent: true, depthWrite: false })
        const badge = new THREE.Sprite(playMaterial)
        badge.scale.set(0.75, 0.75, 1)
        badge.position.z = 0.025
        badge.renderOrder = 1
        group.add(badge)
        materials.add(playMaterial)
        card.badge = badge
        card.video = videoPool.register(item.previewSrc || item.src, (entry) => {
          if (disposed) return
          const live = entry.ready && entry.hasPlayed && !entry.failed
          const nextTexture = live ? entry.texture : card.poster
          if (material.map !== nextTexture) {
            material.map = nextTexture
            material.needsUpdate = true
          }
          badge.visible = !live
          card.fit(live ? entry.aspect : card.posterAspect)
          if (live) material.color.set('#f3f3f3')
        })
      }
      group.quaternion.copy(camera.quaternion)
      group.rotateZ(card.roll)
      scene.add(group)
      cards.push(card)
      cardsById.set(item.id, card)
      raycastMeshes.push(mesh)
      materials.add(material)
      if (card.posterSource) {
        const entry = posters.get(card.posterSource) ?? { cards: [], state: 'idle', lastSeen: -Infinity }
        entry.cards.push(card)
        posters.set(card.posterSource, entry)
      }
    })

    // Memories beyond photo range stay visible as stars in their own colours.
    const memoryHighlights = new Float32Array(cards.length).fill(1)
    const memoryStarGeometry = new THREE.BufferGeometry()
    {
      const positions = new Float32Array(cards.length * 3)
      const colors = new Float32Array(cards.length * 3)
      const phases = new Float32Array(cards.length)
      const hsl = { h: 0, s: 0, l: 0 }
      cards.forEach((card, index) => {
        positions.set([card.group.position.x, card.baseY, card.group.position.z], index * 3)
        const color = card.item.color ? new THREE.Color(card.item.color) : palette[index % palette.length]!.clone()
        // Lift dark previews so every memory still reads as starlight.
        color.getHSL(hsl)
        color.setHSL(hsl.h, Math.min(0.7, hsl.s * 1.15 + 0.08), Math.max(0.62, hsl.l))
        colors.set([color.r, color.g, color.b], index * 3)
        phases[index] = random() * Math.PI * 2
      })
      memoryStarGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      memoryStarGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      memoryStarGeometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))
      memoryStarGeometry.setAttribute('aHighlight', new THREE.BufferAttribute(memoryHighlights, 1))
    }
    const memoryStarMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() }, uNear: { value: 150 }, uFar: { value: 195 }, uReveal: { value: 1 } },
      vertexShader: memoryStarVertex,
      fragmentShader: memoryStarFragment,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const memoryStars = new THREE.Points(memoryStarGeometry, memoryStarMaterial)
    memoryStars.frustumCulled = false
    scene.add(memoryStars)
    geometries.add(memoryStarGeometry)
    materials.add(memoryStarMaterial)

    // A faint ring through each year's latest memory, labelled just above it, marks where that year begins.
    const spiralCards = cards.slice(FEATURED_COUNT)
    const years = new Map<number, Card[]>()
    spiralCards.forEach((card) => {
      if (card.year === null) return
      const list = years.get(card.year)
      if (list) list.push(card)
      else years.set(card.year, [card])
    })
    years.forEach((yearCards, year) => {
      const first = yearCards[0]!
      const { x, z } = first.group.position
      addRing(Math.hypot(x - GALAXY_AXIS_X, first.baseY / GALAXY_FLATTENING), GALAXY_FLATTENING, [GALAXY_AXIS_X, 0, z], 0, 0.085, 0)
      const label = makeLabelTexture(String(year))
      textures.add(label)
      const labelMaterial = new THREE.SpriteMaterial({ map: label, transparent: true, depthWrite: false, opacity: 0.72 })
      const sprite = new THREE.Sprite(labelMaterial)
      sprite.position.set(x, first.baseY + first.height / 2 + 1.3, z + 0.3)
      sprite.scale.set(3.9, 1.46, 1)
      scene.add(sprite)
      materials.add(labelMaterial)
      galaxyDecor.push({ material: labelMaterial, opacity: 0.72 })
    })
    renderer.domElement.dataset.yearRings = String(years.size)
    if (!years.size) {
      for (let ring = 0; ring < 3; ring += 1) addRing(23 + ring * 15, 0.39, [0, 0, -20], 9, 0.065, -0.1)
    }
    // Each era glows with the average colour of its memories.
    const segments = years.size
      ? [...years.values()]
      : Array.from({ length: Math.ceil(spiralCards.length / 28) }, (_, index) => spiralCards.slice(index * 28, index * 28 + 28))
    segments.forEach((segment, index) => {
      if (segment.length < 3) return
      const centre = new THREE.Vector3()
      const tint = new THREE.Color(0, 0, 0)
      let tinted = 0
      segment.forEach((card) => {
        centre.add(card.group.position)
        if (card.item.color) {
          tint.add(new THREE.Color(card.item.color))
          tinted += 1
        }
      })
      centre.divideScalar(segment.length)
      const spread = segment.reduce((value, card) => Math.max(value, Math.hypot(card.group.position.x - centre.x, card.group.position.y - centre.y)), 0)
      const color = new THREE.Color(nebulaPalette[index % nebulaPalette.length])
      if (tinted) color.lerp(tint.multiplyScalar(1 / tinted), 0.55)
      addNebula([centre.x, centre.y, centre.z - 10], [THREE.MathUtils.clamp(spread * 2.4, 40, 150), THREE.MathUtils.clamp(spread * 0.9, 16, 55)], color, 0.1, index % 2 ? 0.25 : -0.2)
    })

    const coreMaterial = new THREE.SpriteMaterial({ map: glowTexture, color: '#f1d7a6', opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
    const core = new THREE.Sprite(coreMaterial)
    scene.add(core)
    materials.add(coreMaterial)
    const spun = new THREE.Vector3()
    const upAxis = new THREE.Vector3(0, 1, 0)

    /** Places a card between its spot on the sphere and its home; returns how far it has travelled. */
    function placeCard(card: Card, index: number) {
      const bob = reducedMotion ? 0 : Math.sin(elapsed * 0.25 + index * 1.3) * 0.13
      if (formation >= 1) {
        card.group.position.set(card.home.x, card.baseY + bob, card.home.z)
        return 1
      }
      // Each memory leaves a moment after the last and eases in as it settles.
      const local = THREE.MathUtils.clamp((formation - card.burstDelay) / (1 - BURST_STAGGER), 0, 1)
      const travelled = 1 - (1 - local) ** 3
      if (card.sphere) spun.copy(card.sphere).applyAxisAngle(upAxis, reducedMotion ? 0 : elapsed * 0.16)
      else spun.set(0, 0, 0)
      card.group.position.lerpVectors(spun, card.home, travelled)
      card.group.position.y += bob * travelled
      return travelled
    }

    // Gathered photos share one modest size; they grow to their own as they travel.
    const formationScale = (card: Card, travelled: number) => THREE.MathUtils.lerp(1.6 / card.width, 1, travelled)

    function applyReveal() {
      const reveal = THREE.MathUtils.smoothstep(formation, 0.2, 0.95)
      galaxyDecor.forEach(({ material, opacity }) => { material.opacity = opacity * reveal })
      memoryStarMaterial.uniforms.uReveal!.value = reveal
      core.visible = formation < 1
      // The core glows while gathered, then flashes outwards and fades with the burst.
      const burst = THREE.MathUtils.smoothstep(formation, 0, 0.6)
      coreMaterial.opacity = (0.72 + (reducedMotion ? 0 : Math.sin(elapsed * 1.6) * 0.08)) * (1 - burst) + Math.sin(burst * Math.PI) * 0.5
      core.scale.setScalar(sphereRadius * (3.4 + burst * 9))
    }

    function publishFormation(state: FormationState) {
      renderer.domElement.dataset.formation = state
      if (!disposed) propsRef.current.onFormationChange?.(state)
    }

    function expand() {
      if (disposed || formation >= 1 || burstStartedAt !== null) return
      burstStartedAt = performance.now()
      interactionAt = burstStartedAt
      publishFormation('forming')
      if (reducedMotion) completeFormation()
      else wake()
    }

    function completeFormation() {
      formation = 1
      burstStartedAt = null
      starMaterial.uniforms.uJourney!.value = 0
      cards.forEach((card, index) => {
        placeCard(card, index)
        card.group.visible = true
        card.group.scale.setScalar(1)
      })
      applyReveal()
      interactionAt = performance.now()
      lastVideoSchedule = -Infinity
      publishFormation('galaxy')
      const pending = pendingJourney
      pendingJourney = null
      if (pending) beginJourney(pending.targetId)
      wake()
    }

    cards.forEach((card, index) => {
      const travelled = placeCard(card, index)
      card.group.visible = card.sphere !== null || travelled > 0
      card.group.scale.setScalar(formationScale(card, travelled))
    })
    applyReveal()

    function applyFilter() {
      const filter = propsRef.current.filter
      let highlighted = 0
      cards.forEach((card, index) => {
        card.highlighted = filter === 'all' || card.item.type === filter
        memoryHighlights[index] = card.highlighted ? 1 : 0
        if (card.highlighted) highlighted += 1
      })
      memoryStarGeometry.getAttribute('aHighlight').needsUpdate = true
      if (hovered && !hovered.highlighted) hovered = null
      renderer.domElement.dataset.highlightCount = String(highlighted)
      lastVideoSchedule = -Infinity
      wake()
    }

    let publishedEra: number | null | undefined
    function publishEra() {
      let nearest: Card | null = null
      let best = Infinity
      for (const card of cards) {
        if (card.year === null) continue
        const distance = card.group.position.distanceToSquared(controls.target)
        if (distance < best) {
          best = distance
          nearest = card
        }
      }
      const era = nearest?.year ?? null
      renderer.domElement.dataset.era = era === null ? '' : String(era)
      if (era === publishedEra) return
      publishedEra = era
      propsRef.current.onEraChange?.(era)
    }

    const videoFrustum = new THREE.Frustum()
    const cameraProjection = new THREE.Matrix4()
    const cardBounds = new THREE.Sphere()
    let lastVideoSchedule = -Infinity
    // Photos hand over to their stars at a distance that scales with the home view.
    const lodRange = () => ({ near: homePosition.z * 3.2, far: homePosition.z * 4.15 })

    function preparePoster(card: Card) {
      const entry = card.posterSource ? posters.get(card.posterSource) : undefined
      if (entry) entry.lastSeen = performance.now()
      requestPoster(card.posterSource)
    }

    // Keep GPU memory bounded in large albums by releasing previews that left the view.
    function releaseIdlePosters(time: number) {
      const budget = mobileViewport ? 70 : 140
      if (pool.residentCount <= budget) return
      const idle = [...posters]
        .filter(([, entry]) => entry.state === 'ready' && entry.lastSeen < time)
        .sort((left, right) => left[1].lastSeen - right[1].lastSeen)
      for (const [source, entry] of idle) {
        if (pool.residentCount <= budget) break
        entry.state = 'idle'
        entry.cards.forEach((card) => {
          card.poster = card.item.type === 'video' ? videoPlaceholder : imagePlaceholder
          showPoster(card)
        })
        pool.evict(source)
      }
    }

    function scheduleVisibility(time: number, force = false) {
      if (!force && time - lastVideoSchedule < 350) return
      lastVideoSchedule = time
      camera.updateMatrixWorld()
      cameraProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      videoFrustum.setFromProjectionMatrix(cameraProjection)
      const { far } = lodRange()
      const visible = new Map<string, number>()
      const wanted = new Map<string, number>()
      let visibleCards = 0
      let distant = 0
      cards.forEach((card) => {
        const distance = camera.position.distanceTo(card.group.position)
        if (distance >= far) {
          distant += 1
          return
        }
        if (!card.group.visible) return
        cardBounds.center.copy(card.group.position)
        cardBounds.radius = Math.hypot(card.width, card.height) * 0.55
        if (!videoFrustum.intersectsSphere(cardBounds)) return
        const poster = card.posterSource ? posters.get(card.posterSource) : undefined
        if (poster) {
          poster.lastSeen = time
          if (poster.state === 'idle') wanted.set(card.posterSource!, Math.min(distance, wanted.get(card.posterSource!) ?? Infinity))
        }
        if (formation < 1 || !card.highlighted || !card.video || card.video.failed) return
        visibleCards += 1
        const weighted = distance * (card.video.wanted ? 0.9 : 1)
        const source = card.item.previewSrc || card.item.src
        visible.set(source, Math.min(weighted, visible.get(source) ?? Infinity))
      })
      // Load visible previews first; distant/offscreen originals are never prefetched.
      ;[...wanted].sort((left, right) => left[1] - right[1]).slice(0, 8).forEach(([source]) => requestPoster(source))
      releaseIdlePosters(time)
      // Limit simultaneous decoders, not the number of visible repeated cards.
      const concurrencyLimit = renderer.domElement.clientWidth < 650 ? 2 : 4
      const nearestSources = [...visible].sort((left, right) => left[1] - right[1]).slice(0, concurrencyLimit).map(([src]) => src)
      videoPool.setVisible(new Set(nearestSources))
      renderer.domElement.dataset.videoVisibleCards = String(visibleCards)
      renderer.domElement.dataset.videoPlayingCards = String(cards.filter(({ video }) => video && video.ready && !video.failed && !video.video.paused).length)
      renderer.domElement.dataset.videoConcurrencyLimit = String(concurrencyLimit)
      renderer.domElement.dataset.distantMemories = String(distant)
      renderer.domElement.dataset.residentTextures = String(pool.residentCount)
      videoPool.publishState(renderer.domElement)
    }

    function renderOnce() {
      if (!disposed && !document.hidden) renderer.render(scene, camera)
    }

    function publishJourney(state: JourneyState) {
      renderer.domElement.dataset.journeyState = state
      if (!disposed) propsRef.current.onJourneyChange?.(state, journeyTargetId)
    }

    function restoreJourneyAtmosphere() {
      starMaterial.uniforms.uJourney!.value = 0
      fog.density = 0.003
    }

    function cancelJourney() {
      pendingJourney = null
      if (!journey) return
      journey = null
      restoreJourneyAtmosphere()
      interactionAt = performance.now()
      controls.autoRotate = false
      publishCameraState(true)
      publishJourney('cancelled')
    }

    function finishJourney() {
      if (!journey) return
      journey.positionCurve.getPoint(1, camera.position)
      journey.targetCurve.getPoint(1, controls.target)
      journey = null
      restoreJourneyAtmosphere()
      renderer.domElement.dataset.journeyProgress = '1'
      interactionAt = performance.now()
      controls.update(0)
      publishCameraState(true)
      publishJourney('arrived')
    }

    function beginJourney(targetId?: string) {
      if (journey || disposed || !cards.length || !propsRef.current.active || document.hidden) return
      if (formation < 1) {
        // Burst first; the flight starts once the universe has formed.
        pendingJourney = { targetId }
        expand()
        return
      }
      const requested = targetId === undefined ? undefined : cardsById.get(targetId)
      if (targetId !== undefined && !requested) return
      // Draw from the current category, excluding only the previous stop when
      // there is a choice. Scene layout stays seeded; each journey is fresh.
      const highlighted = cards.filter(card => card.highlighted)
      if (!requested && !highlighted.length) return
      const candidates = highlighted.length > 1
        ? highlighted.filter(card => card.item.id !== lastJourneyTarget.current)
        : highlighted
      const destinationCard = requested ?? candidates[Math.floor(Math.random() * candidates.length)]!
      preparePoster(destinationCard)
      journeyTargetId = destinationCard.item.id
      lastJourneyTarget.current = journeyTargetId
      transition = null
      keys.clear()
      renderer.domElement.focus({ preventScroll: true })
      controls.autoRotate = false
      // Discard the last orbit's damping before taking ownership of the camera.
      controls.enableDamping = false
      controls.update(0)
      controls.enableDamping = !reducedMotion
      const destination = destinationCard.group.position.clone()
      const fieldOfView = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
      const imageWidth = destinationCard.width
      const imageHeight = destinationCard.height
      // Frame the chosen memory comfortably, including portrait screens.
      const widthFraction = camera.aspect < 1 ? 0.48 : 0.34
      const distance = Math.max(14, imageWidth / (fieldOfView * camera.aspect * widthFraction), imageHeight / (fieldOfView * 0.43))
      const { position: endPosition, target: endTarget } = findJourneyView(
        destination,
        destination.clone().add(new THREE.Vector3(0.65, 1.25, distance)),
        destination.clone().add(new THREE.Vector3(0, 0.35, -6)),
        cards.map(card => ({ position: card.group.position, width: card.width, height: card.height, roll: card.roll })),
        cards.indexOf(destinationCard),
      )
      const startPosition = camera.position.clone()
      const startTarget = controls.target.clone()
      const travel = startPosition.distanceTo(endPosition)
      const arcScale = Math.min(1.35, Math.max(0.75, travel / 18))
      journey = {
        positionCurve: new THREE.CubicBezierCurve3(
          startPosition,
          startPosition.clone().lerp(endPosition, 0.2).add(new THREE.Vector3(-9 * arcScale, 5 * arcScale, 1)),
          startPosition.clone().lerp(endPosition, 0.72).add(new THREE.Vector3(-5 * arcScale, 4 * arcScale, 0)),
          endPosition,
        ),
        targetCurve: new THREE.CubicBezierCurve3(
          startTarget,
          startTarget.clone().lerp(endTarget, 0.25).add(new THREE.Vector3(-1, 1.5, 0)),
          endTarget.clone().add(new THREE.Vector3(-1, 1, 0)),
          endTarget,
        ),
        startedAt: performance.now(),
        // Trips far back in time take a little longer, but never drag.
        duration: 3100 + THREE.MathUtils.clamp((travel - 150) * 6, 0, 2900),
      }
      interactionAt = performance.now()
      renderer.domElement.dataset.journeyProgress = '0'
      renderer.domElement.dataset.journeyTargetId = journeyTargetId
      renderer.domElement.dataset.journeyTargetPosition = JSON.stringify(destination.toArray())
      publishJourney('flying')
      if (reducedMotion) finishJourney()
      wake()
    }

    function startTransition(toPosition: THREE.Vector3, toTarget: THREE.Vector3, duration = 1050, purpose: CameraTransition['purpose'] = 'navigation') {
      cancelJourney()
      transition = {
        purpose,
        fromPosition: camera.position.clone(),
        toPosition,
        fromTarget: controls.target.clone(),
        toTarget,
        startedAt: performance.now(),
        duration: reducedMotion ? 0 : duration,
      }
      interactionAt = performance.now()
      wake()
    }

    function setRoaming(enabled: boolean) {
      // Flush orbit damping without moving the camera when playback is paused.
      const position = camera.position.clone()
      const target = controls.target.clone()
      controls.autoRotate = false
      controls.enableDamping = false
      controls.update(0)
      camera.position.copy(position)
      controls.target.copy(target)
      controls.update(0)
      controls.enableDamping = !reducedMotion
      if (!enabled) {
        if (transition?.purpose === 'roaming') transition = null
        publishCameraState(true)
        wake()
        return
      }

      // A close-up or off-center orbit makes camera-facing cards look static.
      // Return to a wide orbit while keeping the current viewing direction.
      const offset = position.clone().sub(target)
      const needsOverview = Boolean(journey || transition)
        || target.distanceTo(homeTarget) > 0.5
        || offset.length() < homePosition.z * 0.9
      cancelJourney()
      keys.clear()
      controls.autoRotateSpeed = 0.35
      if (needsOverview) {
        if (offset.lengthSq() < 0.001) offset.copy(homePosition)
        offset.setLength(Math.max(homePosition.z, offset.length()))
        startTransition(homeTarget.clone().add(offset), homeTarget.clone(), 1600, 'roaming')
      } else {
        // An explicit start should respond immediately, without the idle delay.
        interactionAt = performance.now() - 1601
        wake()
      }
    }

    apiRef.current = {
      beginJourney,
      cancelJourney,
      setRoaming,
      expand,
      reset: () => startTransition(homePosition.clone(), homeTarget.clone(), 1250),
      zoom: (direction) => {
        const offset = camera.position.clone().sub(controls.target)
        const distance = THREE.MathUtils.clamp(offset.length() * (direction === 1 ? 0.76 : 1.32), controls.minDistance, controls.maxDistance)
        startTransition(controls.target.clone().add(offset.setLength(distance)), controls.target.clone(), 450)
      },
      focus: (id) => {
        cancelJourney()
        const card = cardsById.get(id)
        if (!card) return
        if (formation < 1) completeFormation()
        preparePoster(card)
        const target = card.group.position.clone()
        const direction = camera.position.clone().sub(target).normalize()
        const fitDistance = Math.max(card.height, card.width / camera.aspect) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.6
        startTransition(target.clone().add(direction.multiplyScalar(Math.max(9, fitDistance))), target)
      },
    }

    const movement = new THREE.Vector3()
    const forward = new THREE.Vector3()
    const right = new THREE.Vector3()
    function animate(time: number) {
      frame = 0
      if (disposed || document.hidden || !propsRef.current.active) return
      animating = true
      const delta = Math.min((time - lastTime) / 1000, 0.05)
      lastTime = time
      elapsed += delta
      if (burstStartedAt !== null) {
        formation = Math.min(1, Math.max(0, (time - burstStartedAt) / BURST_MS))
        // Starlight flares with the burst, as it does on a journey.
        starMaterial.uniforms.uJourney!.value = Math.sin(formation * Math.PI) ** 2 * 1.1
        if (formation === 1) completeFormation()
      }
      if (formation < 1) applyReveal()
      // App initializes this preference from reduced-motion. An explicit later
      // opt-in still permits roaming while decorative movement remains disabled.
      controls.autoRotate = propsRef.current.autoRotate && !journey && !transition && !keys.size && !dragging && time - interactionAt > 1600
      if (journey) {
        const progress = Math.min(1, Math.max(0, (time - journey.startedAt) / journey.duration))
        // Quintic easing has no velocity or acceleration jump at either end.
        const eased = progress ** 3 * (progress * (progress * 6 - 15) + 10)
        journey.positionCurve.getPoint(eased, camera.position)
        journey.targetCurve.getPoint(eased, controls.target)
        const atmosphere = Math.sin(progress * Math.PI) ** 2
        starMaterial.uniforms.uJourney!.value = atmosphere
        fog.density = 0.003 * (1 - atmosphere * 0.2)
        renderer.domElement.dataset.journeyProgress = progress.toFixed(4)
        if (progress === 1 || reducedMotion) finishJourney()
      }
      if (transition) {
        const progress = transition.duration === 0 ? 1 : Math.min(1, (time - transition.startedAt) / transition.duration)
        const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
        camera.position.lerpVectors(transition.fromPosition, transition.toPosition, eased)
        controls.target.lerpVectors(transition.fromTarget, transition.toTarget, eased)
        if (progress === 1) transition = null
      }
      if (keys.size) {
        cancelJourney()
        transition = null
        camera.getWorldDirection(forward)
        right.crossVectors(forward, camera.up).normalize()
        movement.set(0, 0, 0)
        if (keys.has('w') || keys.has('arrowup')) movement.add(forward)
        if (keys.has('s') || keys.has('arrowdown')) movement.sub(forward)
        if (keys.has('d') || keys.has('arrowright')) movement.add(right)
        if (keys.has('a') || keys.has('arrowleft')) movement.sub(right)
        if (keys.has('e')) movement.y += 1
        if (keys.has('q')) movement.y -= 1
        movement.normalize().multiplyScalar(delta * (keys.has('shift') ? 26 : 13))
        camera.position.add(movement)
        controls.target.add(movement)
      }
      controls.update(delta)
      sky.position.copy(camera.position)
      starMaterial.uniforms.uTime!.value = reducedMotion ? 0 : elapsed
      const lod = lodRange()
      memoryStarMaterial.uniforms.uTime!.value = reducedMotion ? 0 : elapsed
      memoryStarMaterial.uniforms.uNear!.value = lod.near
      memoryStarMaterial.uniforms.uFar!.value = lod.far
      cards.forEach((card, index) => {
        const travelled = placeCard(card, index)
        const distance = camera.position.distanceTo(card.group.position)
        const fade = THREE.MathUtils.smoothstep(distance, lod.near, lod.far)
        card.group.visible = fade < 1 && (card.sphere !== null || travelled > 0)
        if (!card.group.visible) return
        const opacity = (1 - fade) * (card.highlighted ? 1 : DIMMED_OPACITY)
        card.mesh.material.opacity = opacity
        if (card.badge) card.badge.material.opacity = opacity
        if (index >= FEATURED_COUNT && card.item.type === 'image') {
          // Distant photos regain their detail as a random journey approaches; gathered ones stay bright.
          const proximity = Math.max(1 - THREE.MathUtils.smoothstep(distance, 24, 48), 1 - travelled)
          card.mesh.material.color.copy(distantPhotoColor).lerp(nearPhotoColor, proximity)
        }
        card.group.quaternion.copy(camera.quaternion)
        card.group.rotateZ(card.roll + (reducedMotion ? 0 : Math.sin(elapsed * 0.17 + index) * 0.01))
        const scale = hovered === card ? 1.045 : 1
        if (formation < 1) card.group.scale.setScalar(scale * formationScale(card, travelled))
        else card.group.scale.setScalar(THREE.MathUtils.lerp(card.group.scale.x, scale, reducedMotion ? 1 : 0.13))
      })
      scheduleVisibility(time)
      renderer.render(scene, camera)
      animating = false
      if (!reducedMotion || formation < 1 || videoPool.playing > 0 || propsRef.current.autoRotate || journey || transition || keys.size || dragging || time - interactionAt < 700) {
        frame = requestAnimationFrame(animate)
      }
    }

    function wake() {
      controls.enabled = propsRef.current.active && !document.hidden
      if (!controls.enabled) {
        cancelJourney()
        videoPool.setVisible(new Set())
        videoPool.publishState(renderer.domElement)
        keys.clear()
        hovered = null
        if (frame) cancelAnimationFrame(frame)
        frame = 0
        publishCameraState()
        return
      }
      lastVideoSchedule = -Infinity
      publishCameraState()
      if (!frame && !animating) {
        lastTime = performance.now()
        frame = requestAnimationFrame(animate)
      }
    }
    wakeRef.current = wake

    function hitTest(event: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      // Raycasting ignores visibility, so skip faded-out and dimmed memories explicitly.
      const targets = raycastMeshes.filter((mesh) => {
        const card = mesh.userData.card as Card
        return card.highlighted && card.group.visible
      })
      const hit = raycaster.intersectObjects(targets, false)[0]
      return (hit?.object.userData.card as Card | undefined) || null
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!propsRef.current.active) return
      pointers.add(event.pointerId)
      pointerDown = pointers.size === 1 && event.button === 0 ? { x: event.clientX, y: event.clientY, time: performance.now(), id: event.pointerId, moved: false } : null
      dragging = true
      cancelJourney()
      transition = null
      interactionAt = performance.now()
      renderer.domElement.style.cursor = 'grabbing'
      wake()
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!propsRef.current.active) return
      if (pointerDown && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 6) pointerDown.moved = true
      if (dragging) return
      hovered = formation < 1 ? null : hitTest(event)
      renderer.domElement.style.cursor = hovered || formation < 1 ? 'pointer' : 'grab'
      if (reducedMotion) wake()
    }
    const onPointerUp = (event: PointerEvent) => {
      const down = pointerDown
      pointers.delete(event.pointerId)
      dragging = pointers.size > 0
      pointerDown = null
      interactionAt = performance.now()
      renderer.domElement.style.cursor = 'grab'
      if (!propsRef.current.active || !down || down.moved || down.id !== event.pointerId || performance.now() - down.time > 650 || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return
      if (formation < 1) {
        expand()
        return
      }
      const card = hitTest(event)
      if (card) propsRef.current.onSelect(propsRef.current.items.find((item) => item.id === card.item.id) || card.item)
    }
    const clearPointer = () => {
      hovered = null
      pointerDown = null
      pointers.clear()
      dragging = false
      renderer.domElement.style.cursor = 'grab'
    }
    const onPointerLeave = () => { hovered = null; if (reducedMotion) wake() }
    const onWheel = () => { cancelJourney(); transition = null; interactionAt = performance.now(); wake() }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!propsRef.current.active || isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (['w', 'a', 's', 'd', 'q', 'e', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault()
        cancelJourney()
        keys.add(key)
        interactionAt = performance.now()
        wake()
      }
      if (key === 'r' && !event.repeat) apiRef.current?.reset()
    }
    const onKeyUp = (event: KeyboardEvent) => { keys.delete(event.key.toLowerCase()) }
    const onBlur = () => { cancelJourney(); keys.clear(); clearPointer() }
    const onMotionChange = () => {
      reducedMotion = motionQuery.matches
      controls.enableDamping = !reducedMotion
      wake()
    }
    const onContextLost = (event: Event) => {
      event.preventDefault()
      cancelJourney()
      videoPool.setVisible(new Set())
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      propsRef.current.onError('3D 画面连接已中断，请刷新页面重新进入星空。')
    }
    // Browsers that reject muted autoplay can unlock all visible videos with
    // the first ordinary pointer or keyboard gesture anywhere in the album.
    const onPlaybackGesture = () => {
      if (propsRef.current.active && !document.hidden) videoPool.retryBlocked()
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', onPointerUp)
    renderer.domElement.addEventListener('pointercancel', clearPointer)
    renderer.domElement.addEventListener('pointerleave', onPointerLeave)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: true })
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', wake)
    document.addEventListener('pointerdown', onPlaybackGesture, true)
    document.addEventListener('keydown', onPlaybackGesture, true)
    motionQuery.addEventListener('change', onMotionChange)

    const observer = new ResizeObserver(() => {
      const { clientWidth: width, clientHeight: height } = container
      if (!width || !height) return
      if (camera.aspect !== width / height) cancelJourney()
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      const nextHomeDistance = width < 650 ? 68 : 47
      if (homePosition.z !== nextHomeDistance) {
        // Preserve the user's target and relative zoom across phone/desktop layouts.
        const offset = camera.position.clone().sub(controls.target)
        const distance = THREE.MathUtils.clamp(offset.length() * nextHomeDistance / homePosition.z, controls.minDistance, controls.maxDistance)
        camera.position.copy(controls.target).add(offset.setLength(distance))
        homePosition.z = nextHomeDistance
        transition = null
        controls.update(0)
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
      renderer.setSize(width, height)
      starMaterial.uniforms.uPixelRatio!.value = renderer.getPixelRatio()
      memoryStarMaterial.uniforms.uPixelRatio!.value = renderer.getPixelRatio()
      publishCameraState(true)
      lastVideoSchedule = -Infinity
      wake()
      renderOnce()
    })
    observer.observe(container)
    applyFilterRef.current = applyFilter
    applyFilter()
    publishFormation(formation >= 1 ? 'galaxy' : 'sphere')
    renderOnce()
    wake()
    propsRef.current.onReady()

    return () => {
      disposed = true
      journey = null
      wakeRef.current = null
      applyFilterRef.current = null
      apiRef.current = null
      cancelAnimationFrame(frame)
      if (cameraPublicationTimer !== null) window.clearTimeout(cameraPublicationTimer)
      observer.disconnect()
      controls.removeEventListener('change', onControlsChange)
      controls.dispose()
      videoPool.dispose()
      pool.dispose()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', wake)
      document.removeEventListener('pointerdown', onPlaybackGesture, true)
      document.removeEventListener('keydown', onPlaybackGesture, true)
      motionQuery.removeEventListener('change', onMotionChange)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('pointercancel', clearPointer)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      renderer.domElement.removeEventListener('wheel', onWheel)
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((material) => material.dispose())
      textures.forEach((texture) => texture.dispose())
      scene.clear()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    }
  }, [assetSignature])

  return <div ref={containerRef} className="galaxy-scene" style={{ position: 'absolute', inset: 0 }} />
})

export default GalaxyScene
