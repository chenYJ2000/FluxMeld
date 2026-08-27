import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { Router, CheckCircle2, XCircle, RefreshCw, Loader2 } from 'lucide-react'

interface OutboundProxyConfigProps {
  onConfigChange?: () => void
}

export function OutboundProxyConfig({ onConfigChange }: OutboundProxyConfigProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [enabled, setEnabled] = useState(false)
  const [controllerUrl, setControllerUrl] = useState<string | null>(null)
  const [proxyPorts, setProxyPorts] = useState<number[]>([])
  const [nodes, setNodes] = useState<string[]>([])
  const [currentNode, setCurrentNode] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [loadingNodes, setLoadingNodes] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.outboundProxy.getStatus()
      setEnabled(status.enabled)
      setControllerUrl(status.controllerUrl)
      setCurrentNode(status.node)
    } catch (error) {
      console.error('Failed to load outbound proxy status:', error)
    }
  }, [])

  const refreshNodes = useCallback(async () => {
    setLoadingNodes(true)
    try {
      const nodeList = await window.electronAPI.outboundProxy.getNodes()
      setNodes(nodeList)
      const status = await window.electronAPI.outboundProxy.getStatus()
      setCurrentNode(status.node)
    } catch (error) {
      console.error('Failed to load proxy nodes:', error)
    } finally {
      setLoadingNodes(false)
    }
  }, [])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  const handleCheck = async () => {
    setChecking(true)
    setCheckError(null)
    try {
      const result = await window.electronAPI.outboundProxy.check()
      setChecked(true)
      setControllerUrl(result.controllerUrl)
      setProxyPorts(result.proxyPorts)
      if (!result.available) {
        setCheckError(result.error || t('proxy.outboundCheckFailed'))
        toast({
          title: t('common.error'),
          description: result.error || t('proxy.outboundCheckFailed'),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('common.success'),
          description: t('proxy.outboundAvailable'),
        })
      }
    } catch (error) {
      setChecked(true)
      setCheckError(t('proxy.outboundCheckFailed'))
      toast({
        title: t('common.error'),
        description: t('proxy.outboundCheckFailed'),
        variant: 'destructive',
      })
    } finally {
      setChecking(false)
    }
  }

  const handleEnable = async () => {
    setCheckError(null)
    const result = await window.electronAPI.outboundProxy.enable()
    if (!result.success) {
      setCheckError(result.error || t('proxy.outboundEnableFailed'))
      toast({
        title: t('common.error'),
        description: result.error || t('proxy.outboundEnableFailed'),
        variant: 'destructive',
      })
      return false
    }
    setEnabled(true)
    setCurrentNode(result.node ?? null)
    toast({
      title: t('common.success'),
      description: t('proxy.outboundEnabledToast'),
    })
    onConfigChange?.()
    refreshNodes()
    return true
  }

  const handleDisable = async () => {
    await window.electronAPI.outboundProxy.disable()
    setEnabled(false)
    setCurrentNode(null)
    refreshStatus()
    toast({
      title: t('common.success'),
      description: t('proxy.outboundDisabled'),
    })
    onConfigChange?.()
  }

  const handleNodeChange = async (name: string) => {
    const result = await window.electronAPI.outboundProxy.selectNode(name)
    if (result.success) {
      setCurrentNode(name)
      toast({
        title: t('common.success'),
        description: t('proxy.outboundNodeChanged'),
      })
    } else {
      toast({
        title: t('common.error'),
        description: result.error || t('proxy.outboundNodeChangeFailed'),
        variant: 'destructive',
      })
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Router className="h-5 w-5 text-primary" />
          <CardTitle>{t('proxy.outboundProxy')}</CardTitle>
          {enabled && (
            <Badge variant="default" className="bg-green-500 hover:bg-green-600">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              {t('proxy.outboundActive')}
            </Badge>
          )}
        </div>
        <CardDescription>{t('proxy.outboundProxyDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between space-x-2">
          <div className="space-y-0.5">
            <Label>{t('proxy.outboundEnabled')}</Label>
            <p className="text-sm text-muted-foreground">
              {t('proxy.outboundEnabledDesc')}
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(value) => {
              if (value) {
                void handleEnable()
              } else {
                void handleDisable()
              }
            }}
            disabled={checking}
          />
        </div>

        <div className="flex items-center justify-between space-x-2 pt-2 border-t">
          <div className="space-y-0.5">
            <Label>{t('proxy.outboundCheck')}</Label>
            <p className="text-sm text-muted-foreground">
              {controllerUrl ? controllerUrl : t('proxy.outboundCheckDesc')}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleCheck} disabled={checking}>
            {checking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
            )}
            {t('proxy.outboundCheckButton')}
          </Button>
        </div>

        {checked && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50">
            {checkError ? (
              <>
                <XCircle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                <p className="text-sm text-destructive">{checkError}</p>
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                <div className="space-y-0.5">
                  <p className="text-sm text-emerald-600 dark:text-emerald-500">
                    {t('proxy.outboundAvailable')}
                  </p>
                  {proxyPorts.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t('proxy.outboundPorts')}: {proxyPorts.join(', ')}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <div className="space-y-2 pt-2 border-t">
          <div className="flex items-center justify-between">
            <Label>{t('proxy.outboundNode')}</Label>
            <Button
              variant="ghost"
              size="sm"
              onClick={refreshNodes}
              disabled={loadingNodes}
              className="h-8 px-2"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loadingNodes ? 'animate-spin' : ''}`} />
              {t('common.refresh')}
            </Button>
          </div>

          <Select
            value={currentNode ?? ''}
            onValueChange={handleNodeChange}
            disabled={!enabled || nodes.length === 0}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('proxy.outboundSelectNode')} />
            </SelectTrigger>
            <SelectContent>
              {nodes.map((node) => (
                <SelectItem key={node} value={node}>
                  {node}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t('proxy.outboundNodeDesc')}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

export default OutboundProxyConfig