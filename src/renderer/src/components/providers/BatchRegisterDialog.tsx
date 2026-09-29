/**
 * Batch Register Dialog
 *
 * Phone numbers are confidential and fetched from a company API by the main
 * process; they are never shown to the operator (only a masked form). For each
 * account the dialog opens the provider's official registration page, prefills
 * the fields the provider declares, and lets the operator solve the captcha.
 * When a code API is configured the SMS code is filled automatically.
 *
 * Every provider renders through the same dialog: the per-provider rules
 * (fields, country code, terms links, description, code hint) come from the
 * `ProviderRegistrationInfo` descriptors returned by the main process, so this
 * component never branches on a provider id.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { copyText } from '@/lib/clipboard'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AlertCircle, Check, Copy, KeyRound, Loader2, Play, Square, X } from 'lucide-react'
import type { Provider, ProviderVendor, ProviderRegistrationInfo } from '@/types/electron'

interface BatchRegisterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fixed provider. When omitted the operator picks from `providers`. */
  provider: Provider | null
  /** Selectable providers (those that support assisted registration). */
  providers?: Provider[]
  /** Called once the whole batch finishes so the page can refresh accounts. */
  onCompleted?: () => void
}

type RowStatus = 'idle' | 'pending' | 'saved' | 'failed'

interface RegistrationRow {
  phone: string
  password: string
  status: RowStatus
  error?: string
}

const DEFAULT_COUNTRY_CODE = '+1'

