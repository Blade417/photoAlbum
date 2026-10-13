import * as THREE from 'three'

// Far enough to pass behind nearby memories; the layer follows the camera like the distant sky.
const SKY_DISTANCE = 170
const POOL_SIZE = 3

const meteorVertex = `
  attribute vec2 aTrail;
  varying vec2 vTrail;
  void main() {
    vTrail = aTrail;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const meteorFragment = `
  uniform vec3 uHead;
  uniform vec3 uTail;
  uniform float uOpacity;
  varying vec2 vTrail;
  void main() {
    // x runs from the tail (0) to the head (1); y crosses the streak.
    float along = vTrail.x;
    float width = mix(0.08, 1.0, along * along);
    float glow = exp(-pow(abs(vTrail.y) / width, 2.0) * 4.0);
    float alpha = glow * pow(along, 1.6) * (1.0 - smoothstep(0.97, 1.0, along)) * uOpacity;
    gl_FragColor = vec4(mix(uTail, uHead, along * along), alpha);
  }
`

interface Meteor {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  head: THREE.Sprite
  start: THREE.Vector3
  direction: THREE.Vector3
  travel: number
  trail: number
  width: number
  startedAt: number
  duration: number
}

/** Occasional shooting stars across the far sky, drawn from a small reusable pool. */
export class MeteorShower {
  readonly group = new THREE.Group()
  private readonly idle: Meteor[] = []
  private readonly flying: Meteor[] = []
  private readonly headPoint = new THREE.Vector3()
  private readonly tailPoint = new THREE.Vector3()
  private readonly side = new THREE.Vector3()
  private nextAt = 1.5 + Math.random() * 2.5
  private count = 0

  constructor(glow: THREE.Texture) {
    for (let index = 0; index < POOL_SIZE; index += 1) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3))
      geometry.setAttribute('aTrail', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), 2))
      geometry.setIndex([0, 2, 1, 1, 2, 3])
      const material = new THREE.ShaderMaterial({
        uniforms: { uOpacity: { value: 0 }, uHead: { value: new THREE.Color('#fff8ec') }, uTail: { value: new THREE.Color('#9ec2ff') } },
        vertexShader: meteorVertex,
        fragmentShader: meteorFragment,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      })
      const mesh = new THREE.Mesh(geometry, material)
      // The streak is rebuilt every frame, so its bounds are never current.
      mesh.frustumCulled = false
      const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: '#fffaf0', blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      mesh.visible = head.visible = false
      this.group.add(mesh, head)
      this.idle.push({ mesh, head, start: new THREE.Vector3(), direction: new THREE.Vector3(), travel: 0, trail: 0, width: 0, startedAt: 0, duration: 1 })
    }
  }

  /** Meteors launched so far. */
  get launched() {
    return this.count
  }

  /** Moves the flying meteors and launches the next one when due; returns whether one launched. */
  update(camera: THREE.PerspectiveCamera, time: number, allowLaunch: boolean) {
    this.group.position.copy(camera.position)
    let launched = false
    if (!allowLaunch) this.nextAt = Math.max(this.nextAt, time + 1.5)
    else if (time >= this.nextAt) {
      const meteor = this.idle.pop()
      if (meteor) {
        this.launch(meteor, camera, time)
        launched = true
      }
      // Now and then a second one follows closely, as in a real shower.
      this.nextAt = time + (Math.random() < 0.2 ? 0.3 + Math.random() * 0.6 : 3.5 + Math.random() * 6)
    }
    for (let index = this.flying.length - 1; index >= 0; index -= 1) {
      const meteor = this.flying[index]!
      const progress = (time - meteor.startedAt) / meteor.duration
      if (progress < 1) this.draw(meteor, progress)
      else this.retire(this.flying.splice(index, 1)[0]!)
    }
    return launched
  }

  clear() {
    this.flying.splice(0).forEach((meteor) => this.retire(meteor))
  }

  dispose() {
    this.clear()
    this.idle.forEach(({ mesh, head }) => {
      mesh.geometry.dispose()
      mesh.material.dispose()
      head.material.dispose()
    })
    this.group.removeFromParent()
  }

  private launch(meteor: Meteor, camera: THREE.PerspectiveCamera, time: number) {
    const halfHeight = SKY_DISTANCE * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    const halfWidth = halfHeight * camera.aspect
    const reach = Math.min(halfWidth, halfHeight)
    // Enter high in the current view and fall towards the lower left, as if from one radiant.
    const angle = THREE.MathUtils.degToRad(20 + Math.random() * 18)
    meteor.start.set((Math.random() * 1.15 - 0.2) * halfWidth, (0.25 + Math.random() * 0.65) * halfHeight, -SKY_DISTANCE).applyQuaternion(camera.quaternion)
    meteor.direction.set(-Math.cos(angle), -Math.sin(angle), 0).applyQuaternion(camera.quaternion)
    meteor.travel = reach * (0.75 + Math.random() * 0.45)
    meteor.trail = reach * (0.35 + Math.random() * 0.25)
    meteor.width = halfHeight * 0.008
    meteor.head.scale.setScalar(halfHeight * 0.07)
    meteor.startedAt = time
    meteor.duration = 0.9 + Math.random() * 0.6
    meteor.mesh.visible = meteor.head.visible = true
    this.flying.push(meteor)
    this.count += 1
  }

  private draw(meteor: Meteor, progress: number) {
    const { headPoint: head, tailPoint: tail, side } = this
    const travelled = meteor.travel * progress
    head.copy(meteor.start).addScaledVector(meteor.direction, travelled)
    tail.copy(head).addScaledVector(meteor.direction, -Math.min(travelled, meteor.trail))
    // The camera sits at the layer's origin, so this keeps the streak facing it.
    side.crossVectors(meteor.direction, head).setLength(meteor.width)
    const positions = meteor.mesh.geometry.getAttribute('position') as THREE.BufferAttribute
    positions.setXYZ(0, tail.x - side.x, tail.y - side.y, tail.z - side.z)
    positions.setXYZ(1, tail.x + side.x, tail.y + side.y, tail.z + side.z)
    positions.setXYZ(2, head.x - side.x, head.y - side.y, head.z - side.z)
    positions.setXYZ(3, head.x + side.x, head.y + side.y, head.z + side.z)
    positions.needsUpdate = true
    // Flare up quickly, then burn out.
    const opacity = THREE.MathUtils.smoothstep(progress, 0, 0.12) * (1 - THREE.MathUtils.smoothstep(progress, 0.55, 1))
    meteor.mesh.material.uniforms.uOpacity!.value = opacity
    meteor.head.position.copy(head)
    meteor.head.material.opacity = opacity
  }

  private retire(meteor: Meteor) {
    meteor.mesh.visible = meteor.head.visible = false
    this.idle.push(meteor)
  }
}
