import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { Router, CheckCircle2, RefreshCw, Loader2, XCircle } from 'lucide-react'

export function GeneralSettings() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [enabled, setEnabled] = useState(false)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [proxyUrl, setProxyUrl] = useState('')
  const [node, setNode] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<{ available: boolean; error?: string } | null>(
    null,
  )

  const refresh = useCallback(async () => {
    try {
      const status = await window.electronAPI.outboundProxy.getStatus()
      setEnabled(status.enabled)
      setSourceId(status.sourceId)
      setProxyUrl(status.proxyUrl)
      setNode(status.node)
    } catch (error) {
      console.error('Failed to load egress status:', error)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleToggle = async (value: boolean) => {
    if (value) {
      const result = await window.electronAPI.outboundProxy.enable()
      if (!result.success) {
        toast({
          title: t('common.error'),
          description: result.error || t('egress.general.enableFailed'),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('common.success'), description: t('egress.general.enabledToast') })
    } else {
      await window.electronAPI.outboundProxy.disable()
      toast({ title: t('common.success'), description: t('egress.general.disabledToast') })
    }
    await refresh()
  }

  const handleCheck = async () => {
    setChecking(true)
    try {
      const result = await window.electronAPI.outboundProxy.check()
      setCheckResult(result)
    } catch (error) {
      setCheckResult({ available: false, error: String(error) })
    } finally {
      setChecking(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Router className="h-5 w-5 text-primary" />
          <CardTitle>{t('egress.general.title')}</CardTitle>
          {enabled && (
            <Badge variant="default" className="bg-green-500 hover:bg-green-600">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              {t('egress.general.active')}
            </Badge>
          )}
        </div>
        <CardDescription>{t('egress.general.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between space-x-2">
          <div className="space-y-0.5">
            <Label>{t('egress.general.enable')}</Label>
            <p className="text-sm text-muted-foreground">{t('egress.general.enableDesc')}</p>
          </div>
          <Switch checked={enabled} onCheckedChange={(value) => void handleToggle(value)} />
        </div>

        <div className="flex items-center justify-between space-x-2 pt-4 border-t">
          <div className="space-y-0.5">
            <Label>{t('egress.general.check')}</Label>
            <p className="text-sm text-muted-foreground">
              {proxyUrl ? `${proxyUrl}${node ? ` · ${node}` : ''}` : t('egress.general.checkDesc')}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleCheck} disabled={checking}>
            {checking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
            )}
            {t('egress.general.checkButton')}
          </Button>
        </div>

        {checkResult && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50">
            {checkResult.available ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-emerald-600 dark:text-emerald-500">
                  {t('egress.general.available')}
                </p>
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                <p className="text-sm text-destructive">
                  {checkResult.error || t('egress.general.unavailable')}
                </p>
              </>
            )}
          </div>
        )}

        <div className="pt-4 border-t text-xs text-muted-foreground">
          {t('egress.general.activeSource')}: {sourceId || t('egress.general.none')}
        </div>
      </CardContent>
    </Card>
  )
}

export default GeneralSettings
