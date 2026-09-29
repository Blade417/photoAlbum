import * as THREE from 'three'

export interface GalaxyPosition {
  x: number
  y: number
  z: number
  width: number
  roll: number
}

/** Seeded randomness keeps the same constellation when the UI rerenders. */
export function seededRandom(seed = 4719) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const foreground = [
  [1.5, 0.7, 16, 6.6, -0.045],
  [-7, 8.2, 5, 4.8, 0.055],
  [6.8, 10.5, 0, 5.3, -0.06],
  [18, 7, 7, 5.7, 0.065],
  [25.5, -0.5, 0, 5, -0.04],
  [16, -6.7, 10, 5.7, 0.045],
  [4.8, -9.8, 5, 5.8, -0.055],
  [-8.4, -6.4, 11, 6.2, 0.06],
  [-22, -7.2, -2, 6, -0.065],
  [-15.2, 3.2, -8, 4.8, 0.04],
  [12.8, 0.8, -6, 4.9, -0.05],
  [-26, -10.5, -4, 4.5, 0.065],
  [-17, -12.8, -11, 4.5, -0.06],
  [23, -12, -12, 4.6, 0.035],
  [29, 10.5, -14, 4.3, -0.04],
  [-0.8, 15.7, -14, 4.7, 0.06],
] as const

export const FEATURED_COUNT = foreground.length
export const GALAXY_AXIS_X = 3
export const GALAXY_FLATTENING = 0.48
// The original composition held 83 spiral memories within this depth.
const SPIRAL_REFERENCE = 83
const SPIRAL_DEPTH = 54

/** Newest memories take the hand-placed foreground; older ones recede along the arms. */
export function createGalaxyPositions(count: number): GalaxyPosition[] {
  const random = seededRandom()
  const spiralCount = Math.max(1, count - foreground.length)
  // Larger albums keep the original spacing and reach further back instead of crowding.
  const stretch = Math.max(1, spiralCount / SPIRAL_REFERENCE)
  return Array.from({ length: count }, (_, index) => {
    const featured = foreground[index]
    if (featured) {
      const [x, y, z, width, roll] = featured
      return { x, y, z, width, roll }
    }
    const arm = index % 3
    const reach = (index - foreground.length) / spiralCount * stretch
    const radius = 18 + Math.sqrt(Math.min(1, reach)) * 43 + random() * 5
    const angle = arm * ((Math.PI * 2) / 3) + reach * 3.8 + random() * 0.38
    let x = Math.cos(angle) * radius
    let y = Math.sin(angle) * radius * GALAXY_FLATTENING + (random() - 0.5) * 7
    // Leave room for the introductory copy in the initial view.
    if (x < -17 && y > 2) y = -8 - random() * 15
    x += GALAXY_AXIS_X
    return {
      x,
      y,
      // Distance is time: the further a memory, the longer ago it happened.
      z: -32 - reach * SPIRAL_DEPTH - random() * 8,
      width: 2.8 + random() * 1.44,
      roll: (random() - 0.5) * 0.16,
    }
  })
}

export function makeLabelTexture(label: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 96
  const context = canvas.getContext('2d')!
  context.font = '300 58px Georgia, "Times New Roman", serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.shadowColor = 'rgba(213,187,146,0.55)'
  context.shadowBlur = 14
  context.fillStyle = 'rgba(226,208,176,0.92)'
  context.fillText(label, 128, 50)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function makeGlowTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const context = canvas.getContext('2d')!
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(255,255,255,0.6)')
  gradient.addColorStop(0.2, 'rgba(255,255,255,0.24)')
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.045)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(canvas)
}

