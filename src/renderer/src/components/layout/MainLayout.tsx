import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'

export function MainLayout() {
  const location = useLocation()
  const isDashboard = location.pathname === '/'

  return (
    <div className="command-shell">
      <div className="command-grid" aria-hidden="true" />
      <Sidebar />
      <section className="command-workspace">
        {!isDashboard && <Header />}
        <main
          className={isDashboard ? 'command-content command-content-dashboard' : 'command-content'}
        >
          <div
            className={
              isDashboard
                ? 'command-content-frame dashboard-content-frame'
                : 'command-content-frame'
            }
          >
            <Outlet />
          </div>
        </main>
      </section>
    </div>
  )
}
