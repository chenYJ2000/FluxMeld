import type { BuiltinProviderConfig } from '../../store/types'

/**
 * Doubao (豆包) web-session provider.
 *
 * The Doubao web app authenticates its `samantha` chat endpoint with a browser
 * session: the `cookie` header plus a handful of identifiers that the client
 * sends as query parameters / headers (`device_id`, `tea_uuid`, `web_id`,
 * `room_id`, `x_flow_trace`). There is no API key, so an account is the bundle
 * of those values captured from a logged-in session (see the DoubaoFreeApi
 * project for the reference protocol).
 */
export const doubaoConfig: BuiltinProviderConfig = {
  id: 'doubao',
  name: 'Doubao (豆包)',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: 'https://www.doubao.com',
  chatPath: '/samantha/chat/completion',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'agw-js-conv': 'str',
    Origin: 'https://www.doubao.com',
    Referer: 'https://www.doubao.com/chat/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0',
  },
  enabled: true,
  description: 'Doubao (豆包) web assistant, driven by browser session credentials',
  supportedModels: ['Doubao', 'Doubao-DeepThink'],
  modelMappings: {
    Doubao: 'doubao',
    'Doubao-DeepThink': 'doubao-deep-think',
  },
  credentialFields: [
    {
      name: 'cookies',
      labelKey: 'doubao.cookie',
      placeholderKey: 'doubao.cookiePlaceholder',
      helpTextKey: 'doubao.cookieHelp',
      label: 'Cookie',
      type: 'textarea',
      required: true,
      placeholder: 'Paste the full doubao.com Cookie header',
      helpText:
        'The complete Cookie request header captured from a logged-in www.doubao.com session (DevTools -> Network -> any samantha request -> Headers -> Cookie).',
    },
    {
      name: 'device_id',
      labelKey: 'doubao.deviceId',
      placeholderKey: 'doubao.deviceIdPlaceholder',
      helpTextKey: 'doubao.requestParamsHelp',
      label: 'device_id',
      type: 'text',
      required: true,
      placeholder: 'device_id query parameter',
      helpText: 'Captured from the samantha request query string.',
    },
    {
      name: 'tea_uuid',
      labelKey: 'doubao.teaUuid',
      placeholderKey: 'doubao.teaUuidPlaceholder',
      helpTextKey: 'doubao.requestParamsHelp',
      label: 'tea_uuid',
      type: 'text',
      required: true,
      placeholder: 'tea_uuid query parameter',
      helpText: 'Captured from the samantha request query string.',
    },
    {
      name: 'web_id',
      labelKey: 'doubao.webId',
      placeholderKey: 'doubao.webIdPlaceholder',
      helpTextKey: 'doubao.requestParamsHelp',
      label: 'web_id',
      type: 'text',
      required: true,
      placeholder: 'web_id query parameter',
      helpText: 'Captured from the samantha request query string.',
    },
    {
      name: 'room_id',
      labelKey: 'doubao.roomId',
      placeholderKey: 'doubao.roomIdPlaceholder',
      helpTextKey: 'doubao.roomIdHelp',
      label: 'room_id',
      type: 'text',
      required: false,
      placeholder: 'room_id from the referer / chat URL (optional)',
      helpText:
        'Optional. Taken from the browser chat URL (https://www.doubao.com/chat/<room_id>); only used for the request Referer, so an empty value falls back to https://www.doubao.com/chat/.',
    },
    {
      name: 'x_flow_trace',
      labelKey: 'doubao.xFlowTrace',
      placeholderKey: 'doubao.xFlowTracePlaceholder',
      helpTextKey: 'doubao.xFlowTraceHelp',
      label: 'x-flow-trace',
      type: 'textarea',
      required: true,
      placeholder: 'x-flow-trace request header',
      helpText: 'Captured from the samantha request Headers -> x-flow-trace.',
    },
  ],
  capabilities: { batchRegister: true },
  ui: { iconKey: 'doubao', i18nPrefix: 'doubao' },
}

export default doubaoConfig
