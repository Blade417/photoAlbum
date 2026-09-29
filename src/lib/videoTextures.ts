import * as THREE from 'three'

export interface AlbumVideo {
  readonly video: HTMLVideoElement
  texture: THREE.VideoTexture | null
  aspect: number
  ready: boolean
  hasPlayed: boolean
  failed: boolean
  blocked: boolean
  wanted: boolean
  pending: boolean
  listeners: Set<(entry: AlbumVideo) => void>
  cleanup: () => void
}

interface VideoEntry extends AlbumVideo {
  generation: number
  resumeAt: number
  lastWantedAt: number
  releaseTimer: number | null
}

// A brief cache avoids reloading at viewport edges without retaining every
// decoded video ever visited during a long session.
const idleGraceMs = 3500
const maxIdleSources = 2

/** One decoder and GPU texture per source, even when several cards use it. */
export class AlbumVideoPool {
  private readonly entries = new Map<string, VideoEntry>()
  private readonly host: HTMLDivElement
  private disposed = false

  constructor(container: HTMLElement, private readonly onChange: () => void) {
    this.host = document.createElement('div')
    this.host.setAttribute('aria-hidden', 'true')
    this.host.dataset.albumVideoPool = 'true'
    // Retain real inline video elements without display:none (mobile playback).
    this.host.style.cssText = 'position:fixed;left:-8px;bottom:0;width:4px;height:4px;overflow:hidden;opacity:.001;pointer-events:none;'
    container.appendChild(this.host)
  }

  register(src: string, listener: (entry: AlbumVideo) => void): AlbumVideo {
    const cached = this.entries.get(src)
    if (cached) {
      cached.listeners.add(listener)
      return cached
    }
    const video = document.createElement('video')
    video.muted = true
    video.defaultMuted = true
    video.loop = true
    video.playsInline = true
    video.autoplay = true
    video.preload = 'none'
    video.crossOrigin = 'anonymous'
    video.setAttribute('muted', '')
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    video.setAttribute('tabindex', '-1')
    video.style.cssText = 'width:4px;height:4px;position:absolute;'
    video.dataset.source = src
    // Assign src only when this source becomes visible; autoplay otherwise
    // overrides preload=none and downloads every video in a large album.
    const entry: VideoEntry = {
      video, texture: null, aspect: 1.5, ready: false, hasPlayed: false,
      failed: false, blocked: false, wanted: false, pending: false,
      generation: 0, resumeAt: 0, lastWantedAt: 0, releaseTimer: null,
      listeners: new Set([listener]), cleanup: () => {},
    }
    const notify = () => {
      if (this.disposed) return
      entry.ready = video.hasAttribute('src') && !entry.failed && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      if (video.videoWidth && video.videoHeight) entry.aspect = video.videoWidth / video.videoHeight
      entry.listeners.forEach((callback) => callback(entry))
      this.onChange()
    }
    const onPlaying = () => {
      if (!entry.wanted || this.disposed) { video.pause(); return }
      entry.hasPlayed = true
      entry.blocked = false
      notify()
    }
    const onMetadata = () => {
      if (entry.resumeAt > 0 && Number.isFinite(video.duration) && video.duration > 0) {
        try { video.currentTime = entry.resumeAt % video.duration } catch { /* A non-seekable source can restart. */ }
      }
      notify()
    }
    const onError = () => {
      if (!video.hasAttribute('src') || !video.error) return
      entry.failed = true
      video.pause()
      notify()
    }
    const events: Array<[string, EventListener]> = [
      ['loadedmetadata', onMetadata], ['loadeddata', notify], ['playing', onPlaying],
      ['pause', notify], ['error', onError],
    ]
    events.forEach(([name, handler]) => video.addEventListener(name, handler))
    entry.cleanup = () => events.forEach(([name, handler]) => video.removeEventListener(name, handler))
    this.entries.set(src, entry)
    this.host.appendChild(video)
    return entry
  }

