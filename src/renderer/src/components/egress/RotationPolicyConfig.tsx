import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { Repeat } from 'lucide-react'

interface RotationPolicy {
  strategy: string
  rotateEarlySeconds: number
  verifyBeforeUse: boolean
  verifyTimeoutMs: number
  maxExitAttempts: number
  rotateMinIntervalMs: number
  cooldownBaseMs: number
  cooldownMaxMs: number
}

export function RotationPolicyConfig() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [policy, setPolicy] = useState<RotationPolicy | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await window.electronAPI.outboundProxy.getRotation()
      setPolicy({
        strategy: result.strategy,
        rotateEarlySeconds: result.rotateEarlySeconds,
        verifyBeforeUse: result.verifyBeforeUse,
        verifyTimeoutMs: result.verifyTimeoutMs,
        maxExitAttempts: result.maxExitAttempts,
        rotateMinIntervalMs: result.rotateMinIntervalMs,
        cooldownBaseMs: result.cooldownBaseMs,
        cooldownMaxMs: result.cooldownMaxMs,
      })
    } catch (error) {
      console.error('Failed to load rotation policy:', error)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const persist = async (partial: Partial<RotationPolicy>) => {
    if (!policy) return
    const next = { ...policy, ...partial }
    setPolicy(next)
    try {
      await window.electronAPI.outboundProxy.setRotation(next)
    } catch {
      toast({
        title: t('common.error'),
        description: t('egress.rotation.saveFailed'),
        variant: 'destructive',
      })
    }
  }

  if (!policy) return null

  const numberField = (
    key:
      | 'rotateEarlySeconds'
      | 'verifyTimeoutMs'
      | 'maxExitAttempts'
      | 'rotateMinIntervalMs'
      | 'cooldownBaseMs'
      | 'cooldownMaxMs',
    labelKey: string,
    helpKey: string,
    min: number,
  ) => (
    <div className="space-y-1">
      <Label htmlFor={key}>{t(labelKey)}</Label>
      <Input
        id={key}
        type="number"
        min={min}
        value={policy[key]}
        onChange={(event) =>
          setPolicy({ ...policy, [key]: Number(event.target.value) } as RotationPolicy)
        }
        onBlur={() => void persist({ [key]: policy[key] } as Partial<RotationPolicy>)}
      />
      <p className="text-xs text-muted-foreground">{t(helpKey)}</p>
    </div>
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Repeat className="h-5 w-5 text-primary" />
          <CardTitle>{t('egress.rotation.title')}</CardTitle>
        </div>
        <CardDescription>{t('egress.rotation.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <Label>{t('egress.rotation.strategy')}</Label>
          <Select
            value={policy.strategy}
            onValueChange={(value) => void persist({ strategy: value })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="roundRobin">{t('egress.rotation.roundRobin')}</SelectItem>
              <SelectItem value="lowestLatency">{t('egress.rotation.lowestLatency')}</SelectItem>
              <SelectItem value="random">{t('egress.rotation.random')}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('egress.rotation.strategyHelp')}</p>
        </div>

        <div className="flex items-center justify-between space-x-2">
          <div className="space-y-0.5">
            <Label>{t('egress.rotation.verify')}</Label>
            <p className="text-sm text-muted-foreground">{t('egress.rotation.verifyHelp')}</p>
          </div>
          <Switch
            checked={policy.verifyBeforeUse}
            onCheckedChange={(value) => void persist({ verifyBeforeUse: value })}
          />
        </div>

        <div className="space-y-4 pt-4 border-t">
          {numberField(
            'verifyTimeoutMs',
            'egress.rotation.verifyTimeout',
            'egress.rotation.verifyTimeoutHelp',
            100,
          )}
          {numberField(
            'maxExitAttempts',
            'egress.rotation.maxExitAttempts',
            'egress.rotation.maxExitAttemptsHelp',
            0,
          )}
          {numberField(
            'rotateMinIntervalMs',
            'egress.rotation.rotateMinInterval',
            'egress.rotation.rotateMinIntervalHelp',
            0,
          )}
        </div>

        <div className="space-y-4 pt-4 border-t">
          {numberField(
            'rotateEarlySeconds',
            'egress.rotation.rotateEarly',
            'egress.rotation.rotateEarlyHelp',
            0,
          )}
          {numberField(
            'cooldownBaseMs',
            'egress.rotation.cooldownBase',
            'egress.rotation.cooldownBaseHelp',
            0,
          )}
          {numberField(
            'cooldownMaxMs',
            'egress.rotation.cooldownMax',
            'egress.rotation.cooldownMaxHelp',
            0,
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export default RotationPolicyConfig
