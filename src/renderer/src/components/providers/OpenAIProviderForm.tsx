/**
 * OpenAI-Compatible Provider Form
 *
 * Creates and edits providers that expose a direct OpenAI-compatible API
 * (`/v1/chat/completions` + bearer API key). Web-session style custom
 * providers are handled by `CustomProviderForm`.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Plus, X, HelpCircle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { CredentialField, OpenAIProviderFormData } from '@/types/electron'

interface OpenAIProviderFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: OpenAIProviderFormData) => void
  initialData?: Partial<OpenAIProviderFormData>
}

const API_KEY_FIELD: CredentialField = {
  name: 'apiKey',
  label: 'API Key',
  type: 'password',
  required: true,
  placeholder: 'sk-...',
}

function createDefaultData(
  initialData?: Partial<OpenAIProviderFormData>,
): OpenAIProviderFormData {
  return {
    name: initialData?.name || '',
    apiEndpoint: initialData?.apiEndpoint || '',
    chatPath: initialData?.chatPath || '',
    headers: initialData?.headers || { 'Content-Type': 'application/json' },
    description: initialData?.description || '',
    supportedModels: initialData?.supportedModels || [],
    credentialFields: initialData?.credentialFields?.length
      ? initialData.credentialFields
      : [API_KEY_FIELD],
    ui: initialData?.ui || { variant: 'openai' },
  }
}

export function OpenAIProviderForm({
  open,
  onOpenChange,
  onSubmit,
  initialData,
}: OpenAIProviderFormProps) {
  const { t } = useTranslation()

  const [formData, setFormData] = useState<OpenAIProviderFormData>(() => createDefaultData(initialData))
  const [newModel, setNewModel] = useState('')
  const [newHeaderKey, setNewHeaderKey] = useState('')
  const [newHeaderValue, setNewHeaderValue] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Re-sync whenever the dialog opens or the target provider changes so that
  // switching between create and edit never shows stale values.
  useEffect(() => {
    if (open) {
      setFormData(createDefaultData(initialData))
      setNewModel('')
      setNewHeaderKey('')
      setNewHeaderValue('')
      setErrors({})
    }
  }, [open, initialData])

  const handleAddModel = () => {
    const model = newModel.trim()
    if (model && !formData.supportedModels.includes(model)) {
      setFormData({ ...formData, supportedModels: [...formData.supportedModels, model] })
      setNewModel('')
    }
  }

  const handleRemoveModel = (model: string) => {
    setFormData({
      ...formData,
      supportedModels: formData.supportedModels.filter((m) => m !== model),
    })
  }

  const handleAddHeader = () => {
    if (newHeaderKey.trim() && newHeaderValue.trim()) {
      setFormData({
        ...formData,
        headers: {
          ...formData.headers,
          [newHeaderKey.trim()]: newHeaderValue.trim(),
        },
      })
      setNewHeaderKey('')
      setNewHeaderValue('')
    }
  }

  const handleRemoveHeader = (key: string) => {
    const { [key]: _removed, ...rest } = formData.headers
    void _removed
    setFormData({ ...formData, headers: rest })
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!formData.name.trim()) {
      newErrors.name = t('providers.providerNameRequired')
    }

    if (!formData.apiEndpoint.trim()) {
      newErrors.apiEndpoint = t('providers.apiEndpointRequired')
    } else {
      try {
        const url = new URL(formData.apiEndpoint)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          newErrors.apiEndpoint = t('providers.apiEndpointInvalid')
        }
      } catch {
        newErrors.apiEndpoint = t('providers.apiEndpointInvalid')
      }
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = () => {
    if (!validate()) return

    onSubmit({
      ...formData,
      name: formData.name.trim(),
      apiEndpoint: formData.apiEndpoint.trim(),
      chatPath: formData.chatPath?.trim() || undefined,
      ui: { ...formData.ui, variant: 'openai' },
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>
            {initialData ? t('providers.editProvider') : t('providers.createOpenAIProvider')}
          </DialogTitle>
          <DialogDescription>{t('providers.createOpenAIProviderDesc')}</DialogDescription>
        </DialogHeader>

        <div className="h-[500px] overflow-y-auto pr-2">
          <div className="space-y-6 py-4 px-1">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="openai-name">
                  {t('providers.providerName')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="openai-name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder={t('providers.openaiProviderNamePlaceholder')}
                />
                {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
              </div>

              <div className="space-y-2">
                <Label htmlFor="openai-endpoint">
                  {t('providers.baseUrl')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="openai-endpoint"
                  value={formData.apiEndpoint}
                  onChange={(e) => setFormData({ ...formData, apiEndpoint: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                />
                <p className="text-xs text-muted-foreground">{t('providers.baseUrlHelp')}</p>
                {errors.apiEndpoint && (
                  <p className="text-xs text-destructive">{errors.apiEndpoint}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="openai-chat-path">{t('providers.chatPath')}</Label>
                <Input
                  id="openai-chat-path"
                  value={formData.chatPath || ''}
                  onChange={(e) => setFormData({ ...formData, chatPath: e.target.value })}
                  placeholder="/chat/completions"
                />
                <p className="text-xs text-muted-foreground">{t('providers.chatPathHelp')}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="openai-description">{t('providers.description')}</Label>
                <Textarea
                  id="openai-description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder={t('providers.descriptionPlaceholder')}
                  rows={2}
                />
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>{t('providers.supportedModels')}</Label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <HelpCircle className="h-4 w-4 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('providers.supportedModelsHelp')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="flex gap-2">
                <Input
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  placeholder={t('providers.modelNamePlaceholder')}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddModel()}
                />
                <Button type="button" variant="outline" onClick={handleAddModel}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {formData.supportedModels.map((model) => (
                  <Badge key={model} variant="secondary" className="gap-1">
                    {model}
                    <X
                      className="h-3 w-3 cursor-pointer"
                      onClick={() => handleRemoveModel(model)}
                    />
                  </Badge>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <Label>{t('providers.headersConfig')}</Label>
              <div className="grid grid-cols-[1fr,1fr,auto] gap-2">
                <Input
                  value={newHeaderKey}
                  onChange={(e) => setNewHeaderKey(e.target.value)}
                  placeholder={t('providers.headerName')}
                />
                <Input
                  value={newHeaderValue}
                  onChange={(e) => setNewHeaderValue(e.target.value)}
                  placeholder={t('providers.headerValue')}
                />
                <Button type="button" variant="outline" onClick={handleAddHeader}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-2">
                {Object.entries(formData.headers).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between p-2 rounded bg-muted">
                    <div className="text-sm">
                      <span className="font-medium">{key}:</span> {value}
                    </div>
                    <X
                      className="h-4 w-4 cursor-pointer text-muted-foreground hover:text-foreground"
                      onClick={() => handleRemoveHeader(key)}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2 rounded bg-muted/50 p-3">
              <Label>{t('providers.credentialFields')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('providers.openaiCredentialHint')}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit}>
            {initialData ? t('providers.saveChanges') : t('providers.createOpenAIProvider')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default OpenAIProviderForm
