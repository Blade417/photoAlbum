import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { MediaItem } from '../lib/media'
import { AlbumVideoPool, type AlbumVideo } from '../lib/videoTextures'
import { findJourneyView } from '../lib/journey'
import {
  AlbumTexturePool,
  createGalaxyPositions,
  makeGlowTexture,
  makePlaceholderTexture,
  makePlayTexture,
  seededRandom,
} from '../lib/galaxy'

export type GalaxyHandle = {
  reset: () => void
  zoom: (direction: 1 | -1) => void
  focus: (id: string) => void
  beginJourney: () => void
  cancelJourney: () => void
}

export type JourneyState = 'flying' | 'arrived' | 'cancelled'

interface GalaxySceneProps {
  items: MediaItem[]
  autoRotate: boolean
  active: boolean
  onSelect: (item: MediaItem) => void
  onReady: () => void
  onError: (message: string) => void
  onJourneyChange?: (state: JourneyState, targetId: string | null) => void
}

interface Card {
  item: MediaItem
  group: THREE.Group
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  baseY: number
  roll: number
  width: number
  height: number
  video?: AlbumVideo
}

interface CameraTransition {
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
  // Editing captions should preserve the camera, loaded textures and playback.
  const assetSignature = JSON.stringify(props.items.map(({ id, type, src, thumbnail }) => [id, type, src, thumbnail]))

  useImperativeHandle(ref, () => ({
    reset: () => apiRef.current?.reset(),
    zoom: (direction) => apiRef.current?.zoom(direction),
    focus: (id) => apiRef.current?.focus(id),
    beginJourney: () => apiRef.current?.beginJourney(),
    cancelJourney: () => apiRef.current?.cancelJourney(),
  }), [])

  useEffect(() => {
    wakeRef.current?.()
  }, [props.active, props.autoRotate])

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

