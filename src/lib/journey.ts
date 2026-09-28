import * as THREE from 'three'

interface JourneyCard {
  position: THREE.Vector3
  width: number
  height: number
  roll: number
}

/** Find a nearby approach with a clear view of the chosen billboard. */
export function findJourneyView(
  destination: THREE.Vector3,
  nominalPosition: THREE.Vector3,
  nominalTarget: THREE.Vector3,
  cards: JourneyCard[],
  destinationIndex: number,
): { position: THREE.Vector3; target: THREE.Vector3 } {
  let best = { position: nominalPosition.clone(), target: nominalTarget.clone() }
  const selected = cards[destinationIndex]
  if (!selected) return best

  const positionOffset = nominalPosition.clone().sub(destination)
  const targetOffset = nominalTarget.clone().sub(destination)
  const up = new THREE.Vector3(0, 1, 0)
  const samples = [
    [0, 0], [-0.4, -0.4], [0, -0.4], [0.4, -0.4],
    [-0.4, 0], [0.4, 0], [-0.4, 0.4], [0, 0.4], [0.4, 0.4],
  ] as const
  const rolls = cards.map(card => ({ cosine: Math.cos(card.roll), sine: Math.sin(card.roll) }))
  let bestBlocked = Infinity

  function countBlocked(position: THREE.Vector3, target: THREE.Vector3) {
    const inverseView = new THREE.Quaternion()
      .setFromRotationMatrix(new THREE.Matrix4().lookAt(position, target, up))
      .invert()
    const centers = cards.map(card => card.position.clone().sub(position).applyQuaternion(inverseView))
    const selectedCenter = centers[destinationIndex]!
    const selectedRoll = rolls[destinationIndex]!
    let blocked = 0

    for (const [x, y] of samples) {
      // All scene cards face the camera, with only their own roll remaining.
      const offsetX = x * selected.width
      const offsetY = y * selected.height
      const sampleX = selectedCenter.x + offsetX * selectedRoll.cosine - offsetY * selectedRoll.sine
      const sampleY = selectedCenter.y + offsetX * selectedRoll.sine + offsetY * selectedRoll.cosine
      for (let index = 0; index < cards.length; index += 1) {
        if (index === destinationIndex) continue
        const center = centers[index]!
        const fraction = center.z / selectedCenter.z
        // Intersect this ray with a billboard plane strictly before the subject.
        if (fraction <= 0 || fraction >= 1) continue
        const dx = sampleX * fraction - center.x
        const dy = sampleY * fraction - center.y
        const roll = rolls[index]!
        const localX = dx * roll.cosine + dy * roll.sine
        const localY = -dx * roll.sine + dy * roll.cosine
        const card = cards[index]!
        if (Math.abs(localX) <= card.width / 2 && Math.abs(localY) <= card.height / 2) {
          blocked += 1
          break
        }
      }
    }
    return blocked
  }

  // Preserve the familiar framing when it is clear; rotate both camera and aim
  // around the destination only when another memory would cover the subject.
  for (const pitch of [0, 20, -20]) {
    for (const yaw of [0, 30, -30, 60, -60, 90, -90, 120, -120, 180]) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(yaw), 0, 'YXZ',
      ))
      const position = positionOffset.clone().applyQuaternion(rotation).add(destination)
      const target = targetOffset.clone().applyQuaternion(rotation).add(destination)
      const blocked = countBlocked(position, target)
      if (blocked < bestBlocked) {
        best = { position, target }
        bestBlocked = blocked
      }
      if (blocked === 0) return best
    }
  }
  return best
}
