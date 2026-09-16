import { lstatSync } from 'node:fs'
import { join } from 'node:path'

// 上传目录中的符号链接不应被静态资源服务跟随，否则磁盘上的一个恶意链接
// 可能把 uploads 之外的文件暴露给 HTTP 客户端。检查完整路径上的每一段，
// 既覆盖最终文件，也覆盖指向外部目录的中间目录链接。
export function isSafeUploadPath(pathname: string, root: string): boolean {
  let current = root
  for (const segment of pathname.split('/').filter(Boolean)) {
    current = join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) return false
    } catch {
      // 不存在的路径交给静态服务返回 404；不存在的后续段无需继续检查。
      return true
    }
  }
  return true
}
