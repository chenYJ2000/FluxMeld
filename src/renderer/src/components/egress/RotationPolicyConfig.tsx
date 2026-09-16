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

        <div className="space-y-1">
          <Label htmlFor="rotate-early">{t('egress.rotation.rotateEarly')}</Label>
          <Input
            id="rotate-early"
            type="number"
            min={0}
            value={policy.rotateEarlySeconds}
            onChange={(event) =>
              setPolicy({ ...policy, rotateEarlySeconds: Number(event.target.value) })
            }
            onBlur={() => void persist({ rotateEarlySeconds: policy.rotateEarlySeconds })}
          />
          <p className="text-xs text-muted-foreground">{t('egress.rotation.rotateEarlyHelp')}</p>
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
      </CardContent>
    </Card>
  )
}

export default RotationPolicyConfig
