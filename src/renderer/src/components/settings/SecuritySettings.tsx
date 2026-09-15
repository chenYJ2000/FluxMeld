import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/stores/settingsStore'
import { Lock, FileText, ShieldAlert } from 'lucide-react'

export function SecuritySettings() {
  const { t } = useTranslation()
  const { config, updateConfig } = useSettingsStore()
  const isWeb = window.electronAPI?.platform === 'web'
  const [storagePath, setStoragePath] = useState<string | null>(null)
  const [storagePathError, setStoragePathError] = useState(false)

  useEffect(() => {
    let cancelled = false

    const loadStoragePath = async () => {
      try {
        const path = await window.electronAPI?.store?.getPath?.()
        if (!cancelled) {
          setStoragePath(path ?? null)
        }
      } catch (error) {
        console.error('Failed to load storage path:', error)
        if (!cancelled) {
          setStoragePathError(true)
        }
      }
    }

    void loadStoragePath()

    return () => {
      cancelled = true
    }
  }, [])

  const requestLogConfig = config?.requestLogConfig ?? {
    enabled: true,
    maxEntries: 200,
    includeBodies: false,
    maxBodyChars: 8000,
    redactSensitiveData: true,
  }

  const updateRequestLogConfig = async (updates: Partial<typeof requestLogConfig>) => {
    await updateConfig({
      requestLogConfig: {
        ...requestLogConfig,
        ...updates,
      },
    })
  }

  const storageLocationLabel = isWeb
    ? t('settings.credentialStorageLocationServer')
    : t('settings.credentialStorageLocationLocal')

  const storageLocationValue = storagePathError
    ? t('settings.credentialStorageUnavailable')
    : (storagePath ?? t('settings.credentialStorageLoading'))

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            {t('settings.credentialStorage')}
          </CardTitle>
          <CardDescription>{t('settings.credentialStorageHelp')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4">
            <ShieldAlert className="h-5 w-5 shrink-0 text-destructive" />
            <p className="text-sm text-muted-foreground">
              {t('settings.credentialStorageWarning')}
            </p>
          </div>

          <div className="space-y-1 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-4">
            <Label>{storageLocationLabel}</Label>
            <p className="font-mono text-xs break-all text-muted-foreground">
              {storageLocationValue}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('settings.credentialStorageFileHint')}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t('settings.requestLogRedactSensitive')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-4">
            <div className="space-y-1 pr-3">
              <Label htmlFor="request-log-redact">{t('settings.requestLogRedactSensitive')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('settings.requestLogRedactSensitiveHelp')}
              </p>
            </div>
            <Switch
              id="request-log-redact"
              checked={requestLogConfig.redactSensitiveData}
              onCheckedChange={(checked) => {
                void updateRequestLogConfig({ redactSensitiveData: checked })
              }}
            />
          </div>

          <div className="rounded-xl bg-muted p-4">
            <p className="mb-2 text-sm font-medium">{t('settings.redactionExampleTitle')}</p>
            <div className="space-y-1 font-mono text-xs">
              <p>
                <span className="text-muted-foreground">
                  {t('settings.redactionExampleOriginal')}:{' '}
                </span>
                {'{"api_key": "sk-1234567890abcdef"}'}
              </p>
              <p>
                <span className="text-muted-foreground">
                  {t('settings.redactionExampleMasked')}:{' '}
                </span>
                {'{"api_key": "[REDACTED]"}'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
