/**
 * Account List Component
 * Displays all accounts under a provider with status and actions
 */

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  MoreVertical,
  Edit,
  Trash2,
  Check,
  X,
  Clock,
  User,
  RefreshCw,
  AlertCircle,
  Activity,
  Plus,
  Trash,
  ShieldCheck,
  Download,
  Upload,
  KeyRound,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Account, AccountStatus, Provider } from '@/types/electron'
import { effectiveTodayUsed } from '../../../../shared/dailyUsage'
import { cn } from '@/lib/utils'

interface AccountListProps {
  accounts: Account[]
  provider?: Provider
  onAddAccount: () => void
  /** Open the assisted batch registration flow (only for providers that support it). */
  onBatchRegister?: () => void
  onValidateAllAccounts?: () => void
  isValidatingAll?: boolean
  onEditAccount: (account: Account) => void
  onDeleteAccount: (id: string) => void
  onValidateAccount: (id: string) => void
  onViewDetail: (account: Account) => void
  /** Toggle the account's independent enable switch (excluded from routing when off). */
  onToggleAccount?: (id: string, enabled: boolean) => void
  /** Export the provider's accounts (credentials included) to a JSON file. */
  onExportAccounts?: () => void
  /** Import accounts from a JSON export file's contents. */
  onImportAccounts?: (jsonData: string) => void | Promise<void>
}