export function makePlaceholderTexture(video = false) {
  const canvas = document.createElement('canvas')
  canvas.width = 480
  canvas.height = 320
  const context = canvas.getContext('2d')!
  context.beginPath()
  context.roundRect(2, 2, 476, 316, 14)
  context.clip()
  const gradient = context.createLinearGradient(0, 0, 480, 320)
  gradient.addColorStop(0, '#2a343f')
  gradient.addColorStop(0.55, '#3e3e44')
  gradient.addColorStop(1, '#1a2934')
  context.fillStyle = gradient
  context.fillRect(0, 0, 480, 320)
  const glow = context.createRadialGradient(320, 135, 0, 320, 135, 240)
  glow.addColorStop(0, 'rgba(181,163,122,0.16)')
  glow.addColorStop(1, 'rgba(181,163,122,0)')
  context.fillStyle = glow
  context.fillRect(0, 0, 480, 320)
  if (!video) {
    context.strokeStyle = 'rgba(220,226,228,0.18)'
    context.lineWidth = 1.5
    context.beginPath()
    context.arc(240, 160, 24, 0, Math.PI * 2)
    context.stroke()
    context.beginPath()
    context.moveTo(218, 166)
    context.lineTo(233, 150)
    context.lineTo(247, 165)
    context.lineTo(255, 157)
    context.lineTo(263, 166)
    context.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function makePlayTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const context = canvas.getContext('2d')!
  context.fillStyle = 'rgba(10,16,21,0.5)'
  context.beginPath()
  context.arc(64, 64, 54, 0, Math.PI * 2)
  context.fill()
  context.strokeStyle = 'rgba(255,255,255,0.8)'
  context.lineWidth = 2
  context.stroke()
  context.fillStyle = '#fff'
  context.beginPath()
  context.moveTo(54, 43)
  context.lineTo(84, 64)
  context.lineTo(54, 85)
  context.closePath()
  context.fill()
  return new THREE.CanvasTexture(canvas)
}

interface LoadedTexture {
  texture: THREE.CanvasTexture
  aspect: number
}

/** Decode only a bounded number of previews; cap the textures uploaded to the GPU. */
export class AlbumTexturePool {
  private cache = new Map<string, Promise<LoadedTexture>>()
  private textures = new Set<THREE.Texture>()
  private resident = new Map<string, THREE.Texture>()
  private queue: Array<() => void> = []
  private cancellations = new Set<() => void>()
  private running = 0
  private disposed = false

  constructor(private readonly anisotropy: number, private readonly maxEdge = 768, private readonly concurrency = 4) {}

  load(src: string): Promise<LoadedTexture> {
    const cached = this.cache.get(src)
    if (cached) return cached
    const promise = new Promise<LoadedTexture>((resolve, reject) => {
      let image: HTMLImageElement | undefined
      let settled = false
      const cancel = () => {
        if (settled) return
        settled = true
        if (image) {
          image.onload = image.onerror = null
          image.src = ''
        }
        reject(new Error('Texture load cancelled'))
      }
      this.cancellations.add(cancel)
      this.queue.push(() => {
        if (this.disposed) return
        this.running += 1
        const finish = () => {
          settled = true
          if (image) {
            image.onload = image.onerror = null
            image.src = ''
          }
          this.running -= 1
          this.cancellations.delete(cancel)
          this.flush()
        }
        image = new Image()
        image.crossOrigin = 'anonymous'
        image.decoding = 'async'
        image.onload = () => {
          if (this.disposed) return
          try {
            const aspect = image!.naturalWidth / image!.naturalHeight
            const scale = Math.min(1, this.maxEdge / Math.max(image!.naturalWidth, image!.naturalHeight))
            const canvas = document.createElement('canvas')
            canvas.width = Math.max(1, Math.round(image!.naturalWidth * scale))
            canvas.height = Math.max(1, Math.round(image!.naturalHeight * scale))
            const context = canvas.getContext('2d')!
            const radius = Math.min(canvas.width, canvas.height) * 0.025
            context.beginPath()
            context.roundRect(0, 0, canvas.width, canvas.height, radius)
            context.clip()
            context.drawImage(image!, 0, 0, canvas.width, canvas.height)
            context.strokeStyle = 'rgba(255,255,255,0.2)'
            context.lineWidth = 2
            context.stroke()
            const texture = new THREE.CanvasTexture(canvas)
            texture.colorSpace = THREE.SRGBColorSpace
            texture.anisotropy = this.anisotropy
            this.textures.add(texture)
            this.resident.set(src, texture)
            resolve({ texture, aspect })
          } catch (error) {
            reject(error)
          } finally {
            finish()
          }
        }
        image.onerror = () => {
          reject(new Error(`Unable to load album image: ${src}`))
          finish()
        }
        image.src = src
      })
      this.flush()
    })
    this.cache.set(src, promise)
    return promise
  }

  get residentCount() {
    return this.resident.size
  }

  /** Free a decoded preview's GPU memory; loading it again decodes a fresh copy. */
  evict(src: string) {
    const texture = this.resident.get(src)
    if (!texture) return
    this.resident.delete(src)
    this.textures.delete(texture)
    this.cache.delete(src)
    texture.dispose()
  }

  private flush() {
    while (!this.disposed && this.running < this.concurrency && this.queue.length) this.queue.shift()!()
  }

  dispose() {
    this.disposed = true
    this.queue = []
    this.cancellations.forEach((cancel) => cancel())
    this.cancellations.clear()
    this.textures.forEach((texture) => texture.dispose())
    this.textures.clear()
    this.resident.clear()
    this.cache.clear()
  }
}
