import { useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Activity, CheckCircle2, Clock3, Pause, Play, RefreshCw, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  StatsCard,
  ProviderStatusCard,
  RequestChart,
  QuickActions,
  RecentActivity,
} from '@/components/dashboard'
import { useDashboardStore } from '@/stores/dashboardStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'

export function Dashboard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const {
    proxyStatus,
    stats,
    providers,
    activities,
    chartData,
    isLoading,
    error,
    lastUpdated,
    refreshData,
  } = useDashboardStore()
  const { proxyEnabled, setProxyEnabled } = useSettingsStore()
  const hasLoadedRef = useRef(false)

  useEffect(() => {
    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true
      refreshData()
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      useDashboardStore.getState().refreshData()
    }, 60000)

    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (proxyStatus) {
      setProxyEnabled(proxyStatus.isRunning)
    }
  }, [proxyStatus, setProxyEnabled])

  useEffect(() => {
    if (!window.electronAPI?.proxy?.onStatusChanged) return

    const unsubscribe = window.electronAPI.proxy.onStatusChanged((status) => {
      useDashboardStore.getState().setProxyStatus(status)
      setProxyEnabled(status.isRunning)
    })

    return unsubscribe
  }, [setProxyEnabled])

  const handleToggleProxy = useCallback(async () => {
    if (!window.electronAPI?.proxy) return

    try {
      if (proxyStatus?.isRunning) {
        await window.electronAPI.proxy.stop()
        setProxyEnabled(false)
      } else {
        await window.electronAPI.proxy.start()
        setProxyEnabled(true)
      }
      refreshData()
    } catch (err) {
      console.error('Failed to toggle proxy:', err)
    }
  }, [proxyStatus, setProxyEnabled, refreshData])

  const handleAddAccount = useCallback(() => {
    navigate('/providers')
  }, [navigate])

  const handleToolCalling = useCallback(() => {
    navigate('/models?tab=prompts')
  }, [navigate])

  const handleViewLogs = useCallback(() => {
    navigate('/logs')
  }, [navigate])

  const handleActivityClick = useCallback(
    (item: { id: string; type: string; title: string }) => {
      navigate('/logs?tab=request&highlight=' + item.id)
    },
    [navigate],
  )

  const isElectron = !!window.electronAPI
  const isProxyRunning = proxyStatus?.isRunning ?? proxyEnabled
  const endpoint = proxyStatus ? `${proxyStatus.host}:${proxyStatus.port}` : '127.0.0.1:8080'

  return (
    <div className="relay-dashboard space-y-4">
      <section className={cn('relay-overview', isProxyRunning && 'is-live')}>
        <div className="relay-overview-copy">
          <h1>{t('dashboard.title')}</h1>
          <p>{t('dashboard.description')}</p>
        </div>

        <div className="relay-overview-control">
          <div className="relay-status-summary">
            <div className="relay-status-heading">
              <span className={cn('relay-status-dot', isProxyRunning && 'is-live')} />
              <span>{isProxyRunning ? t('dashboard.running') : t('dashboard.stopped')}</span>
            </div>
            <code>{endpoint}</code>
            <span className="relay-status-caption">
              {lastUpdated
                ? `${t('dashboard.lastUpdated')} · ${new Date(lastUpdated).toLocaleTimeString()}`
                : t('dashboard.proxyStatus')}
            </span>
          </div>
          <div className="relay-overview-buttons">
            <Button
              size="sm"
              onClick={handleToggleProxy}
              disabled={isLoading}
              className={cn('relay-primary-button', isProxyRunning && 'is-live')}
            >
              {isProxyRunning ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {isProxyRunning ? t('quickActions.stopProxy') : t('quickActions.startProxy')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshData}
              disabled={isLoading}
              className="relay-secondary-button"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
              {t('dashboard.refresh')}
            </Button>
          </div>
        </div>
      </section>

      {!isElectron && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400">
          <p className="font-medium">{t('dashboard.browserMode')}</p>
          <p>{t('dashboard.browserModeDesc')}</p>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="relay-metrics-grid grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <StatsCard
          className="relay-metric-card"
          title={t('dashboard.totalRequests')}
          value={stats.totalRequests.toLocaleString()}
          icon={Activity}
          trend={{
            value: stats.requestsTrend,
            label: t('dashboard.vsYesterday'),
          }}
        />
        <StatsCard
          className="relay-metric-card"
          title={t('dashboard.successRate')}
          value={`${stats.successRate}%`}
          icon={CheckCircle2}
          trend={{
            value: stats.successRateTrend,
            label: t('dashboard.vsYesterday'),
          }}
        />
        <StatsCard
          className="relay-metric-card"
          title={t('dashboard.avgResponseTime')}
          value={`${stats.avgLatency}ms`}
          icon={Clock3}
          trend={{
            value: stats.latencyTrend,
            label: t('dashboard.vsYesterday'),
          }}
        />
        <StatsCard
          className="relay-metric-card"
          title={t('dashboard.activeAccountCount')}
          value={stats.activeAccounts}
          icon={Users}
          trend={{
            value: stats.accountsTrend,
            label: t('dashboard.vsYesterday'),
          }}
        />
      </div>

      <div className="relay-primary-grid grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RequestChart data={chartData} className="relay-chart-card" />
        </div>
        <div>
          <QuickActions
            proxyRunning={proxyStatus?.isRunning ?? proxyEnabled}
            onToggleProxy={handleToggleProxy}
            onAddAccount={handleAddAccount}
            onToolCalling={handleToolCalling}
            onViewLogs={handleViewLogs}
            isLoading={isLoading}
            className="relay-actions-card"
          />
        </div>
      </div>

      <div className="relay-secondary-grid grid gap-4 lg:grid-cols-2 items-stretch">
        <ProviderStatusCard providers={providers} className="relay-provider-card" />
        <RecentActivity
          activities={activities}
          onItemClick={handleActivityClick}
          className="relay-activity-card"
        />
      </div>
    </div>
  )
}
