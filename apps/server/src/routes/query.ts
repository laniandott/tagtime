// Fastify 的默认查询解析器允许同一个键出现多次，此时运行时值会变成数组。
// 路由如果直接把它断言成 string，可能把数组传给 Prisma 并返回 500。
// 统一把“单值字符串”校验放在路由入口，避免重复参数造成未预期的数据库错误。
export function singleQueryString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

export function invalidQueryFields(fields: Record<string, unknown>): string[] {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && typeof value !== 'string')
    .map(([field]) => field)
}
