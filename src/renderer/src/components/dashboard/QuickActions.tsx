import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Play, Square, Plus, FileText, Zap, Loader2, Wrench } from 'lucide-react'

export interface QuickActionsProps {
  proxyRunning: boolean
  onToggleProxy: () => void
  onAddAccount: () => void
  onToolCalling: () => void
  onViewLogs: () => void
  isLoading?: boolean
  className?: string
}

export function QuickActions({
  proxyRunning,
  onToggleProxy,
  onAddAccount,
  onToolCalling,
  onViewLogs,
  isLoading,
  className,
}: QuickActionsProps) {
  const { t } = useTranslation()

  return (
    <Card className={cn('relay-actions', className)}>
      <CardHeader className="relay-panel-header">
        <CardTitle className="relay-panel-title">{t('quickActions.title')}</CardTitle>
        <div className="relay-panel-icon">
          <Zap className="h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent className="relay-actions-list">
        <Button
          className={cn(
            'relay-action-primary w-full justify-start',
            proxyRunning ? 'is-running' : '',
          )}
          variant={proxyRunning ? 'secondary' : 'default'}
          onClick={onToggleProxy}
          disabled={isLoading}
        >
          {isLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : proxyRunning ? (
            <Square className="mr-2 h-4 w-4 text-orange-700 dark:text-orange-400" />
          ) : (
            <Play className="mr-2 h-4 w-4" />
          )}
          {isLoading
            ? t('common.loading')
            : proxyRunning
              ? t('quickActions.stopProxy')
              : t('quickActions.startProxy')}
          {proxyRunning && !isLoading && (
            <Badge variant="secondary" className="ml-auto">
              {t('dashboard.running')}
            </Badge>
          )}
        </Button>

        <Button
          className="relay-action-secondary w-full justify-start"
          variant="outline"
          onClick={onAddAccount}
        >
          <Plus className="mr-2 h-4 w-4" />
          {t('quickActions.addAccount')}
        </Button>

        <Button
          className="relay-action-secondary w-full justify-start"
          variant="outline"
          onClick={onToolCalling}
        >
          <Wrench className="mr-2 h-4 w-4" />
          {t('quickActions.toolCalling')}
        </Button>

        <Button
          className="relay-action-secondary w-full justify-start"
          variant="outline"
          onClick={onViewLogs}
        >
          <FileText className="mr-2 h-4 w-4" />
          {t('quickActions.viewLogs')}
        </Button>
      </CardContent>
    </Card>
  )
}
