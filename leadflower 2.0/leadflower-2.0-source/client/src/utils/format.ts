export function formatDate(value?: string | number | Date): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function formatNumber(value?: number): string {
  return new Intl.NumberFormat().format(value ?? 0)
}

export function formatDuration(milliseconds?: number): string {
  if (milliseconds === undefined) return '—'
  if (milliseconds < 1000) return `${milliseconds} ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.round((milliseconds % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function titleCase(value: string): string {
  return value.replace(/[._-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function percentage(part: number, whole?: number | null): number {
  if (!whole || whole <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)))
}