export function AccountList({
  accounts,
  provider,
  onAddAccount,
  onBatchRegister,
  onValidateAllAccounts,
  isValidatingAll = false,
  onEditAccount,
  onDeleteAccount,
  onValidateAccount,
  onViewDetail,
  onToggleAccount,
  onExportAccounts,
  onImportAccounts,
}: AccountListProps) {
  const { t } = useTranslation()
  const [validatingIds, setValidatingIds] = useState<Set<string>>(new Set())
  const [clearingChatsId, setClearingChatsId] = useState<string | null>(null)
  const [showClearChatsDialog, setShowClearChatsDialog] = useState(false)
  const [selectedAccountForClear, setSelectedAccountForClear] = useState<Account | null>(null)
  const [showExportWarning, setShowExportWarning] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  const statusConfig: Record<
    AccountStatus,
    {
      labelKey: string
      color: string
      bgColor: string
      icon: typeof Check
    }
  > = {
    active: {
      labelKey: 'providers.active',
      color: 'text-green-600',
      bgColor: 'bg-green-100',
      icon: Check,
    },
    inactive: {
      labelKey: 'providers.inactive',
      color: 'text-gray-600',
      bgColor: 'bg-gray-100',
      icon: Clock,
    },
    expired: {
      labelKey: 'providers.expired',
      color: 'text-orange-600',
      bgColor: 'bg-orange-100',
      icon: AlertCircle,
    },
    error: {
      labelKey: 'common.error',
      color: 'text-red-600',
      bgColor: 'bg-red-100',
      icon: X,
    },
  }

  const handleValidate = async (id: string) => {
    setValidatingIds((prev) => new Set(prev).add(id))
    try {
      await onValidateAccount(id)
    } finally {
      setValidatingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleClearChats = (account: Account) => {
    setSelectedAccountForClear(account)
    setShowClearChatsDialog(true)
  }

  const confirmClearChats = async () => {
    if (!selectedAccountForClear) return

    setClearingChatsId(selectedAccountForClear.id)
    try {
      const result = await window.electronAPI.accounts.clearChats(selectedAccountForClear.id)
      if (result.success) {
        console.log(t('providers.clearChatsSuccess'))
      } else {
        console.error(result.error || t('providers.clearChatsFailed'))
      }
    } catch (error) {
      console.error('Failed to clear chats:', error)
    } finally {
      setClearingChatsId(null)
      setShowClearChatsDialog(false)
      setSelectedAccountForClear(null)
    }
  }

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || !onImportAccounts) return

    try {
      const text = await file.text()
      await onImportAccounts(text)
    } finally {
      event.target.value = ''
    }
  }

  const confirmExport = () => {
    setShowExportWarning(false)
    onExportAccounts?.()
  }

  const activeCount = accounts.filter((a) => a.status === 'active' && a.enabled !== false).length
  const totalCount = accounts.length

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return '-'
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatUsage = (account: Account) => {
    const used = effectiveTodayUsed(account)
    if (account.dailyLimit) {
      return `${used} / ${account.dailyLimit}`
    }
    return used
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <User className="h-12 w-12 text-muted-foreground opacity-50 mb-4" />
          <p className="text-lg font-medium text-muted-foreground">{t('common.noData')}</p>
          <p className="text-sm text-muted-foreground mb-4">{t('providers.clickToAddProvider')}</p>
          <div className="flex items-center gap-2">
            <Button onClick={onAddAccount}>
              <Plus className="mr-2 h-4 w-4" />
              {t('providers.addAccount')}
            </Button>
            {onBatchRegister && (
              <Button variant="outline" onClick={onBatchRegister}>
                <KeyRound className="mr-2 h-4 w-4" />
                {t('providers.batchRegister')}
              </Button>
            )}
            {onImportAccounts && (
              <>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleImportFile}
                />
                <Button variant="outline" onClick={() => importInputRef.current?.click()}>
                  <Upload className="mr-2 h-4 w-4" />
                  {t('providers.importAccounts')}
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            {t('providers.total')}: {totalCount}
          </span>
          <span>•</span>
          <span className="text-green-600">
            {activeCount} {t('providers.onlineCount')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onValidateAllAccounts && (
            <Button
              variant="outline"
              size="sm"
              onClick={onValidateAllAccounts}
              disabled={isValidatingAll}
            >
              {isValidatingAll ? (
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="mr-2 h-4 w-4" />
              )}
              {isValidatingAll ? t('providers.validatingAll') : t('providers.validateAllAccounts')}
            </Button>
          )}
          {onExportAccounts && (
            <Button variant="outline" size="sm" onClick={() => setShowExportWarning(true)}>
              <Download className="mr-2 h-4 w-4" />
              {t('providers.exportAccounts')}
            </Button>
          )}
          {onImportAccounts && (
            <>
              <input
                ref={importInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleImportFile}
              />
              <Button variant="outline" size="sm" onClick={() => importInputRef.current?.click()}>
                <Upload className="mr-2 h-4 w-4" />
                {t('providers.importAccounts')}
              </Button>
            </>
          )}
          <Button size="sm" onClick={onAddAccount}>
            <Plus className="mr-2 h-4 w-4" />
            {t('providers.addAccount')}
          </Button>
          {onBatchRegister && (
            <Button variant="outline" size="sm" onClick={onBatchRegister}>
              <KeyRound className="mr-2 h-4 w-4" />
              {t('providers.batchRegister')}
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="h-[calc(100vh-400px)]">
        <div className="space-y-3 pr-4">
          {accounts.map((account) => {
            const config = statusConfig[account.status]
            const StatusIcon = config.icon
            const isValidating = validatingIds.has(account.id)
            const isEnabled = account.enabled !== false

            return (
              <Card
                key={account.id}
                className={cn(
                  'hover:shadow-sm transition-shadow cursor-pointer',
                  !isEnabled && 'opacity-60',
                )}
                onClick={() => onViewDetail(account)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div
                        className={cn(
                          'h-10 w-10 rounded-full flex items-center justify-center',
                          config.bgColor,
                        )}
                      >
                        <User className={cn('h-5 w-5', config.color)} />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{account.name}</span>
                          <Badge
                            variant="outline"
                            className={cn('text-xs', config.color, config.bgColor)}
                          >
                            <StatusIcon className="mr-1 h-3 w-3" />
                            {t(config.labelKey)}
                          </Badge>
                          {!isEnabled && (
                            <Badge variant="outline" className="text-xs text-muted-foreground">
                              {t('providers.accountDisabled')}
                            </Badge>
                          )}
                        </div>

                        <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                          {account.email && <span className="truncate">{account.email}</span>}
                          <span>
                            {t('dashboard.totalRequests')}: {account.requestCount || 0}
                          </span>
                          <span>
                            {t('providers.usedToday')}: {formatUsage(account)}
                          </span>
                        </div>

                        {account.status === 'error' && account.errorMessage && (
                          <p className="text-xs text-red-500 mt-1 truncate">
                            {account.errorMessage}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="text-right text-xs text-muted-foreground">
                        <div>{t('providers.lastCheck')}</div>
                        <div>{formatDate(account.lastUsed)}</div>
                      </div>

                      {onToggleAccount && (
                        <div
                          className="flex items-center"
                          onClick={(e) => e.stopPropagation()}
                          title={isEnabled ? t('providers.disableAccount') : t('providers.enableAccount')}
                        >
                          <Switch
                            checked={isEnabled}
                            onCheckedChange={(checked) => onToggleAccount(account.id, checked)}
                          />
                        </div>
                      )}

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" onClick={(e) => e.stopPropagation()}>
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation()
                              onViewDetail(account)
                            }}
                          >
                            <Activity className="mr-2 h-4 w-4" />
                            {t('common.details')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation()
                              handleValidate(account.id)
                            }}
                            disabled={isValidating}
                          >
                            <RefreshCw
                              className={cn('mr-2 h-4 w-4', isValidating && 'animate-spin')}
                            />
                            {isValidating
                              ? t('oauth.validating')
                              : t('providers.validateCredentials')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation()
                              onEditAccount(account)
                            }}
                          >
                            <Edit className="mr-2 h-4 w-4" />
                            {t('providers.editAccount')}
                          </DropdownMenuItem>
                          {/* Clear Chats is shown only for providers that support it */}
                          {provider?.capabilities?.clearChats && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleClearChats(account)
                                }}
                                disabled={clearingChatsId === account.id}
                                className="text-amber-600"
                              >
                                <Trash className="mr-2 h-4 w-4" />
                                {clearingChatsId === account.id
                                  ? t('common.loading')
                                  : t('providers.clearChats')}
                              </DropdownMenuItem>
                            </>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation()
                              onDeleteAccount(account.id)
                            }}
                            className="text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t('providers.deleteAccount')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </ScrollArea>

      {/* Export Warning Dialog */}
      <Dialog open={showExportWarning} onOpenChange={setShowExportWarning}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('providers.exportAccountsWarningTitle')}</DialogTitle>
            <DialogDescription>{t('providers.exportAccountsWarningDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowExportWarning(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={confirmExport}>{t('common.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear Chats Confirmation Dialog */}
      <Dialog open={showClearChatsDialog} onOpenChange={setShowClearChatsDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('providers.clearChats')}</DialogTitle>
            <DialogDescription>
              <div className="space-y-2">
                <p>{t('providers.clearChatsConfirm')}</p>
                <p className="text-amber-600 font-medium">{t('providers.clearChatsWarning')}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowClearChatsDialog(false)
                setSelectedAccountForClear(null)
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={confirmClearChats} className="bg-amber-600 hover:bg-amber-700">
              {t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default AccountList
