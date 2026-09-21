import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settingsStore'
import { KeyRound, Save } from 'lucide-react'
import type { RegistrationApiConfig } from '@/types/electron'

const FALLBACK: RegistrationApiConfig = {
  enabled: false,
  baseUrl: 'https://xbsms.work',
  token: '',
  authMode: 'query',
  keyWord: '',
  province: '全部',
  cardType: '全部',
  codeSource: 'getMsg',
  autoRelease: true,
  minRequestIntervalMs: 1500,
  codePollIntervalMs: 1500,
  codePollTimeoutMs: 180000,
}

const PROVINCES = [
  '全部',
  '北京',
  '天津',
  '上海',
  '重庆',
  '河北',
  '山西',
  '辽宁',
  '吉林',
  '黑龙江',
  '江苏',
  '浙江',
  '安徽',
  '福建',
  '江西',
  '山东',
  '河南',
  '湖北',
  '湖南',
  '广东',
  '海南',
  '四川',
  '贵州',
  '云南',
  '陕西',
  '甘肃',
  '青海',
  '内蒙古',
  '广西',
  '西藏',
  '宁夏',
  '新疆',
]

const CARD_TYPES = ['全部', '实卡', '虚卡']

export function RegistrationApiSettings() {
  const { t } = useTranslation()
  const { config, updateConfig } = useSettingsStore()
  const [draft, setDraft] = useState<RegistrationApiConfig>(FALLBACK)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (config?.registrationApi) {
      setDraft({
        ...FALLBACK,
        ...config.registrationApi,
        baseUrl: config.registrationApi.baseUrl?.trim() || FALLBACK.baseUrl,
      })
    }
  }, [config])

  const patch = (updates: Partial<RegistrationApiConfig>) => {
    setDraft((prev) => ({ ...prev, ...updates }))
    setSaved(false)
  }

  const handleSave = async () => {
    await updateConfig({ registrationApi: draft })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          {t('settings.registrationApi')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('settings.registrationApiHelp')}</p>

        <div className="flex items-center justify-between">
          <Label htmlFor="registration-api-enabled">{t('settings.registrationApiEnabled')}</Label>
          <Switch
            id="registration-api-enabled"
            checked={draft.enabled}
            onCheckedChange={(enabled) => patch({ enabled })}
          />
        </div>

        <Separator />

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              {t('settings.registrationApiBaseUrl')}
            </Label>
            <Input
              placeholder="https://xbsms.work"
              value={draft.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              {t('settings.registrationApiToken')}
            </Label>
            <Input
              type="password"
              placeholder="sk_live_xxxxxxxx"
              value={draft.token}
              onChange={(e) => patch({ token: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t('settings.registrationApiAuthMode')}
              </Label>
              <Select
                value={draft.authMode}
                onValueChange={(value) => patch({ authMode: value as 'query' | 'header' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="query">{t('settings.registrationApiAuthQuery')}</SelectItem>
                  <SelectItem value="header">{t('settings.registrationApiAuthHeader')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t('settings.registrationApiKeyWord')}
              </Label>
              <Input
                placeholder="keyWord"
                value={draft.keyWord}
                onChange={(e) => patch({ keyWord: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t('settings.registrationApiProvince')}
              </Label>
              <Select value={draft.province || '全部'} onValueChange={(province) => patch({ province })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVINCES.map((province) => (
                    <SelectItem key={province} value={province}>
                      {province}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t('settings.registrationApiCardType')}
              </Label>
              <Select value={draft.cardType || '全部'} onValueChange={(cardType) => patch({ cardType })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CARD_TYPES.map((cardType) => (
                    <SelectItem key={cardType} value={cardType}>
                      {cardType}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              {t('settings.registrationApiCodeSource')}
            </Label>
            <Select
              value={draft.codeSource}
              onValueChange={(value) => patch({ codeSource: value as 'getCode' | 'getMsg' })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="getCode">getCode</SelectItem>
                <SelectItem value="getMsg">getMsg</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="registration-api-release">
              {t('settings.registrationApiAutoRelease')}
            </Label>
            <Switch
              id="registration-api-release"
              checked={draft.autoRelease}
              onCheckedChange={(autoRelease) => patch({ autoRelease })}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t('settings.registrationApiMinInterval')}
              </Label>
              <Input
                type="number"
                value={draft.minRequestIntervalMs}
                onChange={(e) => patch({ minRequestIntervalMs: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t('settings.registrationApiPollInterval')}
              </Label>
              <Input
                type="number"
                value={draft.codePollIntervalMs}
                onChange={(e) => patch({ codePollIntervalMs: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t('settings.registrationApiPollTimeout')}
              </Label>
              <Input
                type="number"
                value={draft.codePollTimeoutMs}
                onChange={(e) => patch({ codePollTimeoutMs: Number(e.target.value) || 0 })}
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button size="sm" onClick={handleSave}>
            <Save className="mr-2 h-4 w-4" />
            {saved ? t('settings.registrationApiSaved') : t('common.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export default RegistrationApiSettings
