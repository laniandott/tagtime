import { NavLink } from 'react-router-dom'

const navItems = [
  { to: '/', label: '计时', icon: '⏱' },
  { to: '/todos', label: '待办', icon: '✓' },
  { to: '/calendar', label: '日历', icon: '📅' },
  { to: '/stats', label: '统计', icon: '📊' },
  { to: '/tags', label: '标签', icon: '🏷' },
]

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-10 bg-white/80 dark:bg-gray-950/80 backdrop-blur-md border-b border-gray-100 dark:border-gray-800/60">
        <div className="max-w-4xl mx-auto px-2 sm:px-4 h-14 flex items-center justify-between gap-2">
          <div className="flex shrink-0 items-center gap-2 font-semibold text-brand">
            <img src="/favicon.png" alt="TagTime" className="w-7 h-7 rounded" />
            <span className="hidden sm:inline">TagTime</span>
          </div>
          <nav className="flex min-w-0 gap-0 sm:gap-0.5 whitespace-nowrap">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `relative px-3 sm:px-4 py-2.5 text-xs sm:text-sm font-medium whitespace-nowrap transition-all duration-200 ${
                    isActive
                      ? 'text-brand-600 dark:text-brand-400 after:absolute after:bottom-0 after:left-1/2 after:-translate-x-1/2 after:w-6 after:h-0.5 after:rounded-full after:bg-brand-600 dark:after:bg-brand-400 after:transition-all after:duration-300'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-md'
                  }`
                }
              >
                <span className="hidden sm:inline sm:mr-1">{item.icon}</span>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1 w-full mx-auto px-2 sm:px-4 py-4 sm:py-6">{children}</main>
    </div>
  )
}
