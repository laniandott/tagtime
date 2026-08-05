import React, { useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import TimerPage from './pages/TimerPage'
import TodosPage from './pages/TodosPage'
import StatsPage from './pages/StatsPage'
import TagsPage from './pages/TagsPage'
import CalendarPage from './pages/CalendarPage'
import { useStore } from './store'

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: any }> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error }
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error('Uncaught React Error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 p-4 text-center">
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 max-w-md w-full shadow-lg space-y-4">
            <div className="text-3xl">⚠️</div>
            <h2 className="text-base font-bold text-gray-800 dark:text-gray-100">页面渲染遇到了一个异常</h2>
            <div className="text-xs text-red-500 font-mono bg-red-50 dark:bg-red-900/20 p-3 rounded-lg text-left break-all max-h-32 overflow-y-auto">
              {String(this.state.error?.message || this.state.error)}
            </div>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null })
                window.location.reload()
              }}
              className="px-4 py-2 bg-brand text-white text-xs font-medium rounded-xl hover:bg-brand-600 transition-colors"
            >
              🔄 刷新页面重试
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const loadAll = useStore((s) => s.loadAll)

  useEffect(() => {
    loadAll()
  }, [loadAll])

  return (
    <ErrorBoundary>
      <Layout>
        <Routes>
          <Route path="/" element={<TimerPage />} />
          <Route path="/todos" element={<TodosPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/tags" element={<TagsPage />} />
        </Routes>
      </Layout>
    </ErrorBoundary>
  )
}
