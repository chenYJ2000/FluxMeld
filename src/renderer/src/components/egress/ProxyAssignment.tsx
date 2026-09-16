import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { Users, Wand2, Eraser, ArrowLeftRight } from 'lucide-react'
import type { Account, Provider } from '@/types/electron'

interface ExitInfo {
  id: string
  name?: string
  protocol: string
  host: string
  port: number
}

const DIRECT = '__direct__'

export function ProxyAssignment() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [providers, setProviders] = useState<Provider[]>([])
  const [providerId, setProviderId] = useState('')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [assignment, setAssignment] = useState<Record<string, string | null>>({})
  const [exits, setExits] = useState<ExitInfo[]>([])
  const [maxPerGroup, setMaxPerGroup] = useState(10)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const [list, config] = await Promise.all([
          window.electronAPI.providers.getAll(),
          window.electronAPI.config.get(),
        ])
        setProviders(list.filter((provider) => provider.enabled))
        setMaxPerGroup(config.outboundProxy?.maxAccountsPerGroup ?? 10)
      } catch (error) {
        console.error('Failed to load providers:', error)
      }
    })()
  }, [])

  const loadAssignment = useCallback(async (id: string) => {
    if (!id) return
    try {
      const [accountList, result] = await Promise.all([
        window.electronAPI.accounts.getByProvider(id),
        window.electronAPI.outboundProxy.getAssignment(id),
      ])
      setAccounts(accountList)
      setExits(result.exits)
      setAssignment(result.assignment)
    } catch (error) {
      console.error('Failed to load assignment:', error)
    }
  }, [])

  useEffect(() => {
    void loadAssignment(providerId)
  }, [providerId, loadAssignment])

  const groupOf = (accountId: string): string =>
    assignment[accountId] === undefined || assignment[accountId] === null
      ? DIRECT
      : (assignment[accountId] as string)

  const countFor = (exitId: string): number =>
    accounts.filter((account) => groupOf(account.id) === exitId).length

  const handleAssign = async (accountId: string, exitId: string | null) => {
    if (!providerId) return
    // Rule: moving between proxy groups directly is forbidden; accounts must
    // pass through the direct group first.
    if (exitId && groupOf(accountId) !== DIRECT) {
      toast({
        title: t('egress.assignment.ruleTitle'),
        description: t('egress.assignment.ruleDesc'),
        variant: 'destructive',
      })
      return
    }
    if (exitId && countFor(exitId) >= maxPerGroup) {
      toast({
        title: t('common.error'),
        description: t('egress.assignment.groupFull'),
        variant: 'destructive',
      })
      return
    }
    const next = await window.electronAPI.outboundProxy.setAssignment(providerId, accountId, exitId)
    setAssignment(next)
  }

  const handleAutoAssign = async () => {
    if (!providerId) return
    setBusy(true)
    try {
      const next = await window.electronAPI.outboundProxy.autoAssign(providerId)
      setAssignment(next)
      toast({ title: t('common.success'), description: t('egress.assignment.autoDone') })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: String(error),
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
    if (!providerId) return
    await window.electronAPI.outboundProxy.clearAssignment(providerId)
    setAssignment({})
  }

  const renderAccount = (account: Account) => {
    const group = groupOf(account.id)
    const grouped = group !== DIRECT
    return (
      <div
        key={account.id}
        className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
      >
        <span className="truncate">{account.name}</span>
        {grouped ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => void handleAssign(account.id, null)}
            title={t('egress.assignment.moveToDirect')}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Select
            value={DIRECT}
            onValueChange={(value) =>
              void handleAssign(account.id, value === DIRECT ? null : value)
            }
          >
            <SelectTrigger className="h-7 w-[130px] text-xs">
              <SelectValue placeholder={t('egress.assignment.assignTo')} />
            </SelectTrigger>
            <SelectContent>
              {exits.map((exit) => {
                const full = countFor(exit.id) >= maxPerGroup
                return (
                  <SelectItem key={exit.id} value={exit.id} disabled={full}>
                    {exit.name ?? `${exit.host}:${exit.port}`}
                    {` (${countFor(exit.id)}/${maxPerGroup})`}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        )}
      </div>
    )
  }

  const columns = [
    { id: DIRECT, label: t('egress.assignment.directGroup') },
    ...exits.map((exit) => ({
      id: exit.id,
      label: exit.name ?? `${exit.host}:${exit.port}`,
    })),
  ]

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            <CardTitle>{t('egress.assignment.title')}</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Select value={providerId} onValueChange={setProviderId}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder={t('egress.assignment.selectProvider')} />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handleAutoAssign} disabled={!providerId || busy}>
              <Wand2 className="h-3.5 w-3.5 mr-1" />
              {t('egress.assignment.auto')}
            </Button>
            <Button size="sm" variant="outline" onClick={handleClear} disabled={!providerId}>
              <Eraser className="h-3.5 w-3.5 mr-1" />
              {t('egress.assignment.clear')}
            </Button>
          </div>
        </div>
        <CardDescription>{t('egress.assignment.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {!providerId ? (
          <p className="text-sm text-muted-foreground">{t('egress.assignment.selectProvider')}</p>
        ) : (
          <ScrollArea className="w-full">
            <div className="flex gap-4 pb-4">
              {columns.map((column) => {
                const columnAccounts = accounts.filter(
                  (account) => groupOf(account.id) === column.id,
                )
                return (
                  <div key={column.id} className="min-w-[220px] flex-1 rounded-lg border p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-medium truncate">{column.label}</span>
                      <Badge variant="outline" className="text-xs">
                        {columnAccounts.length}/{maxPerGroup}
                      </Badge>
                    </div>
                    <div className="space-y-2">
                      {columnAccounts.map((account) => renderAccount(account))}
                      {columnAccounts.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          {t('egress.assignment.empty')}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

export default ProxyAssignment