export function BatchRegisterDialog({
  open,
  onOpenChange,
  provider,
  providers,
  onCompleted,
}: BatchRegisterDialogProps) {
  const { t } = useTranslation()
  const [count, setCount] = useState('1')
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [rows, setRows] = useState<RegistrationRow[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [finishedMessage, setFinishedMessage] = useState('')
  const [copied, setCopied] = useState(false)
  const [apiReady, setApiReady] = useState<boolean | null>(null)
  const [codeAutoFill, setCodeAutoFill] = useState(false)
  const [keyWordMissing, setKeyWordMissing] = useState(false)
  const [countryCode, setCountryCode] = useState(DEFAULT_COUNTRY_CODE)
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [registrationInfos, setRegistrationInfos] = useState<ProviderRegistrationInfo[]>([])
  const unsubscribeRef = useRef<(() => void) | null>(null)

  const effectiveProvider =
    provider ?? providers?.find((item) => item.id === selectedProviderId) ?? null
  const registrationInfo =
    registrationInfos.find((info) => info.providerId === effectiveProvider?.id) ?? null

  const needsCountryCode = !!registrationInfo?.needsCountryCode
  const requiresTerms = !!registrationInfo?.requiresTermsConsent
  const generatesPassword = registrationInfo?.generatesPassword ?? true
  const usesEmail = !!registrationInfo?.usesEmail
  const codeHintKey = registrationInfo?.codeHintKey
  const descriptionKey = registrationInfo?.descriptionKey

  const savedCount = rows.filter((r) => r.status === 'saved').length

  // Reset the terms acknowledgement whenever the target provider changes.
  useEffect(() => {
    setAcceptedTerms(false)
  }, [effectiveProvider?.id])

  useEffect(() => {
    if (!open) return
    if (provider) {
      setSelectedProviderId(provider.id)
    } else if (providers?.length && !providers.some((p) => p.id === selectedProviderId)) {
      setSelectedProviderId(providers[0].id)
    }
  }, [open, provider, providers, selectedProviderId])

  // Prefill the country code from the provider's declared default.
  useEffect(() => {
    setCountryCode(registrationInfo?.defaultCountryCode ?? DEFAULT_COUNTRY_CODE)
  }, [registrationInfo?.defaultCountryCode])

  // Load the provider registration descriptors once.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.electronAPI?.providers
      .getRegistrationInfos()
      .then((infos) => {
        if (!cancelled) setRegistrationInfos(infos || [])
      })
      .catch(() => {
        if (!cancelled) setRegistrationInfos([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.electronAPI?.config
      .get()
      .then((config) => {
        if (cancelled) return
        if (usesEmail) {
          const email = config?.emailApi
          const ready = !!email?.enabled && !!email?.token?.trim()
          setApiReady(ready)
          setCodeAutoFill(ready)
          setKeyWordMissing(false)
        } else {
          const api = config?.registrationApi
          setApiReady(!!api?.enabled && !!api?.token?.trim())
          setCodeAutoFill(!!api?.enabled && !!api?.token?.trim())
          setKeyWordMissing(!api?.keyWord?.trim())
        }
      })
      .catch(() => {
        if (!cancelled) setApiReady(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, usesEmail])

  useEffect(() => {
    return () => {
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
    }
  }, [])

  const countryCodeValid = /^\+[1-9]\d{0,3}$/.test(countryCode.trim())
  const canStart =
    apiReady !== false &&
    !!effectiveProvider &&
    (!requiresTerms || acceptedTerms) &&
    (!needsCountryCode || countryCodeValid)

  const handleOpenChange = (next: boolean) => {
    if (!next && isRunning) {
      window.electronAPI?.oauth.cancelBatchRegistration()
    }
    if (!next) {
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      setIsRunning(false)
    }
    onOpenChange(next)
  }

  const handleStart = async () => {
    if (!effectiveProvider) return
    if (requiresTerms && !acceptedTerms) return
    if (needsCountryCode && !countryCodeValid) return
    const total = Math.max(1, Math.floor(Number(count) || 0))

    setRows(
      Array.from({ length: total }, () => ({
        phone: '',
        password: '',
        status: 'idle' as RowStatus,
      })),
    )
    setIsRunning(true)
    setFinishedMessage('')

    unsubscribeRef.current?.()
    unsubscribeRef.current =
      window.electronAPI?.oauth.onProgress((event) => {
        const data = (event.data || {}) as {
          index?: number
          phase?: string
          phone?: string
          password?: string
          error?: string
        }
        if (typeof data.index !== 'number') return

        setRows((prev) =>
          prev.map((row, index) => {
            if (index !== data.index) return row
            const merged = {
              ...row,
              phone: data.phone || row.phone,
              password: data.password || row.password,
            }
            if (data.phase === 'opening') return { ...merged, status: 'pending', error: undefined }
            if (data.phase === 'saved') return { ...merged, status: 'saved', error: undefined }
            if (data.phase === 'failed') {
              return { ...merged, status: 'failed', error: data.error || event.message }
            }
            return merged
          }),
        )
      }) || null

    try {
      const response = await window.electronAPI?.oauth.startBatchRegistration(
        effectiveProvider.id,
        effectiveProvider.id as ProviderVendor,
        total,
        undefined,
        {
          countryCode: needsCountryCode ? countryCode.trim() : undefined,
          acceptedTerms,
        },
      )
      if (response?.results?.length) {
        setRows((previous) =>
          previous.map((row, index) => {
            const result = response.results[index]
            return result
              ? {
                  ...row,
                  phone: result.phone || row.phone,
                  status: result.success ? 'saved' : 'failed',
                  error: result.error,
                }
              : row
          }),
        )
        if (
          response.results.length === 1 &&
          !response.results[0].phone &&
          response.results[0].error
        ) {
          setFinishedMessage(response.results[0].error)
        }
      }
    } catch (error) {
      setFinishedMessage(
        error instanceof Error ? error.message : t('providers.batchRegisterFailedStatus'),
      )
    } finally {
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      setIsRunning(false)
      setFinishedMessage((message) => message || t('providers.batchRegisterFinished'))
      onCompleted?.()
    }
  }

  const handleCancel = () => {
    window.electronAPI?.oauth.cancelBatchRegistration()
  }

  const handleCopyPasswords = async () => {
    const text = rows
      .filter((row) => row.password)
      .map((row, index) => `${index + 1}\t${row.phone || '-'}\t${row.password}`)
      .join('\n')
    if (!text) return
    const ok = await copyText(text)
    if (!ok) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            {t('providers.batchRegister')}
            {effectiveProvider ? ` - ${effectiveProvider.name}` : ''}
          </DialogTitle>
          <DialogDescription>
            {descriptionKey ? t(descriptionKey) : t('providers.batchRegisterDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {!provider && (
            <div className="space-y-2">
              <Label>{t('providers.batchRegisterProvider')}</Label>
              {providers && providers.length > 0 ? (
                <Select
                  value={selectedProviderId}
                  onValueChange={setSelectedProviderId}
                  disabled={isRunning}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('providers.batchRegisterProvider')} />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('providers.batchRegisterNoProvider')}
                </p>
              )}
            </div>
          )}

          {apiReady === false && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {t(
                  usesEmail
                    ? 'providers.batchRegisterEmailApiNotConfigured'
                    : 'providers.batchRegisterApiNotConfigured',
                )}
              </AlertDescription>
            </Alert>
          )}

          {apiReady === true && keyWordMissing && !usesEmail && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{t('providers.batchRegisterKeyWordMissing')}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="batch-count">{t('providers.batchRegisterCount')}</Label>
            <Input
              id="batch-count"
              type="number"
              min={1}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              disabled={isRunning}
            />
            <p className="text-xs text-muted-foreground">
              {codeHintKey
                ? t(codeHintKey)
                : usesEmail
                  ? t('providers.batchRegisterEmailCode')
                  : codeAutoFill
                    ? t('providers.batchRegisterCodeAuto')
                    : t('providers.batchRegisterCodeManual')}
            </p>
          </div>

          {(needsCountryCode || requiresTerms) && (
            <div className="space-y-3">
              {needsCountryCode && (
                <div className="space-y-2">
                  <Label htmlFor="batch-country-code">
                    {t('providers.batchRegisterCountryCode')}
                  </Label>
                  <Input
                    id="batch-country-code"
                    value={countryCode}
                    onChange={(event) => setCountryCode(event.target.value)}
                    placeholder="+1"
                    disabled={isRunning}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('providers.batchRegisterCountryCodeHelp')}
                  </p>
                </div>
              )}
              {requiresTerms && (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={acceptedTerms}
                    onChange={(event) => setAcceptedTerms(event.target.checked)}
                    disabled={isRunning}
                    className="mt-1"
                  />
                  <span>
                    {t('providers.batchRegisterTermsConsent')}{' '}
                    {(registrationInfo?.termsLinks || []).map((link, index) => (
                      <span key={link.url}>
                        {index > 0 && <span> {t('providers.batchRegisterTermsAnd')} </span>}
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          {t(link.labelKey)}
                        </a>
                      </span>
                    ))}
                  </span>
                </label>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            {generatesPassword && rows.some((row) => row.password) && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyPasswords}
                disabled={isRunning}
              >
                {copied ? (
                  <Check className="mr-2 h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="mr-2 h-4 w-4" />
                )}
                {t('providers.batchRegisterCopy')}
              </Button>
            )}
            <span className="text-sm text-muted-foreground ml-auto">
              {t('providers.batchRegisterSaved', { saved: savedCount, total: rows.length })}
            </span>
          </div>

          {rows.length > 0 && (
            <div className="max-h-[240px] overflow-y-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">
                      {t('providers.batchRegisterIndex')}
                    </th>
                    <th className="text-left font-medium px-3 py-2">
                      {usesEmail
                        ? t('providers.batchRegisterEmail')
                        : t('providers.batchRegisterPhone')}
                    </th>
                    {generatesPassword && (
                      <th className="text-left font-medium px-3 py-2">
                        {t('providers.batchRegisterPassword')}
                      </th>
                    )}
                    <th className="text-left font-medium px-3 py-2">{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index} className="border-t">
                      <td className="px-3 py-2">{index + 1}</td>
                      <td className="px-3 py-2 font-mono">{row.phone || '-'}</td>
                      {generatesPassword && (
                        <td className="px-3 py-2 font-mono break-all">{row.password || '-'}</td>
                      )}
                      <td className="px-3 py-2">
                        <RowStatusBadge row={row} t={t} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {finishedMessage && !isRunning && (
            <p className="text-sm text-muted-foreground">{finishedMessage}</p>
          )}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isRunning}>
            {t('common.close')}
          </Button>
          {isRunning ? (
            <Button variant="destructive" onClick={handleCancel}>
              <Square className="mr-2 h-4 w-4" />
              {t('common.cancel')}
            </Button>
          ) : (
            <Button onClick={handleStart} disabled={!canStart}>
              <Play className="mr-2 h-4 w-4" />
              {t('providers.batchRegisterStart')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RowStatusBadge({
  row,
  t,
}: {
  row: RegistrationRow
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  if (row.status === 'saved') {
    return (
      <Badge variant="outline" className="text-green-600 border-green-200">
        <Check className="mr-1 h-3 w-3" />
        {t('providers.batchRegisterSavedStatus')}
      </Badge>
    )
  }

  if (row.status === 'failed') {
    return (
      <Badge variant="outline" className="text-red-600 border-red-200" title={row.error}>
        <X className="mr-1 h-3 w-3" />
        {t('providers.batchRegisterFailedStatus')}
      </Badge>
    )
  }

  if (row.status === 'pending') {
    return (
      <Badge variant="outline" className="text-blue-600 border-blue-200">
        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        {t('providers.batchRegisterPendingStatus')}
      </Badge>
    )
  }

  return <Badge variant="outline">{t('providers.batchRegisterIdleStatus')}</Badge>
}

export default BatchRegisterDialog
