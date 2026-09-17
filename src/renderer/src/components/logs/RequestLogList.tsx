import { useState, useEffect, useRef, useCallback, useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { List, type RowComponentProps } from 'react-window'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RequestLogDetail } from './RequestLogDetail'
import { RequestLogStats } from './RequestLogStats'
import { Trash2, ChevronLeft, ChevronRight } from 'lucide-react'

interface RequestLogEntry {
  id: string
  timestamp: number
  status: 'success' | 'error'
  statusCode: number
  clientIp?: string
  egressNode?: string
  apiKey?: string
  method: string
  url: string
  model: string
  actualModel?: string
  providerId?: string
  providerName?: string
  accountId?: string
  accountName?: string
  requestBody?: string
  userInput?: string
  responseStatus: number
  responsePreview?: string
  latency: number
  isStream: boolean
  errorMessage?: string
  errorStack?: string
}

interface RequestLogStatsData {
  total: number
  success: number
  error: number
  todayTotal: number
  todaySuccess: number
  todayError: number
}

interface RequestLogFilterOptionsData {
  apiKeys: string[]
  models: string[]
}

interface RowProps {
  logs: RequestLogEntry[]
  onSelectLog: (log: RequestLogEntry) => void
}

const ITEM_HEIGHT = 72
const PAGE_SIZE = 200

