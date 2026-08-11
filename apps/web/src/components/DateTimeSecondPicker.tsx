// 手机友好的秒级时间选择器
// 将 YYYY-MM-DDTHH:mm:ss 字符串拆分为 日期 + 时 + 分 + 秒 分别输入
// 避免手机浏览器的 datetime-local 不支持秒的问题
export function DateTimeSecondPicker({
  value,
  onChange,
}: {
  value: string          // YYYY-MM-DDTHH:mm:ss
  onChange: (v: string) => void
}) {
  const [datePart, timePart = '00:00:00'] = value.split('T')
  const [hh = '00', mm = '00', ss = '00'] = timePart.split(':')

  const update = (newDate: string, newHh: string, newMm: string, newSs: string) => {
    const pad = (s: string) => s.padStart(2, '0').slice(0, 2)
    onChange(`${newDate}T${pad(newHh)}:${pad(newMm)}:${pad(newSs)}`)
  }

  const numInput = (
    val: string,
    min: number,
    max: number,
    onCh: (v: string) => void,
    label: string,
  ) => (
    <div className="flex flex-col items-center gap-0.5">
      <button
        type="button"
        className="w-8 h-6 rounded text-gray-400 hover:text-brand hover:bg-gray-100 dark:hover:bg-gray-800 text-sm leading-none"
        onClick={() => {
          const n = (parseInt(val) + 1 - min) % (max - min + 1) + min
          onCh(String(n).padStart(2, '0'))
        }}
      >▲</button>
      <input
        type="number"
        min={min}
        max={max}
        value={val}
        onChange={(e) => {
          let n = parseInt(e.target.value)
          if (isNaN(n)) n = min
          n = Math.max(min, Math.min(max, n))
          onCh(String(n).padStart(2, '0'))
        }}
        className="w-10 text-center font-mono text-sm border border-gray-200 dark:border-gray-700 rounded-lg py-1 bg-white dark:bg-gray-900 focus:outline-none focus:border-brand"
      />
      <button
        type="button"
        className="w-8 h-6 rounded text-gray-400 hover:text-brand hover:bg-gray-100 dark:hover:bg-gray-800 text-sm leading-none"
        onClick={() => {
          const n = ((parseInt(val) - 1 - min + max - min + 1) % (max - min + 1)) + min
          onCh(String(n).padStart(2, '0'))
        }}
      >▼</button>
      <span className="text-[10px] text-gray-400">{label}</span>
    </div>
  )

  return (
    <div className="flex items-start gap-2 flex-wrap">
      {/* 日期 */}
      <div className="flex-1 min-w-0">
        <input
          type="date"
          value={datePart}
          onChange={(e) => update(e.target.value || datePart, hh, mm, ss)}
          className="input font-mono text-sm w-full"
        />
      </div>
      {/* 时分秒 */}
      <div className="flex items-start gap-1.5 shrink-0">
        {numInput(hh, 0, 23, (v) => update(datePart, v, mm, ss), '时')}
        <span className="mt-5 text-gray-400 font-mono">:</span>
        {numInput(mm, 0, 59, (v) => update(datePart, hh, v, ss), '分')}
        <span className="mt-5 text-gray-400 font-mono">:</span>
        {numInput(ss, 0, 59, (v) => update(datePart, hh, mm, v), '秒')}
      </div>
    </div>
  )
}
