import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
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
import { Layers, Plus, Trash2, Loader2, CheckCircle2 } from 'lucide-react'

interface SourceField {
  key: string
  type: string
  labelKey: string
  placeholder?: string
  helpKey?: string
  options?: Array<{ value: string; labelKey: string }>
  defaultValue?: string | number | boolean
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

export function SourceConfig() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [metas, setMetas] = useState<SourceMeta[]>([])
  const [sources, setSources] = useState<SourceEntry[]>([])
  const [activeSourceId, setActiveSourceId] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const result = await window.electronAPI.outboundProxy.getSources()
      setMetas(result.metas)
      setSources(result.outboundProxy.sources)
      setActiveSourceId(result.outboundProxy.activeSourceId)
    } catch (error) {
      console.error('Failed to load egress sources:', error)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const persist = async (nextSources: SourceEntry[], nextActive = activeSourceId) => {
    setSaving(true)
    try {
      const config = await window.electronAPI.config.get()
      const ok = await window.electronAPI.config.update({
        outboundProxy: {
          ...config.outboundProxy,
          sources: nextSources,
          activeSourceId: nextActive,
        },
      })
      if (ok) {
        setSources(nextSources)
        setActiveSourceId(nextActive)
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
    void persist([...sources, entry], activeSourceId || entry.id)
  }

  const handleRemove = (id: string) => {
    const next = sources.filter((source) => source.id !== id)
    const nextActive = activeSourceId === id ? (next[0]?.id ?? '') : activeSourceId
    void persist(next, nextActive)
  }

  const handleModuleChange = (id: string, sourceId: string) => {
    const next = sources.map((source) =>
      source.id === id ? { ...source, sourceId, settings: {} } : source,
    )
    void persist(next)
  }

  const handleSettingChange = (id: string, key: string, value: unknown) => {
    const next = sources.map((source) =>
      source.id === id ? { ...source, settings: { ...source.settings, [key]: value } } : source,
    )
    void persist(next)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary" />
            <CardTitle>{t('egress.sources.title')}</CardTitle>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          <Button size="sm" onClick={handleAdd} disabled={metas.length === 0}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t('egress.sources.add')}
          </Button>
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
                      onClick={() => void persist(sources, source.id)}
                    >
                      {t('egress.sources.setActive')}
                    </Button>
                  )}
                </div>
                <Button variant="ghost" size="icon" onClick={() => handleRemove(source.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>

              <div className="space-y-3">
                {(meta?.fields ?? []).map((field) => (
                  <div key={field.key} className="space-y-1">
                    <Label>{t(field.labelKey)}</Label>
                    {field.type === 'boolean' ? (
                      <Switch
                        checked={Boolean(source.settings[field.key] ?? field.defaultValue ?? false)}
                        onCheckedChange={(value) =>
                          handleSettingChange(source.id, field.key, value)
                        }
                      />
                    ) : field.type === 'select' ? (
                      <Select
                        value={String(source.settings[field.key] ?? field.defaultValue ?? '')}
                        onValueChange={(value) => handleSettingChange(source.id, field.key, value)}
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
                    ) : (
                      <Input
                        type={
                          field.type === 'password'
                            ? 'password'
                            : field.type === 'number'
                              ? 'number'
                              : 'text'
                        }
                        value={String(source.settings[field.key] ?? field.defaultValue ?? '')}
                        placeholder={field.placeholder}
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
                ))}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

export default SourceConfig
