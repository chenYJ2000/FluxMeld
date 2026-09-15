import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Key, Terminal, Info, ShieldCheck } from 'lucide-react'

export function ManagementApiSettings() {
  const { t } = useTranslation()
  const isWeb = window.electronAPI?.platform === 'web'
  const accessPasswordRequired = Boolean(window.__FLUXMELD_WEB_INFO__?.accessPasswordRequired)

  if (!isWeb) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            {t('settings.managementApi.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              <p className="font-medium">{t('settings.managementApi.webOnlyTitle')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('settings.managementApi.webOnlyDescription')}
              </p>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    )
  }

  const apiEndpoint = `${window.location.origin}/v0/management`
  const authFlag = accessPasswordRequired
    ? ' \\\n  -H "x-access-password: YOUR_WEB_ACCESS_PASSWORD"'
    : ''

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            {t('settings.managementApi.title')}
          </CardTitle>
          <CardDescription>{t('settings.managementApi.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
            <span>{t('settings.managementApi.alwaysEnabled')}</span>
          </div>

          <Alert>
            {accessPasswordRequired ? (
              <ShieldCheck className="h-4 w-4" />
            ) : (
              <Info className="h-4 w-4" />
            )}
            <AlertDescription>
              {accessPasswordRequired
                ? t('settings.managementApi.authRequired')
                : t('settings.managementApi.authNotRequired')}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            {t('settings.managementApi.apiDocumentation')}
          </CardTitle>
          <CardDescription>{t('settings.managementApi.exampleUsage')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t('settings.managementApi.apiEndpoint')}</Label>
            <code className="block w-full rounded-md bg-muted p-3 text-sm font-mono break-all">
              {apiEndpoint}
            </code>
          </div>

          <div className="space-y-2">
            <Label>{t('settings.managementApi.authHeaderHint')}</Label>
            <code className="block w-full whitespace-pre-wrap rounded-md bg-muted p-3 text-sm font-mono break-all">
              {accessPasswordRequired
                ? 'Authorization: Bearer YOUR_WEB_ACCESS_PASSWORD\nx-access-password: YOUR_WEB_ACCESS_PASSWORD'
                : t('settings.managementApi.authNotRequired')}
            </code>
          </div>

          <div className="space-y-2">
            <Label>{t('settings.managementApi.getExample')}</Label>
            <pre className="block w-full rounded-md bg-muted p-3 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-all">
              {`curl -X GET "${apiEndpoint}/accounts"${authFlag}`}
            </pre>
          </div>

          <div className="space-y-2">
            <Label>{t('settings.managementApi.batchExample')}</Label>
            <pre className="block w-full rounded-md bg-muted p-3 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-all">
              {`curl -X POST "${apiEndpoint}/accounts/batch" \\
  -H "Content-Type: application/json"${authFlag} \\
  -d '{"accounts":[{"providerId":"deepseek","name":"a1","credentials":{"token":"YOUR_TOKEN"}}]}'`}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
