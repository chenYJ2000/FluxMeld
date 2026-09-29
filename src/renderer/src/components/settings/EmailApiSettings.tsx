import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { useSettingsStore } from '@/stores/settingsStore'
import { Mail, Save } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { EmailApiConfig } from '@/types/electron'

const FALLBACK: EmailApiConfig = {
  enabled: false,
  service: 'tigrmail',
  baseUrl: 'https://api.tigrmail.com',
  token: '',
  domain: '',
  pollTimeoutMs: 180000,
}

const SERVICE_DEFAULTS: Record<
  EmailApiConfig['service'],
  { baseUrl: string; placeholder: string }
> = {
  tigrmail: { baseUrl: 'https://api.tigrmail.com', placeholder: 'API token' },
  yyds: { baseUrl: 'https://maliapi.215.im', placeholder: 'AC-xxxxxx' },
}

export function EmailApiSettings() {
  const { t } = useTranslation()
  const { config, updateConfig } = useSettingsStore()
  const [draft, setDraft] = useState<EmailApiConfig>(FALLBACK)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (config?.emailApi) {
      setDraft({
        ...FALLBACK,
        ...config.emailApi,
        baseUrl: config.emailApi.baseUrl?.trim() || FALLBACK.baseUrl,
      })
    }
  }, [config])

  const patch = (updates: Partial<EmailApiConfig>) => {
    setDraft((prev) => ({ ...prev, ...updates }))
    setSaved(false)
  }

  const handleServiceChange = (service: EmailApiConfig['service']) => {
    // Reset the base URL to the selected backend's default when it was pointing
    // at another backend's default.
    const isDefaultish =
      !draft.baseUrl?.trim() ||
      Object.values(SERVICE_DEFAULTS).some((s) => s.baseUrl === draft.baseUrl.trim())
    patch({
      service,
      baseUrl: isDefaultish ? SERVICE_DEFAULTS[service].baseUrl : draft.baseUrl,
    })
  }

  const handleSave = async () => {
    await updateConfig({ emailApi: draft })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5" />
          {t('settings.emailApi')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('settings.emailApiHelp')}</p>

        <div className="flex items-center justify-between">
          <Label htmlFor="email-api-enabled">{t('settings.emailApiEnabled')}</Label>
          <Switch
            id="email-api-enabled"
            checked={draft.enabled}
            onCheckedChange={(enabled) => patch({ enabled })}
          />
        </div>

        <Separator />

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t('settings.emailApiService')}</Label>
            <Select value={draft.service} onValueChange={handleServiceChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tigrmail">tigrmail (api.tigrmail.com)</SelectItem>
                <SelectItem value="yyds">215.im (maliapi.215.im)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t('settings.emailApiBaseUrl')}</Label>
            <Input
              placeholder={SERVICE_DEFAULTS[draft.service].baseUrl}
              value={draft.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t('settings.emailApiToken')}</Label>
            <Input
              type="password"
              placeholder={SERVICE_DEFAULTS[draft.service].placeholder}
              value={draft.token}
              onChange={(e) => patch({ token: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t('settings.emailApiDomain')}
              </Label>
              <Input
                placeholder="den.tigrmail.com"
                value={draft.domain}
                onChange={(e) => patch({ domain: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t('settings.emailApiDomainHelp')}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t('settings.emailApiPollTimeout')}
              </Label>
              <Input
                type="number"
                value={draft.pollTimeoutMs}
                onChange={(e) => patch({ pollTimeoutMs: Number(e.target.value) || 0 })}
              />
            </div>
          </div>
        </div>

        <Separator />

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} size="sm">
            <Save className="mr-2 h-4 w-4" />
            {t('common.save')}
          </Button>
          {saved && <span className="text-sm text-green-600">{t('common.saved')}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

export default EmailApiSettings