function getStatusColor(status: 'success' | 'error', statusCode: number) {
  if (status === 'success') return 'bg-green-500/10 text-green-500 border-green-500/20'
  if (statusCode >= 500) return 'bg-red-500/10 text-red-500 border-red-500/20'
  if (statusCode >= 400) return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'
  return 'bg-red-500/10 text-red-500 border-red-500/20'
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatLatency(ms: number) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function RequestLogList() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<RequestLogEntry[]>([])
  const [stats, setStats] = useState<RequestLogStatsData | null>(null)
  const [filterOptions, setFilterOptions] = useState<RequestLogFilterOptionsData>({
    apiKeys: [],
    models: [],
  })
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [selectedLog, setSelectedLog] = useState<RequestLogEntry | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'error'>('all')
  const [apiKeyFilter, setApiKeyFilter] = useState('all')
  const [modelFilter, setModelFilter] = useState('all')
  const [isLoading, setIsLoading] = useState(true)
  const [showClearDialog, setShowClearDialog] = useState(false)
  const logsRef = useRef<RequestLogEntry[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 800, height: 400 })

  const buildFilter = useCallback(() => {
    return {
      ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
      ...(apiKeyFilter !== 'all' ? { apiKey: apiKeyFilter } : {}),
      ...(modelFilter !== 'all' ? { model: modelFilter } : {}),
    }
  }, [statusFilter, apiKeyFilter, modelFilter])

  const fetchLogs = useCallback(async () => {
    try {
      const result = await window.electronAPI?.requestLogs?.query({
        ...buildFilter(),
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      })
      if (result) {
        if (JSON.stringify(result.logs) !== JSON.stringify(logsRef.current)) {
          logsRef.current = result.logs
          setLogs(result.logs)
        }
        setTotal(result.total)
      }
    } catch (error) {
      console.error('Failed to fetch request logs:', error)
    }
  }, [buildFilter, page])

  const fetchStats = useCallback(async () => {
    try {
      const result = await window.electronAPI?.requestLogs?.getStats(buildFilter())
      if (result) {
        setStats(result)
      }
    } catch (error) {
      console.error('Failed to fetch request log stats:', error)
    }
  }, [buildFilter])

  const fetchFilterOptions = useCallback(async () => {
    try {
      const result = await window.electronAPI?.requestLogs?.getFilterOptions()
      if (result) {
        setFilterOptions(result)
      }
    } catch (error) {
      console.error('Failed to fetch request log filter options:', error)
    }
  }, [])

  const refreshLogs = useCallback(async () => {
    await Promise.all([fetchLogs(), fetchStats(), fetchFilterOptions()])
  }, [fetchLogs, fetchStats, fetchFilterOptions])

  useEffect(() => {
    setIsLoading(true)
    refreshLogs().finally(() => setIsLoading(false))
  }, [refreshLogs])

  useEffect(() => {
    // Only the first page auto-refreshes; other pages refresh on demand so the
    // list does not jump while the user is browsing history.
    if (page !== 1) return
    const interval = setInterval(() => {
      refreshLogs().catch((error) => {
        console.error('Failed to refresh request logs:', error)
      })
    }, 3000)
    return () => clearInterval(interval)
  }, [refreshLogs, page])

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setContainerSize({
          width: containerRef.current.clientWidth,
          height: Math.max(100, Math.min(600, logs.length * ITEM_HEIGHT)),
        })
      }
    }
    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [logs.length])

  const handleClearLogs = async () => {
    await window.electronAPI?.requestLogs?.clear()
    logsRef.current = []
    setLogs([])
    setTotal(0)
    setPage(1)
    await refreshLogs()
    setShowClearDialog(false)
  }

  const handleSelectLog = useCallback(async (log: RequestLogEntry) => {
    setSelectedLog(log)
    try {
      const full = await window.electronAPI?.requestLogs?.getById(log.id)
      if (full) setSelectedLog((current) => (current?.id === log.id ? full : current))
    } catch (error) {
      console.error('Failed to fetch full request log:', error)
    }
  }, [])

  const handleStatusChange = (value: 'all' | 'success' | 'error') => {
    setStatusFilter(value)
    setPage(1)
  }

  const handleApiKeyChange = (value: string) => {
    setApiKeyFilter(value)
    setPage(1)
  }

  const handleModelChange = (value: string) => {
    setModelFilter(value)
    setPage(1)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const RowComponent = useCallback(
    ({
      index,
      style,
      logs: rowLogs,
      onSelectLog,
    }: RowComponentProps<RowProps>): ReactElement | null => {
      const log = rowLogs[index]
      if (!log) return null

      return (
        <div style={style} className="px-2 pb-2" onClick={() => onSelectLog(log)}>
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 cursor-pointer transition-colors h-[68px]">
            <Badge variant="outline" className={getStatusColor(log.status, log.statusCode)}>
              {log.statusCode}
            </Badge>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm truncate">{log.model}</span>
                {log.actualModel && log.actualModel !== log.model && (
                  <span className="text-xs text-muted-foreground">→ {log.actualModel}</span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                <span>{log.providerName || log.providerId}</span>
                {log.accountName && (
                  <>
                    <span>·</span>
                    <span>{log.accountName}</span>
                  </>
                )}
                {log.clientIp && (
                  <>
                    <span>·</span>
                    <span className="font-mono">{log.clientIp}</span>
                  </>
                )}
                {log.egressNode && (
                  <>
                    <span>·</span>
                    <span>{log.egressNode}</span>
                  </>
                )}
                {log.apiKey && (
                  <>
                    <span>·</span>
                    <span className="truncate max-w-48" title={log.apiKey}>
                      {log.apiKey}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-4 text-xs text-muted-foreground flex-shrink-0">
              <span className="tabular-nums">{formatLatency(log.latency)}</span>
              <span>{formatTime(log.timestamp)}</span>
            </div>
          </div>
        </div>
      )
    },
    [],
  )

  const rowProps = useMemo<RowProps>(
    () => ({
      logs,
      onSelectLog: handleSelectLog,
    }),
    [logs, handleSelectLog],
  )

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold mr-1">{t('logs.requestLogs')}</h2>
          <Select value={statusFilter} onValueChange={handleStatusChange}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder={t('logs.filter')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('logs.all')}</SelectItem>
              <SelectItem value="success">{t('common.success')}</SelectItem>
              <SelectItem value="error">{t('common.error')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={apiKeyFilter} onValueChange={handleApiKeyChange}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder={t('logs.filterApiKey')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('logs.allApiKeys')}</SelectItem>
              {filterOptions.apiKeys.map((key) => (
                <SelectItem key={key} value={key}>
                  <span className="truncate max-w-60" title={key}>
                    {key}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={modelFilter} onValueChange={handleModelChange}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder={t('logs.filterModel')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('logs.allModels')}</SelectItem>
              {filterOptions.models.map((model) => (
                <SelectItem key={model} value={model}>
                  <span className="truncate max-w-60" title={model}>
                    {model}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refreshLogs}>
            {t('dashboard.refresh')}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setShowClearDialog(true)}>
            {t('logs.clearLogs')}
          </Button>
        </div>
      </div>

      {stats && <RequestLogStats stats={stats} />}

      <div ref={containerRef} className="flex-1 mt-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            {t('common.loading')}
          </div>
        ) : logs.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            {t('logs.noRequestLogs')}
          </div>
        ) : (
          <List
            rowComponent={RowComponent}
            rowCount={logs.length}
            rowHeight={ITEM_HEIGHT}
            rowProps={rowProps}
            style={{
              width: containerSize.width,
              height: containerSize.height,
            }}
            className="scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
          />
        )}
      </div>

      <div className="flex items-center justify-between mt-3">
        <span className="text-xs text-muted-foreground">
          {t('logs.totalCount', { count: total })}
        </span>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('logs.pageOf', { page, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {selectedLog && <RequestLogDetail log={selectedLog} onClose={() => setSelectedLog(null)} />}

      <Dialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-full bg-destructive/10 flex items-center justify-center">
                <Trash2 className="h-4 w-4 text-destructive" />
              </div>
              {t('logs.clearConfirm')}
            </DialogTitle>
            <DialogDescription>{t('logs.clearConfirmDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClearDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleClearLogs}>
              {t('logs.clearLogs')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
