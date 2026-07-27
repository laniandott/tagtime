import { Routes, Route } from 'react-router-dom'
import { useEffect } from 'react'
import Layout from './components/Layout'
import TimerPage from './pages/TimerPage'
import TodosPage from './pages/TodosPage'
import StatsPage from './pages/StatsPage'
import TagsPage from './pages/TagsPage'
import CalendarPage from './pages/CalendarPage'
import { useStore } from './store'

export default function App() {
  const loadAll = useStore((s) => s.loadAll)

  useEffect(() => {
    loadAll()
  }, [loadAll])

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<TimerPage />} />
        <Route path="/todos" element={<TodosPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route path="/tags" element={<TagsPage />} />
      </Routes>
    </Layout>
  )
}
