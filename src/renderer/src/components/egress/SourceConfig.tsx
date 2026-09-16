import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import {
  Layers,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  Save,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react'

interface SourceFieldVisibility {
  key: string
  equals?: string | number | boolean
  in?: Array<string | number | boolean>
}

interface SourceField {
  key: string
  type: string
  labelKey: string
  placeholder?: string
  helpKey?: string
  options?: Array<{ value: string; labelKey: string }>
  defaultValue?: string | number | boolean
  min?: number
  max?: number
  step?: number
  visibleWhen?: SourceFieldVisibility
}

interface SourceMeta {
  id: string
  labelKey: string
  descriptionKey?: string
  fields: SourceField[]
}

interface SourceEntry {
  id: string
  sourceId: string
  settings: Record<string, unknown>
}

function generateSourceId(): string {
  return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function resolveFieldValue(source: SourceEntry, field: SourceField): unknown {
  return source.settings[field.key] ?? field.defaultValue
}

/** Evaluate a field's `visibleWhen` rule against its controlling field. */
function isFieldVisible(source: SourceEntry, field: SourceField, fields: SourceField[]): boolean {
  const rule = field.visibleWhen
  if (!rule) return true
  const controller = fields.find((candidate) => candidate.key === rule.key)
  const value = controller ? resolveFieldValue(source, controller) : undefined
  if (rule.in) return rule.in.some((candidate) => candidate === value)
  return value === rule.equals
}

export function SourceConfig() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [metas, setMetas] = useState<SourceMeta[]>([])
  const [sources, setSources] = useState<SourceEntry[]>([])
  const [activeSourceId, setActiveSourceId] = useState('')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [checks, setChecks] = useState<
    Record<string, { checking: boolean; result?: { available: boolean; error?: string } }>
  >({})

  const load = useCallback(async () => {
    try {
      const result = await window.electronAPI.outboundProxy.getSources()
      setMetas(result.metas)
      setSources(result.outboundProxy.sources)
      setActiveSourceId(result.outboundProxy.activeSourceId)
      setDirty(false)
    } catch (error) {
      console.error('Failed to load egress sources:', error)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleSave = async () => {
    setSaving(true)
    try {
      const config = await window.electronAPI.config.get()
      const ok = await window.electronAPI.config.update({
        outboundProxy: {
          ...config.outboundProxy,
          sources,
          activeSourceId,
        },
      })
      if (ok) {
        setDirty(false)
        toast({ title: t('common.success'), description: t('egress.sources.saved') })
      } else {
        toast({
          title: t('common.error'),
          description: t('egress.sources.saveFailed'),
          variant: 'destructive',
        })
      }
    } finally {
      setSaving(false)
    }
  }

  const getMeta = (sourceId: string): SourceMeta | undefined =>
    metas.find((meta) => meta.id === sourceId)

  const handleAdd = () => {
    const meta = metas[0]
    if (!meta) return
    const entry: SourceEntry = { id: generateSourceId(), sourceId: meta.id, settings: {} }
    setSources((prev) => [...prev, entry])
    setActiveSourceId((prev) => prev || entry.id)
    setDirty(true)
  }

  const clearCheck = (id: string) => {
    setChecks((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const handleRemove = (id: string) => {
    setSources((prev) => {
      const next = prev.filter((source) => source.id !== id)
      setActiveSourceId((active) => (active === id ? (next[0]?.id ?? '') : active))
      return next
    })
    clearCheck(id)
    setDirty(true)
  }

  const handleModuleChange = (id: string, sourceId: string) => {
    setSources((prev) =>
      prev.map((source) => (source.id === id ? { ...source, sourceId, settings: {} } : source)),
    )
    clearCheck(id)
    setDirty(true)
  }

  const handleCheck = async (source: SourceEntry) => {
    setChecks((prev) => ({ ...prev, [source.id]: { checking: true } }))
    try {
      const result = await window.electronAPI.outboundProxy.checkSource({
        id: source.id,
        sourceId: source.sourceId,
        settings: source.settings,
      })
      setChecks((prev) => ({ ...prev, [source.id]: { checking: false, result } }))
    } catch (error) {
      setChecks((prev) => ({
        ...prev,
        [source.id]: { checking: false, result: { available: false, error: String(error) } },
      }))
    }
  }

  const handleSettingChange = (id: string, key: string, value: unknown) => {
    setSources((prev) =>
      prev.map((source) =>
        source.id === id ? { ...source, settings: { ...source.settings, [key]: value } } : source,
      ),
    )
    setDirty(true)
  }

  const handleBrowse = async (id: string, field: SourceField) => {
    const selected = await window.electronAPI?.dialog?.pickFile()
    if (selected) handleSettingChange(id, field.key, selected)
  }

  const isWeb = window.electronAPI?.platform === 'web'

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary" />
            <CardTitle>{t('egress.sources.title')}</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleAdd} disabled={metas.length === 0}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              {t('egress.sources.add')}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1" />
              )}
              {t('common.save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void load()}
              disabled={saving || !dirty}
              title={t('common.refresh')}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <CardDescription>{t('egress.sources.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sources.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('egress.sources.empty')}</p>
        )}

        {sources.map((source) => {
          const meta = getMeta(source.sourceId)
          const isActive = source.id === activeSourceId
          return (
            <div key={source.id} className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Select
                    value={source.sourceId}
                    onValueChange={(value) => handleModuleChange(source.id, value)}
                  >
                    <SelectTrigger className="w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {metas.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {t(m.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isActive ? (
                    <span className="flex items-center gap-1 text-xs text-emerald-600">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {t('egress.sources.active')}
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setActiveSourceId(source.id)
                        setDirty(true)
                      }}
                    >
                      {t('egress.sources.setActive')}
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleCheck(source)}
                    disabled={checks[source.id]?.checking}
                  >
                    {checks[source.id]?.checking ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    ) : (
                      <ShieldCheck className="h-3.5 w-3.5 mr-1" />
                    )}
                    {t('egress.sources.check')}
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => handleRemove(source.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>

              {checks[source.id]?.result && (
                <div className="flex items-start gap-2">
                  {checks[source.id].result!.available ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                      <span className="text-xs text-emerald-600 dark:text-emerald-500">
                        {t('egress.sources.checkOk')}
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                      <span className="text-xs text-destructive">
                        {checks[source.id].result!.error || t('egress.sources.checkFailed')}
                      </span>
                    </>
                  )}
                </div>
              )}

              <div className="space-y-3">
                {(meta?.fields ?? [])
                  .filter((field) => isFieldVisible(source, field, meta?.fields ?? []))
                  .map((field) => {
                    const value = String(resolveFieldValue(source, field) ?? '')
                    return (
                      <div key={field.key} className="space-y-1">
                        <Label>{t(field.labelKey)}</Label>
                        {field.type === 'boolean' ? (
                          <Switch
                            checked={Boolean(resolveFieldValue(source, field) ?? false)}
                            onCheckedChange={(checked) =>
                              handleSettingChange(source.id, field.key, checked)
                            }
                          />
                        ) : field.type === 'select' ? (
                          <Select
                            value={value}
                            onValueChange={(next) =>
                              handleSettingChange(source.id, field.key, next)
                            }
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(field.options ?? []).map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {t(option.labelKey)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : field.type === 'textarea' ? (
                          <Textarea
                            value={value}
                            placeholder={field.placeholder}
                            onChange={(event) =>
                              handleSettingChange(source.id, field.key, event.target.value)
                            }
                          />
                        ) : field.type === 'file' ? (
                          <div className="flex gap-2">
                            <Input
                              value={value}
                              placeholder={field.placeholder}
                              onChange={(event) =>
                                handleSettingChange(source.id, field.key, event.target.value)
                              }
                            />
                            {!isWeb && (
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void handleBrowse(source.id, field)}
                              >
                                {t('egress.sources.browse')}
                              </Button>
                            )}
                          </div>
                        ) : (
                          <Input
                            type={
                              field.type === 'password'
                                ? 'password'
                                : field.type === 'number'
                                  ? 'number'
                                  : 'text'
                            }
                            value={value}
                            placeholder={field.placeholder}
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            onChange={(event) =>
                              handleSettingChange(
                                source.id,
                                field.key,
                                field.type === 'number'
                                  ? Number(event.target.value)
                                  : event.target.value,
                              )
                            }
                          />
                        )}
                        {field.helpKey && (
                          <p className="text-xs text-muted-foreground">{t(field.helpKey)}</p>
                        )}
                      </div>
                    )
                  })}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

export default SourceConfig
