import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { api, resolveUploadUrl } from '../api'
import { formatDuration, toIsoSafe, useStore } from '../store'
import type { Memo } from '../types'
import { DateTimeSecondPicker } from './DateTimeSecondPicker'
import { MemoEditModal } from '../pages/TimerPage'

type DaysRange = 0 | 1 | 7 | 30

export default function DiaryPanel() {
  const { categories } = useStore()
  const [days, setDays] = useState<DaysRange>(0)
  const [memos, setMemos] = useState<Memo[]>([])
  const [loading, setLoading] = useState(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [editingMemo, setEditingMemo] = useState<Memo | null>(null)
  const [showNewJournalModal, setShowNewJournalModal] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [error, setError] = useState('')
  const loadSequence = useRef(0)

  const loadMemos = useCallback(async () => {
    const sequence = ++loadSequence.current
    setLoading(true)
    try {
      const data = await api.memos.list(days > 0 ? { days } : {})
      if (sequence !== loadSequence.current) return
      setMemos(data)
      setError('')
    } catch (err) {
      if (sequence !== loadSequence.current) return
      // 网络抖动时保留当前列表，避免一次失败把已有日记误清空。
      setError(err instanceof Error ? err.message : '加载日记失败')
    } finally {
      if (sequence === loadSequence.current) setLoading(false)
    }
  }, [days])

  useEffect(() => {
    loadMemos()
  }, [loadMemos])

  const filteredMemos = useMemo(() => {
    const diaryOnlyMemos = memos
      .filter((m) => m.type !== 'point')
      .filter((memo) => {
        if (!filterCat) return true
        const categoryId = memo.tag?.categoryId ?? memo.timeEntry?.tag?.categoryId
        return filterCat === 'none' ? !categoryId : categoryId === filterCat
      })
    if (!searchQuery.trim()) return diaryOnlyMemos
    const query = searchQuery.toLowerCase()
    return diaryOnlyMemos.filter((memo) => {
      const content = memo.content?.toLowerCase() ?? ''
      const tagName = (memo.tag?.name ?? memo.timeEntry?.tag?.name ?? '').toLowerCase()
      return content.includes(query) || tagName.includes(query)
    })
  }, [memos, searchQuery, filterCat])

  return (
    <section className="diary-panel space-y-4" aria-label="日记面板">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5 text-xs font-medium">
            {([0, 1, 7, 30] as const).map((range) => (
              <button
                key={range}
                onClick={() => setDays(range)}
                className={`px-3 py-1 rounded-md transition-colors whitespace-nowrap ${
                  days === range
                    ? 'bg-white dark:bg-gray-700 text-brand shadow-sm font-semibold'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {range === 0 ? '全部' : range === 1 ? '今天' : range === 7 ? '本周' : '本月'}
              </button>
            ))}
          </div>

          <select
            value={filterCat}
            onChange={(event) => setFilterCat(event.target.value)}
            className="text-xs border border-gray-200 dark:border-gray-800 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-900 text-gray-500"
            aria-label="按分类筛选日记"
          >
            <option value="">全部分类</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
            <option value="none">未分类</option>
          </select>

          <div className="relative flex-1 min-w-[180px]">
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="搜索日记…"
              className="input pl-8 py-1.5 text-xs"
            />
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">🔍</span>
          </div>

          <button
            onClick={() => setShowNewJournalModal(true)}
            className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand-600 transition-colors flex items-center gap-1 shadow-xs whitespace-nowrap"
          >
            <span>✍️ 写日记</span>
          </button>
        </div>

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
            <span>{error}</span>
            <button type="button" onClick={() => setError('')} className="hover:underline">关闭</button>
          </div>
        )}

        {loading ? (
          <div className="text-center py-8 text-gray-400 text-sm">加载日记...</div>
        ) : filteredMemos.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-800 p-8 text-center text-gray-400 text-sm">
            {searchQuery
              ? '未找到匹配的日记'
              : days === 0
                ? '暂无日记。在计时界面点击「📝 记日记」即可记录感悟和照片。'
                : `近 ${days === 1 ? '1 天' : `${days} 天`}暂无日记。`}
          </div>
        ) : (
          <div className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-gray-200 dark:before:bg-gray-800">
            {filteredMemos.map((memo) => {
              const timeStr = new Date(memo.createdAt).toLocaleString('zh-CN', {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })
              const tagColor = memo.tag?.color ?? memo.timeEntry?.tag?.color ?? '#6d5efc'
              const tagName = memo.tag?.name ?? memo.timeEntry?.tag?.name ?? '随手记'
              const categoryName = memo.tag?.category?.name ?? memo.timeEntry?.tag?.category?.name
              const images = memo.attachments?.filter((attachment) => attachment.mimeType.startsWith('image/')) ?? []
              const videos = memo.attachments?.filter((attachment) => attachment.mimeType.startsWith('video/')) ?? []

              return (
                <div key={memo.id} className="relative group">
                  <div
                    className="absolute -left-6 top-1.5 w-3 h-3 rounded-full border-2 border-white dark:border-gray-900"
                    style={{ background: tagColor }}
                  />
                  <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4 space-y-3 shadow-sm hover:shadow transition-shadow">
                    <div className="flex items-center justify-between text-xs text-gray-400 flex-wrap gap-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-gray-700 dark:text-gray-200">{timeStr}</span>
                        <span
                          className="px-2 py-0.5 rounded-full font-medium"
                          style={{ backgroundColor: `${tagColor}20`, color: tagColor }}
                        >
                          {categoryName ? `${categoryName} / ` : ''}{tagName}
                        </span>
                        {memo.timeEntry && (
                          <span className="text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                            ⏱ 关联计时: {formatDuration(
                              (memo.timeEntry.endTime
                                ? new Date(memo.timeEntry.endTime).getTime()
                                : Date.now()) - new Date(memo.timeEntry.startTime).getTime(),
                            )}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setEditingMemo(memo)}
                          className="text-gray-300 hover:text-brand opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          编辑
                        </button>
                        <button
                          onClick={async () => {
                            if (!confirm('确定要删除这条日记吗？')) return
                            try {
                              await api.memos.remove(memo.id)
                              await loadMemos()
                            } catch (err) {
                              setError(err instanceof Error ? err.message : '删除日记失败')
                            }
                          }}
                          className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          删除
                        </button>
                      </div>
                    </div>

                    <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed">
                      {memo.content}
                    </div>

                    {images.length > 0 && (
                      <div className={`grid gap-2 ${images.length === 1 ? 'grid-cols-1 max-w-sm' : images.length === 2 ? 'grid-cols-2 max-w-md' : 'grid-cols-3 max-w-lg'}`}>
                        {images.map((image) => (
                          <button
                            key={image.id}
                            type="button"
                            onClick={() => setPreviewImage(resolveUploadUrl(image.path))}
                            className="rounded-lg overflow-hidden border border-gray-100 dark:border-gray-800 bg-gray-100 dark:bg-gray-800 aspect-square group/img relative"
                          >
                            <img
                              src={resolveUploadUrl(image.path)}
                              alt={image.filename}
                              className="w-full h-full object-cover group-hover/img:scale-105 transition-transform"
                            />
                          </button>
                        ))}
                      </div>
                    )}

                    {videos.length > 0 && (
                      <div className="space-y-2 max-w-md pt-1">
                        {videos.map((video) => (
                          <div key={video.id} className="rounded-xl overflow-hidden border border-gray-200 dark:border-gray-800 bg-black">
                            <video
                              src={resolveUploadUrl(video.path)}
                              controls
                              playsInline
                              className="w-full max-h-64 object-contain"
                            />
                            <div className="text-[10px] text-gray-400 px-2 py-1 bg-gray-900 truncate">
                              🎬 {video.filename}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {previewImage && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setPreviewImage(null)}
        >
          <img src={previewImage} alt="全屏预览" className="max-w-full max-h-full rounded-lg object-contain" />
        </div>
      )}

      {editingMemo && (
        <MemoEditModal
          memo={editingMemo}
          onClose={() => setEditingMemo(null)}
          onSaved={() => {
            setEditingMemo(null)
            loadMemos()
          }}
        />
      )}

      {showNewJournalModal && (
        <NewJournalModal
          onClose={() => setShowNewJournalModal(false)}
          onSaved={() => {
            setShowNewJournalModal(false)
            loadMemos()
          }}
        />
      )}
    </section>
  )
}

function toLocalInputWithSeconds(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function NewJournalModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { tags } = useStore()
  const [content, setContent] = useState('')
  const [tagId, setTagId] = useState('')
  const [memoTime, setMemoTime] = useState(toLocalInputWithSeconds(new Date()))
  const [uploading, setUploading] = useState(false)
  const [attachments, setAttachments] = useState<{ filename: string; path: string; mimeType: string; size: number }[]>([])
  const [error, setError] = useState('')

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files || files.length === 0) return
    setUploading(true)
    setError('')
    try {
      const results = await Promise.all(Array.from(files).map((file) => api.memos.upload(file)))
      setAttachments((previous) => [...previous, ...results])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setUploading(false)
      event.target.value = ''
    }
  }

  const save = async () => {
    if (!content.trim() && attachments.length === 0) {
      setError('请输入日记内容或上传图片/视频')
      return
    }
    const memoIso = toIsoSafe(memoTime)
    if (!memoIso) {
      setError('请选择有效的日记时间')
      return
    }
    setError('')
    try {
      await api.memos.create({
        content: content.trim() || '（无文字随记）',
        type: 'diary',
        tagId: tagId || undefined,
        createdAt: memoIso,
        attachments,
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-md mx-4 space-y-4" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">✍️ 新建日记 / 随手记</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">日记时间（精准到秒）</label>
          <DateTimeSecondPicker value={memoTime} onChange={setMemoTime} />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">关联标签（可选）</label>
          <select value={tagId} onChange={(event) => setTagId(event.target.value)} className="input text-sm">
            <option value="">独立日记（不绑定标签）</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>{tag.icon ? `${tag.icon} ` : ''}{tag.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">日记内容 / 感悟与照片</label>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={4}
            placeholder="写下今天的想法、生活随笔、感悟或日志..."
            className="input"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">图片 / 视频附件</label>
          <input
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={handleFileUpload}
            disabled={uploading}
            className="block w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-brand-50 file:text-brand dark:file:bg-brand-900/40 dark:file:text-brand-300 hover:file:bg-brand-100"
          />
          {uploading && <div className="text-xs text-brand mt-1">上传中...</div>}
        </div>

        {attachments.length > 0 && (
          <div className="grid grid-cols-3 gap-2 pt-1">
            {attachments.map((attachment, index) => (
              <div key={`${attachment.path}-${index}`} className="relative rounded-lg overflow-hidden border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800 h-16 flex items-center justify-center">
                {attachment.mimeType.startsWith('image/') ? (
                  <img src={resolveUploadUrl(attachment.path)} alt={attachment.filename} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-sm">🎬 视频</span>
                )}
              </div>
            ))}
          </div>
        )}

        {error && <div className="text-xs text-red-500">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
            取消
          </button>
          <button onClick={save} className="px-4 py-2 rounded-lg text-sm bg-brand text-white hover:bg-brand-600 font-medium">
            保存日记
          </button>
        </div>
      </div>
    </div>
  )
}
