import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  GeneralSettings,
  SourceConfig,
  RotationPolicyConfig,
  ProxyAssignment,
} from '@/components/egress'
import { Settings, Layers, Repeat, Users } from 'lucide-react'

export function EgressSettings() {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t('egress.title')}</h2>
        <p className="text-muted-foreground">{t('egress.subtitle')}</p>
      </div>

      <Tabs defaultValue="general" className="w-full">
        <TabsList className="flex flex-wrap w-full gap-1 h-auto p-1">
          <TabsTrigger value="general" className="flex items-center gap-2 py-2 px-3 flex-1 min-w-0">
            <Settings className="h-4 w-4 flex-shrink-0" />
            <span className="hidden md:inline truncate">{t('egress.tabs.general')}</span>
          </TabsTrigger>
          <TabsTrigger value="sources" className="flex items-center gap-2 py-2 px-3 flex-1 min-w-0">
            <Layers className="h-4 w-4 flex-shrink-0" />
            <span className="hidden md:inline truncate">{t('egress.tabs.sources')}</span>
          </TabsTrigger>
          <TabsTrigger
            value="rotation"
            className="flex items-center gap-2 py-2 px-3 flex-1 min-w-0"
          >
            <Repeat className="h-4 w-4 flex-shrink-0" />
            <span className="hidden md:inline truncate">{t('egress.tabs.rotation')}</span>
          </TabsTrigger>
          <TabsTrigger
            value="assignment"
            className="flex items-center gap-2 py-2 px-3 flex-1 min-w-0"
          >
            <Users className="h-4 w-4 flex-shrink-0" />
            <span className="hidden md:inline truncate">{t('egress.tabs.assignment')}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-6">
          <GeneralSettings />
        </TabsContent>
        <TabsContent value="sources" className="mt-6">
          <SourceConfig />
        </TabsContent>
        <TabsContent value="rotation" className="mt-6">
          <RotationPolicyConfig />
        </TabsContent>
        <TabsContent value="assignment" className="mt-6">
          <ProxyAssignment />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default EgressSettings
