import * as THREE from 'three'

export interface AlbumVideo {
  readonly video: HTMLVideoElement
  readonly texture: THREE.VideoTexture
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

/** One decoder and GPU texture per source, even when several cards use it. */
export class AlbumVideoPool {
  private readonly entries = new Map<string, AlbumVideo>()
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
    const texture = new THREE.VideoTexture(video)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    const entry: AlbumVideo = {
      video, texture, aspect: 1.5, ready: false, hasPlayed: false,
      failed: false, blocked: false, wanted: false, pending: false,
      listeners: new Set([listener]), cleanup: () => {},
    }
    const notify = () => {
      if (this.disposed) return
      entry.ready = !entry.failed && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
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
    const onError = () => { entry.failed = true; video.pause(); notify() }
    const events: Array<[string, EventListener]> = [
      ['loadedmetadata', notify], ['loadeddata', notify], ['playing', onPlaying],
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
    for (const [src, entry] of this.entries) {
      entry.wanted = sources.has(src)
      if (!entry.wanted && !entry.video.paused) entry.video.pause()
    }
    // Release outgoing playback slots before starting incoming sources.
    for (const [src, entry] of this.entries) if (entry.wanted) this.play(src, entry)
  }

  private play(src: string, entry: AlbumVideo) {
    if (this.disposed || entry.failed || entry.blocked || entry.pending || !entry.video.paused) return
    if (!entry.video.hasAttribute('src')) entry.video.src = src
    entry.pending = true
    entry.video.play().then(() => {
      entry.pending = false
      if (this.disposed || !entry.wanted) entry.video.pause()
    }).catch((error: unknown) => {
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
      entry.cleanup()
      entry.video.pause()
      entry.video.removeAttribute('src')
      entry.video.load()
      entry.texture.dispose()
      entry.listeners.clear()
      entry.video.remove()
    }
    this.entries.clear()
    this.host.remove()
  }
}
