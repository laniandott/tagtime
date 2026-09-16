export type ActivityRule = {
  period: string
  deadlineTime: string | null
  deadlineDay: number | null
  deadlineAt?: Date | null
}

export function isValidClock(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export function isValidDeadlineDay(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 31
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function clockParts(rule: ActivityRule): [number, number] {
  const value = rule.deadlineTime ?? '23:59'
  if (!isValidClock(value)) return [23, 59]
  const [hour, minute] = value.split(':').map(Number)
  return [hour, minute]
}

/** 根据活动目标规则计算某一周期的截止时间，使用服务器本地时区。 */
export function activityDueDate(rule: ActivityRule, anchor = new Date(), cycleOffset = 0): Date | null {
  const base = new Date(anchor)
  const [hour, minute] = clockParts(rule)

  if (rule.period === 'once') return cycleOffset === 0 ? (rule.deadlineAt ? new Date(rule.deadlineAt) : null) : null

  if (rule.period === 'daily') {
    base.setHours(0, 0, 0, 0)
    base.setDate(base.getDate() + cycleOffset)
    base.setHours(hour, minute, 0, 0)
    return base
  }

  if (rule.period === 'monthly') {
    base.setDate(1)
    base.setMonth(base.getMonth() + cycleOffset)
    const day = Math.min(rule.deadlineDay ?? 1, daysInMonth(base.getFullYear(), base.getMonth()))
    base.setDate(day)
    base.setHours(hour, minute, 0, 0)
    return base
  }

  return null
}
