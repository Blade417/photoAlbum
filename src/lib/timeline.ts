import type { MediaItem } from './media'

export interface MemoryMoment {
  year: number
  month: number
  day: number
  /** Sort key in milliseconds; zone-less times are compared as recorded. */
  time: number
}

type Dated = Pick<MediaItem, 'date' | 'takenAt'>
type Ordered = Pick<MediaItem, 'index' | 'date' | 'takenAt'>

const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})?)?$/

export function memoryMoment(item: Dated): MemoryMoment | null {
  const value = item.date || item.takenAt
  const match = value ? STAMP.exec(value) : null
  if (!match) return null
  if (match[7] === 'Z') {
    // Only the instant is known, so use the viewer's own calendar.
    const instant = new Date(value!)
    if (Number.isNaN(instant.getTime())) return null
    return { year: instant.getFullYear(), month: instant.getMonth() + 1, day: instant.getDate(), time: instant.getTime() }
  }
  const [year, month, day] = match.slice(1, 4).map(Number) as [number, number, number]
  const time = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4] ? `${match[4]}:${match[5]}:${match[6]}` : '12:00:00'}${match[7] ?? 'Z'}`)
  return Number.isNaN(time) ? null : { year, month, day, time }
}

export function formatMoment(moment: MemoryMoment): string {
  return `${moment.year}.${String(moment.month).padStart(2, '0')}.${String(moment.day).padStart(2, '0')}`
}

export function formatMemoryDate(item: Dated): string {
  const moment = memoryMoment(item)
  return moment ? formatMoment(moment) : ''
}

/**
 * Newest first. Undated memories borrow the time of the nearest earlier-numbered
 * dated memory, so they stay among the photos they were added with.
 * Albums without any dates keep their numbering.
 */
export function orderByTime<T extends Ordered>(items: readonly T[]): T[] {
  const byIndex = [...items].sort((left, right) => left.index - right.index)
  const keys = byIndex.map(item => memoryMoment(item)?.time ?? null)
  if (keys.every(key => key === null)) return byIndex
  let previous: number | null = null
  keys.forEach((key, position) => { if (key === null) keys[position] = previous; else previous = key })
  let next: number | null = null
  for (let position = keys.length - 1; position >= 0; position -= 1) {
    if (keys[position] === null) keys[position] = next
    else next = keys[position]
  }
  return byIndex
    .map((item, position) => ({ item, key: keys[position]! }))
    .sort((left, right) => right.key - left.key || right.item.index - left.item.index)
    .map(({ item }) => item)
}

/** Display order: dated memories newest first, then undated ones by number. */
export function orderForDisplay<T extends Ordered>(items: readonly T[]): T[] {
  const dated = items.filter(item => memoryMoment(item))
  const undated = items.filter(item => !memoryMoment(item)).sort((left, right) => left.index - right.index)
  return [...orderByTime(dated), ...undated]
}

export interface YearGroup<T> {
  year: number | null
  items: T[]
}

/** Groups items that are already in display order. */
export function groupByYear<T extends Dated>(items: readonly T[]): YearGroup<T>[] {
  const groups: YearGroup<T>[] = []
  for (const item of items) {
    const year = memoryMoment(item)?.year ?? null
    const last = groups.at(-1)
    if (last && last.year === year) last.items.push(item)
    else groups.push({ year, items: [item] })
  }
  return groups
}

/** Memories from the same calendar day in earlier years, newest first. */
export function onThisDay<T extends Ordered>(items: readonly T[], today = new Date()): T[] {
  return orderByTime(items.filter(item => {
    const moment = memoryMoment(item)
    return moment && moment.month === today.getMonth() + 1 && moment.day === today.getDate() && moment.year < today.getFullYear()
  }))
}
