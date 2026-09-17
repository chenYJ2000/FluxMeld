import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { Users, Wand2, Eraser, Plus, Trash2, ArrowLeftRight } from 'lucide-react'
import type { Account, Provider } from '@/types/electron'

interface ExitInfo {
  id: string
  name?: string
  protocol: string
  host: string
  port: number
}

interface GroupInfo {
  id: string
  name: string
}

interface Overview {
  groups: GroupInfo[]
  groupAssignmentEnabled: boolean
  assignment: Record<string, string | null>
  providerTotals: { total: number; byGroup: Record<string, number> }
  globalTotals: { total: number; byGroup: Record<string, number> }
  groupExits: Record<string, ExitInfo | null>
}

const DIRECT = '__direct__'

export function ProxyAssignment() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [providers, setProviders] = useState<Provider[]>([])
  const [providerId, setProviderId] = useState('')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [overview, setOverview] = useState<Overview | null>(null)
  const [leftGroup, setLeftGroup] = useState(DIRECT)
  const [rightGroup, setRightGroup] = useState(DIRECT)
  const [newGroupName, setNewGroupName] = useState('')
  const [autoLimit, setAutoLimit] = useState(10)
  const [countScope, setCountScope] = useState<'global' | 'provider'>('global')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const list = await window.electronAPI.providers.getAll()
        setProviders(list.filter((provider) => provider.enabled))
      } catch (error) {
        console.error('Failed to load providers:', error)
      }
    })()
  }, [])

  const loadOverview = useCallback(async (id: string) => {
    if (!id) return
    try {
      const [accountList, result] = await Promise.all([
        window.electronAPI.accounts.getByProvider(id),
        window.electronAPI.outboundProxy.getAssignment(id),
      ])
      setAccounts(accountList)
      setOverview(result)
    } catch (error) {
      console.error('Failed to load assignment:', error)
    }
  }, [])

  useEffect(() => {
    void loadOverview(providerId)
  }, [providerId, loadOverview])

  const groups = overview?.groups ?? []
  const groupOf = (accountId: string): string => overview?.assignment[accountId] ?? DIRECT

  const accountsFor = (groupId: string): Account[] =>
    accounts.filter((account) => groupOf(account.id) === groupId)

  const move = async (accountId: string, targetGroupId: string) => {
    if (!providerId || !overview) return
    if (groupOf(accountId) === targetGroupId) return
    const next = await window.electronAPI.outboundProxy.setAssignment(
      providerId,
      accountId,
      targetGroupId === DIRECT ? null : targetGroupId,
    )
    setOverview({ ...overview, assignment: next })
  }

  const handleAutoAssign = async () => {
    if (!providerId) return
    setBusy(true)
    try {
      const result = await window.electronAPI.outboundProxy.autoAssign(
        providerId,
        autoLimit,
        countScope,
      )
      setOverview(result)
      toast({ title: t('common.success'), description: t('egress.assignment.autoDone') })
    } catch (error) {
      toast({ title: t('common.error'), description: String(error), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
    if (!providerId) return
    const result = await window.electronAPI.outboundProxy.clearAssignment(providerId)
    setOverview(result)
  }

  const handleAddGroup = async () => {
    const result = await window.electronAPI.outboundProxy.addGroup(newGroupName)
    setNewGroupName('')
    if (!overview) return
    setOverview({ ...overview, groups: [...overview.groups, result] })
  }

  const handleRename = async (groupId: string, name: string) => {
    const groupsNext = await window.electronAPI.outboundProxy.renameGroup(groupId, name)
    if (overview) setOverview({ ...overview, groups: groupsNext })
  }

  const handleDeleteGroup = async (groupId: string) => {
    const groupsNext = await window.electronAPI.outboundProxy.deleteGroup(groupId)
    if (overview) setOverview({ ...overview, groups: groupsNext })
    if (leftGroup === groupId) setLeftGroup(DIRECT)
    if (rightGroup === groupId) setRightGroup(DIRECT)
    await loadOverview(providerId)
  }

  const handleToggleGroupAssignment = async (enabled: boolean) => {
    if (!overview) return
    await window.electronAPI.outboundProxy.setGroupAssignmentEnabled(enabled)
    setOverview({ ...overview, groupAssignmentEnabled: enabled })
    await loadOverview(providerId)
  }

  const countLabel = (groupId: string): string => {
    if (!overview) return ''
    const p = overview.providerTotals.byGroup[groupId] ?? 0
    const g = overview.globalTotals.byGroup[groupId] ?? 0
    return `${p}/${overview.providerTotals.total}：${g}/${overview.globalTotals.total}`
  }

  const groupOptions = [
    { id: DIRECT, name: t('egress.assignment.directGroup') },
    ...groups.map((group) => ({ id: group.id, name: group.name })),
  ]

  const renderSwapList = (groupId: string, targetGroupId: string) => (
    <div className="flex-1 rounded-lg border p-2 min-w-[200px]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium truncate">
          {groupOptions.find((option) => option.id === groupId)?.name}
        </span>
        <Badge variant="outline" className="shrink-0 text-xs">
          {countLabel(groupId)}
        </Badge>
      </div>
      <ScrollArea className="h-[220px]">
        <div className="space-y-1 pr-2">
          {accountsFor(groupId).map((account) => (
            <div
              key={account.id}
              onDoubleClick={() => void move(account.id, targetGroupId)}
              title={t('egress.assignment.doubleClickHint')}
              className="cursor-pointer select-none rounded-md border p-2 text-sm truncate hover:bg-accent"
            >
              {account.name}
            </div>
          ))}
          {accountsFor(groupId).length === 0 && (
            <p className="p-2 text-xs text-muted-foreground">{t('egress.assignment.empty')}</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              <CardTitle>{t('egress.assignment.title')}</CardTitle>
            </div>
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
          </div>
          <CardDescription>{t('egress.assignment.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between space-x-2">
            <div className="space-y-0.5">
              <Label>{t('egress.assignment.groupAssignment')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('egress.assignment.groupAssignmentHelp')}
              </p>
            </div>
            <Switch
              checked={overview?.groupAssignmentEnabled ?? false}
              onCheckedChange={(value) => void handleToggleGroupAssignment(value)}
              disabled={!providerId}
            />
          </div>

          {providerId && overview?.groupAssignmentEnabled && (
            <>
              <div className="flex flex-wrap items-end gap-2 pt-2 border-t">
                <div className="space-y-1">
                  <Label>{t('egress.assignment.leftGroup')}</Label>
                  <Select value={leftGroup} onValueChange={setLeftGroup}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {groupOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <ArrowLeftRight className="mb-2 h-4 w-4 text-muted-foreground" />
                <div className="space-y-1">
                  <Label>{t('egress.assignment.rightGroup')}</Label>
                  <Select value={rightGroup} onValueChange={setRightGroup}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {groupOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1" />
                <div className="space-y-1">
                  <Label>{t('egress.assignment.perGroupLimit')}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={autoLimit}
                    onChange={(event) => setAutoLimit(Number(event.target.value))}
                    className="w-[100px]"
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t('egress.assignment.countScope')}</Label>
                  <Select
                    value={countScope}
                    onValueChange={(value) => setCountScope(value as 'global' | 'provider')}
                  >
                    <SelectTrigger className="w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="global">{t('egress.assignment.scopeGlobal')}</SelectItem>
                      <SelectItem value="provider">
                        {t('egress.assignment.scopeProvider')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button size="sm" onClick={handleAutoAssign} disabled={busy}>
                  <Wand2 className="h-3.5 w-3.5 mr-1" />
                  {t('egress.assignment.auto')}
                </Button>
                <Button size="sm" variant="outline" onClick={handleClear}>
                  <Eraser className="h-3.5 w-3.5 mr-1" />
                  {t('egress.assignment.clear')}
                </Button>
              </div>

              <div className="flex gap-4">
                {renderSwapList(leftGroup, rightGroup)}
                {renderSwapList(rightGroup, leftGroup)}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('egress.assignment.doubleClickHint')}
              </p>
            </>
          )}

          {!providerId && (
            <p className="text-sm text-muted-foreground">{t('egress.assignment.selectProvider')}</p>
          )}
        </CardContent>
      </Card>

      {providerId && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">{t('egress.assignment.groupsTitle')}</CardTitle>
              <div className="flex items-center gap-2">
                <Input
                  value={newGroupName}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  placeholder={t('egress.assignment.newGroupPlaceholder')}
                  className="w-[180px]"
                />
                <Button size="sm" variant="outline" onClick={() => void handleAddGroup()}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  {t('egress.assignment.addGroup')}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4">
              <GroupColumn
                groupId={DIRECT}
                name={t('egress.assignment.directGroup')}
                count={countLabel(DIRECT)}
                accounts={accountsFor(DIRECT)}
                editable={false}
                onRename={handleRename}
                onDelete={handleDeleteGroup}
              />
              {groups.map((group) => (
                <GroupColumn
                  key={group.id}
                  groupId={group.id}
                  name={group.name}
                  count={countLabel(group.id)}
                  accounts={accountsFor(group.id)}
                  editable
                  onRename={handleRename}
                  onDelete={handleDeleteGroup}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

interface GroupColumnProps {
  groupId: string
  name: string
  count: string
  accounts: Account[]
  editable: boolean
  onRename: (groupId: string, name: string) => Promise<void>
  onDelete: (groupId: string) => Promise<void>
}

function GroupColumn({
  groupId,
  name,
  count,
  accounts,
  editable,
  onRename,
  onDelete,
}: GroupColumnProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  useEffect(() => {
    setDraft(name)
  }, [name])

  const commit = () => {
    setEditing(false)
    if (draft.trim() && draft !== name) void onRename(groupId, draft.trim())
  }

  return (
    <div className="min-w-[240px] grow basis-[240px] rounded-lg border p-3 space-y-2">
      <div className="flex items-center gap-2">
        {editable && editing ? (
          <Input
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
              if (event.key === 'Escape') {
                setDraft(name)
                setEditing(false)
              }
            }}
            className="h-7"
          />
        ) : (
          <span
            className="flex-1 text-sm font-medium truncate"
            onDoubleClick={() => editable && setEditing(true)}
          >
            {name}
          </span>
        )}
        <Badge variant="outline" className="shrink-0 text-xs">
          {count}
        </Badge>
        {editable && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => void onDelete(groupId)}
            title={t('common.delete')}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        )}
      </div>
      <ScrollArea className="h-[200px]">
        <div className="space-y-1 pr-2">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="rounded-md border p-2 text-sm truncate"
              title={account.name}
            >
              {account.name}
            </div>
          ))}
          {accounts.length === 0 && (
            <p className="p-2 text-xs text-muted-foreground">{t('egress.assignment.empty')}</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

export default ProxyAssignment