  /** The caller ranks visible sources by distance and enforces the decoder cap. */
  setVisible(sources: ReadonlySet<string>) {
    if (this.disposed) return
    for (const [src, entry] of this.entries) {
      entry.wanted = sources.has(src)
      if (entry.wanted) {
        entry.lastWantedAt = performance.now()
        if (entry.releaseTimer !== null) window.clearTimeout(entry.releaseTimer)
        entry.releaseTimer = null
      } else {
        if (!entry.video.paused) entry.video.pause()
        if (entry.video.hasAttribute('src') && entry.releaseTimer === null) {
          entry.releaseTimer = window.setTimeout(() => {
            entry.releaseTimer = null
            if (!entry.wanted && !this.disposed) this.release(entry)
          }, idleGraceMs)
        }
      }
    }
    const idle = [...this.entries.values()]
      .filter((entry) => !entry.wanted && entry.video.hasAttribute('src'))
      .sort((left, right) => right.lastWantedAt - left.lastWantedAt)
    idle.slice(maxIdleSources).forEach((entry) => this.release(entry))
    // Release outgoing playback slots before starting incoming sources.
    for (const [src, entry] of this.entries) if (entry.wanted) this.play(src, entry)
  }

  private release(entry: VideoEntry) {
    if (entry.releaseTimer !== null) window.clearTimeout(entry.releaseTimer)
    entry.releaseTimer = null
    if (!entry.video.hasAttribute('src')) return
    entry.generation += 1
    entry.pending = false
    entry.resumeAt = entry.video.currentTime || entry.resumeAt
    entry.video.pause()
    entry.ready = false
    entry.hasPlayed = false
    entry.video.removeAttribute('src')
    entry.video.load()
    // Detach live materials before deleting the corresponding GPU texture.
    entry.listeners.forEach((callback) => callback(entry))
    entry.texture?.dispose()
    entry.texture = null
    this.onChange()
  }

  private play(src: string, entry: VideoEntry) {
    if (this.disposed || entry.failed || entry.blocked || entry.pending || !entry.video.paused) return
    if (!entry.video.hasAttribute('src')) {
      entry.generation += 1
      entry.texture = new THREE.VideoTexture(entry.video)
      entry.texture.colorSpace = THREE.SRGBColorSpace
      entry.texture.minFilter = THREE.LinearFilter
      entry.texture.magFilter = THREE.LinearFilter
      entry.texture.generateMipmaps = false
      entry.video.src = src
    }
    const generation = entry.generation
    entry.pending = true
    entry.video.play().then(() => {
      if (generation !== entry.generation) return
      entry.pending = false
      if (this.disposed || !entry.wanted) entry.video.pause()
    }).catch((error: unknown) => {
      if (generation !== entry.generation) return
      entry.pending = false
      if (this.disposed) return
      if (error instanceof DOMException && error.name === 'NotAllowedError') entry.blocked = true
      // An aborted request is normal when a card leaves the viewport.
      else if (!(error instanceof DOMException && error.name === 'AbortError')) entry.failed = true
      entry.listeners.forEach((callback) => callback(entry))
      this.onChange()
    })
  }

  retryBlocked() {
    for (const [src, entry] of this.entries) {
      if (!entry.wanted) continue
      entry.blocked = false
      this.play(src, entry)
    }
  }

  get playing() {
    return [...this.entries.values()].filter(({ video, ready, failed }) => ready && !failed && !video.paused && !video.ended).length
  }

  publishState(target: HTMLElement) {
    const entries = [...this.entries.values()]
    target.dataset.videoSources = String(entries.length)
    target.dataset.videoResidentSources = String(entries.filter((entry) => entry.video.hasAttribute('src')).length)
    target.dataset.videoPlaying = String(this.playing)
    target.dataset.videoReady = String(entries.filter((entry) => entry.ready && !entry.failed).length)
    target.dataset.videoVisibleSources = String(entries.filter((entry) => entry.wanted).length)
    target.dataset.videoBlocked = String(entries.filter((entry) => entry.blocked).length)
    target.dataset.videoErrors = String(entries.filter((entry) => entry.failed).length)
  }

  dispose() {
    this.disposed = true
    for (const entry of this.entries.values()) {
      entry.wanted = false
      entry.generation += 1
      if (entry.releaseTimer !== null) window.clearTimeout(entry.releaseTimer)
      entry.cleanup()
      entry.video.pause()
      entry.video.removeAttribute('src')
      entry.video.load()
      entry.texture?.dispose()
      entry.listeners.clear()
      entry.video.remove()
    }
    this.entries.clear()
    this.host.remove()
  }
}