    const camera = new THREE.PerspectiveCamera(43, container.clientWidth / Math.max(1, container.clientHeight), 0.15, 500)
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
    const pool = new AlbumTexturePool(Math.min(4, renderer.capabilities.getMaxAnisotropy()))
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
      renderer.domElement.dataset.sceneState = propsRef.current.active && !document.hidden ? 'active' : 'paused'
      renderer.domElement.dataset.autoRotate = String(controls.autoRotate)
      renderer.domElement.dataset.reducedMotion = String(reducedMotion)
    }
    renderer.domElement.dataset.cardCount = String(items.length)
    renderer.domElement.dataset.journeyState = 'idle'
    renderer.domElement.dataset.journeyProgress = '0'
    const onControlsChange = () => publishCameraState()
    controls.addEventListener('change', onControlsChange)

    const starCount = container.clientWidth < 650 ? 3100 : 5600
    const brightStarCount = container.clientWidth < 650 ? 100 : 180
    renderer.domElement.dataset.starCount = String(starCount)
    renderer.domElement.dataset.brightStarCount = String(brightStarCount)
    const starGeometry = new THREE.BufferGeometry()
    const positions = new Float32Array(starCount * 3)
    const colors = new Float32Array(starCount * 3)
    const sizes = new Float32Array(starCount)
    const phases = new Float32Array(starCount)
    const sparks = new Float32Array(starCount)
    const palette = ['#fff2cc', '#bddffb', '#edc987', '#d5c8f7', '#edfaff'].map((color) => new THREE.Color(color))
    for (let i = 0; i < starCount; i += 1) {
      if (i < starCount * 0.6) {
        const radius = 8 + random() * 105
        const angle = random() * Math.PI * 2
        positions[i * 3] = Math.cos(angle) * radius
        positions[i * 3 + 1] = Math.sin(angle) * radius * 0.38 + (random() - 0.5) * 19
        positions[i * 3 + 2] = -30 + (random() - 0.5) * 85
      } else {
        const radius = 90 + random() * 120
        const theta = random() * Math.PI * 2
        const phi = Math.acos(2 * random() - 1)
        positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
        positions[i * 3 + 1] = radius * Math.cos(phi)
        positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
      }
      const color = palette[Math.floor(random() * palette.length)]!
      colors.set([color.r, color.g, color.b], i * 3)
      const bright = i < brightStarCount
      sizes[i] = bright ? 10 + random() * 15 : random() < 0.05 ? 2.4 + random() * 1.5 : 0.5 + random() * 1.3
      phases[i] = random() * Math.PI * 2
      sparks[i] = bright ? 1 : 0
    }
    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    starGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    starGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
    starGeometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))
    starGeometry.setAttribute('aSpark', new THREE.BufferAttribute(sparks, 1))
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
    const stars = new THREE.Points(starGeometry, starMaterial)
    stars.frustumCulled = false
    scene.add(stars)
    geometries.add(starGeometry)
    materials.add(starMaterial)

    const glowTexture = makeGlowTexture()
    textures.add(glowTexture)
    const nebulae = [
      { position: [8, 1, -54], scale: [130, 35], color: '#72829d', opacity: 0.19, rotation: -0.28 },
      { position: [-24, -8, -66], scale: [100, 32], color: '#ad9984', opacity: 0.13, rotation: 0.2 },
      { position: [40, 13, -75], scale: [100, 45], color: '#88809c', opacity: 0.12, rotation: 0.42 },
    ]
    nebulae.forEach(({ position, scale, color, opacity, rotation }) => {
      const material = new THREE.SpriteMaterial({ map: glowTexture, color, opacity, rotation, blending: THREE.AdditiveBlending, depthWrite: false })
      const nebula = new THREE.Sprite(material)
      nebula.position.set(position[0]!, position[1]!, position[2]!)
      nebula.scale.set(scale[0]!, scale[1]!, 1)
      scene.add(nebula)
      materials.add(material)
    })

    for (let ring = 0; ring < 3; ring += 1) {
      const points: THREE.Vector3[] = []
      const radius = 23 + ring * 15
      for (let step = 0; step <= 180; step += 1) {
        const angle = (step / 180) * Math.PI * 2
        points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.39, -20 + Math.sin(angle) * 9))
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points)
      const material = new THREE.LineBasicMaterial({ color: '#a9b3bf', transparent: true, opacity: 0.065, depthWrite: false })
      const orbit = new THREE.Line(geometry, material)
      orbit.rotation.z = -0.1
      scene.add(orbit)
      geometries.add(geometry)
      materials.add(material)
    }

    const planeGeometry = new THREE.PlaneGeometry(1, 1)
    geometries.add(planeGeometry)
    const imagePlaceholder = makePlaceholderTexture()
    const videoPlaceholder = makePlaceholderTexture(true)
    const playTexture = makePlayTexture()
    textures.add(imagePlaceholder)
    textures.add(videoPlaceholder)
    textures.add(playTexture)
    const positionsForCards = createGalaxyPositions(items.length)
    const cards: Card[] = []
    const cardsById = new Map<string, Card>()
    const nearPhotoColor = new THREE.Color('#f3f3f3')
    const distantPhotoColor = new THREE.Color('#77818c')
    const raycastMeshes: THREE.Mesh[] = []
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()

    items.forEach((item, index) => {
      const position = positionsForCards[index]!
      const group = new THREE.Group()
      group.position.set(position.x, position.y, position.z)
      const material = new THREE.MeshBasicMaterial({
        map: item.type === 'video' ? videoPlaceholder : imagePlaceholder,
        transparent: true,
        alphaTest: 0.04,
        side: THREE.DoubleSide,
        color: index < 16 ? '#f3f3f3' : '#77818c',
        depthWrite: true,
      })
      const mesh = new THREE.Mesh(planeGeometry, material)
      const card: Card = { item, group, mesh, baseY: position.y, roll: position.roll, width: position.width, height: position.width / 1.5 }
      mesh.scale.set(card.width, card.height, 1)
      mesh.userData.card = card
      group.add(mesh)
      let videoBadge: THREE.Sprite | undefined
      let posterTexture: THREE.Texture = item.type === 'video' ? videoPlaceholder : imagePlaceholder
      let posterAspect = 1.5
      const fitCard = (aspect: number) => {
        // Keep a similar footprint for portraits and landscapes without cropping.
        card.width = position.width * Math.sqrt(Math.min(2, Math.max(0.45, aspect)) / 1.5)
        card.height = card.width / aspect
        if (card.height > position.width * 1.45) {
          card.height = position.width * 1.45
          card.width = card.height * aspect
        }
        mesh.scale.set(card.width, card.height, 1)
      }
      if (item.type === 'video') {
        const playMaterial = new THREE.SpriteMaterial({ map: playTexture, transparent: true, depthWrite: false })
        const play = new THREE.Sprite(playMaterial)
        play.scale.set(0.75, 0.75, 1)
        play.position.z = 0.025
        play.renderOrder = 1
        group.add(play)
        materials.add(playMaterial)
        videoBadge = play
        card.video = videoPool.register(item.src, (entry) => {
          if (disposed) return
          const live = entry.ready && entry.hasPlayed && !entry.failed
          const nextTexture = live ? entry.texture : posterTexture
          if (material.map !== nextTexture) {
            material.map = nextTexture
            material.needsUpdate = true
          }
          if (videoBadge) videoBadge.visible = !live
          fitCard(live ? entry.aspect : posterAspect)
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
      const source = item.thumbnail || (item.type === 'image' ? item.src : undefined)
      if (source) {
        pool.load(source).then(({ texture, aspect }) => {
          if (disposed) return
          posterTexture = texture
          posterAspect = aspect
          if (!card.video?.hasPlayed || card.video.failed) {
            material.map = texture
            material.needsUpdate = true
            fitCard(aspect)
          }
          renderOnce()
        }).catch(() => {
          // Individual missing or unsupported media keep a selectable placeholder.
        })
      }
    })

    const videoFrustum = new THREE.Frustum()
    const cameraProjection = new THREE.Matrix4()
    const cardBounds = new THREE.Sphere()
    let lastVideoSchedule = -Infinity
    function scheduleVideos(time: number, force = false) {
      if (!force && time - lastVideoSchedule < 350) return
      lastVideoSchedule = time
      camera.updateMatrixWorld()
      cameraProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      videoFrustum.setFromProjectionMatrix(cameraProjection)
      const visible = new Map<string, number>()
      let visibleCards = 0
      cards.forEach((card) => {
        if (!card.video || card.video.failed) return
        cardBounds.center.copy(card.group.position)
        cardBounds.radius = Math.hypot(card.width, card.height) * 0.55
        if (!videoFrustum.intersectsSphere(cardBounds)) return
        visibleCards += 1
        const distance = camera.position.distanceTo(card.group.position) * (card.video.wanted ? 0.9 : 1)
        visible.set(card.item.src, Math.min(distance, visible.get(card.item.src) ?? Infinity))
      })
      // Limit simultaneous decoders, not the number of visible repeated cards.
      const nearestSources = [...visible].sort((left, right) => left[1] - right[1]).slice(0, 10).map(([src]) => src)
      videoPool.setVisible(new Set(nearestSources))
      renderer.domElement.dataset.videoVisibleCards = String(visibleCards)
      renderer.domElement.dataset.videoPlayingCards = String(cards.filter(({ video }) => video && video.ready && !video.failed && !video.video.paused).length)
      renderer.domElement.dataset.videoConcurrencyLimit = '10'
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

    function beginJourney() {
      if (journey || disposed || !cards.length || !propsRef.current.active || document.hidden) return
      // Draw from the current category, excluding only the previous stop when
      // there is a choice. Scene layout stays seeded; each journey is fresh.
      const candidates = cards.length > 1
        ? cards.filter(card => card.item.id !== lastJourneyTarget.current)
        : cards
      const destinationCard = candidates[Math.floor(Math.random() * candidates.length)]!
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
      const arcScale = Math.min(1.35, Math.max(0.75, startPosition.distanceTo(endPosition) / 18))
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
        duration: 3100,
      }
      interactionAt = performance.now()
      renderer.domElement.dataset.journeyProgress = '0'
      renderer.domElement.dataset.journeyTargetId = journeyTargetId
      renderer.domElement.dataset.journeyTargetPosition = JSON.stringify(destination.toArray())
      publishJourney('flying')
      if (reducedMotion) finishJourney()
      wake()
    }

    function startTransition(toPosition: THREE.Vector3, toTarget: THREE.Vector3, duration = 1050) {
      cancelJourney()
      transition = {
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

    apiRef.current = {
      beginJourney,
      cancelJourney,
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
      // App initializes this preference from reduced-motion. An explicit later
      // opt-in still permits roaming while decorative movement remains disabled.
      controls.autoRotate = propsRef.current.autoRotate && !journey && !transition && !keys.size && time - interactionAt > 1600
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
      starMaterial.uniforms.uTime!.value = reducedMotion ? 0 : elapsed
      cards.forEach((card, index) => {
        card.group.position.y = card.baseY + (reducedMotion ? 0 : Math.sin(elapsed * 0.25 + index * 1.3) * 0.13)
        if (index >= 16 && card.item.type === 'image') {
          // Distant photos regain their detail as a random journey approaches.
          const proximity = 1 - THREE.MathUtils.smoothstep(camera.position.distanceTo(card.group.position), 24, 48)
          card.mesh.material.color.copy(distantPhotoColor).lerp(nearPhotoColor, proximity)
        }
        card.group.quaternion.copy(camera.quaternion)
        card.group.rotateZ(card.roll + (reducedMotion ? 0 : Math.sin(elapsed * 0.17 + index) * 0.01))
        const scale = hovered === card ? 1.045 : 1
        card.group.scale.setScalar(THREE.MathUtils.lerp(card.group.scale.x, scale, reducedMotion ? 1 : 0.13))
      })
      scheduleVideos(time)
      renderer.render(scene, camera)
      animating = false
      if (!reducedMotion || videoPool.playing > 0 || propsRef.current.autoRotate || journey || transition || keys.size || dragging || time - interactionAt < 700) {
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
      const hit = raycaster.intersectObjects(raycastMeshes, false)[0]
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
      hovered = hitTest(event)
      renderer.domElement.style.cursor = hovered ? 'pointer' : 'grab'
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
      publishCameraState(true)
      lastVideoSchedule = -Infinity
      wake()
      renderOnce()
    })
    observer.observe(container)
    renderOnce()
    wake()
    propsRef.current.onReady()

    return () => {
      disposed = true
      journey = null
      wakeRef.current = null
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
