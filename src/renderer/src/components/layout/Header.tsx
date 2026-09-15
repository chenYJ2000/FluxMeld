import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import { Languages, Moon, Pause, Play, Radio, Sun } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settingsStore'

const routeTitleKeys: Record<string, string> = {
  '/': 'nav.dashboard',
  '/providers': 'nav.providers',
  '/proxy': 'nav.proxy',
  '/models': 'nav.models',
  '/session': 'nav.session',
  '/api-keys': 'nav.apiKeys',
  '/logs': 'nav.logs',
  '/settings': 'nav.settings',
  '/about': 'nav.about',
}

export function Header() {
  const { t } = useTranslation()
  const location = useLocation()
  const { toggleTheme, isDark } = useTheme()
  const { language, setLanguage } = useSettingsStore()
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyLoading, setProxyLoading] = useState(false)
  const [port, setPort] = useState(8080)
  const [host, setHost] = useState('127.0.0.1')

  useEffect(() => {
    if (!window.electronAPI?.proxy?.onStatusChanged) return

    const unsubscribe = window.electronAPI.proxy.onStatusChanged((status) => {
      setProxyEnabled(status.isRunning)
      if (status.port) setPort(status.port)
      setHost(status.host || '127.0.0.1')
    })

    window.electronAPI.proxy.getStatus().then((status) => {
      setProxyEnabled(status.isRunning)
      if (status.port) setPort(status.port)
      setHost(status.host || '127.0.0.1')
    })

    window.electronAPI.config?.get?.().then((config) => {
      if (!config) return
      setPort(config.proxyPort || 8080)
      setHost(config.proxyHost || '127.0.0.1')
    })

    const unsubscribeConfig = window.electronAPI.config?.onConfigChanged?.((config) => {
      setPort(config.proxyPort || 8080)
      setHost(config.proxyHost || '127.0.0.1')
    })

    return () => {
      unsubscribe()
      unsubscribeConfig?.()
    }
  }, [])

  const handleToggleProxy = async () => {
    if (proxyLoading) return
    setProxyLoading(true)
    try {
      if (proxyEnabled) {
        await window.electronAPI.proxy.stop()
        setProxyEnabled(false)
      } else {
        await window.electronAPI.proxy.start()
        setProxyEnabled(true)
      }
    } finally {
      setProxyLoading(false)
    }
  }

  const toggleLanguage = () => {
    setLanguage(language === 'zh-CN' ? 'en-US' : 'zh-CN')
  }

  const pageTitle = t(routeTitleKeys[location.pathname] || 'nav.dashboard')

  return (
    <header className="command-header drag-region">
      <div className="command-context no-drag">
        <div className="command-context-eyebrow">FLUXMELD / RELAY CONTROL</div>
        <div className="command-context-title">
          <span>{pageTitle}</span>
          <span className="command-context-marker" aria-hidden="true" />
        </div>
      </div>

      <div className="command-header-actions no-drag">
        <div className="command-endpoint" title={`${host}:${port}`}>
          <Radio
            className={cn(
              'h-3.5 w-3.5',
              proxyEnabled ? 'text-[var(--accent-primary)]' : 'text-[var(--text-dim)]',
            )}
          />
          <span className="command-endpoint-label">RELAY</span>
          <span className="command-endpoint-value">
            {host}:{port}
          </span>
        </div>

        <button
          onClick={toggleTheme}
          className="command-icon-button"
          title={isDark ? t('settings.themeLight') : t('settings.themeDark')}
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        <button
          onClick={toggleLanguage}
          className="command-icon-button"
          title={language === 'zh-CN' ? t('header.switchToEnglish') : t('header.switchToChinese')}
        >
          <Languages className="h-4 w-4" />
        </button>

        <button
          onClick={handleToggleProxy}
          disabled={proxyLoading}
          className={cn('command-proxy-button', proxyEnabled && 'is-running')}
          title={proxyEnabled ? t('proxyStatus.stop') : t('proxyStatus.start')}
        >
          <span
            className={cn(
              'command-proxy-indicator',
              proxyLoading && 'animate-pulse',
              proxyEnabled && 'is-running',
            )}
          />
          <span>
            {proxyLoading ? '...' : proxyEnabled ? t('proxyStatus.stop') : t('proxyStatus.start')}
          </span>
          {proxyEnabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
      </div>
    </header>
  )
}
