/**
 * Doubao (豆包) provider module.
 */
import doubaoConfig from './config.ts'
import { DoubaoAdapter } from './adapter.ts'
import { createDoubaoForwarder } from './forwarder.ts'
import { DoubaoAdapterOAuth } from './oauth.ts'
import { checkDoubaoToken } from './tokenCheck.ts'
import type { ProviderModule } from '../types.ts'

export const doubaoModule: ProviderModule = {
  id: 'doubao',
  config: doubaoConfig,
  matches: DoubaoAdapter.isDoubaoProvider,
  createForwarder: createDoubaoForwarder,
  oauth: {
    factory: (config) => new DoubaoAdapterOAuth(config),
    authMethods: ['manual'],
  },
  // Log in inside the app window. The cookie jar and the identifiers
  // (device_id / tea_uuid / web_id / x-flow-trace) travel on the samantha API
  // requests the web app fires right after login, so no chat message is needed.
  // The room id is captured opportunistically from the page URL because it only
  // feeds the request Referer (an empty value falls back to /chat/).
  tokenExtraction: {
    loginUrl: 'https://www.doubao.com/chat/',
    tokenSources: [
      { type: 'queryParam', key: 'device_id', urlPattern: 'doubao\\.com' },
      { type: 'queryParam', key: 'tea_uuid', urlPattern: 'doubao\\.com' },
      { type: 'queryParam', key: 'web_id', urlPattern: 'doubao\\.com' },
      {
        type: 'networkHeader',
        key: 'x_flow_trace',
        header: 'x-flow-trace',
        urlPattern: 'doubao\\.com',
      },
      { type: 'urlPath', key: 'room_id', extractPattern: '/chat/([^/?#]+)' },
    ],
    collectCookies: true,
    // room_id is intentionally not required: it is optional and only affects the
    // Referer header, so login can complete without opening a conversation.
    requiredKeys: ['cookies', 'device_id', 'tea_uuid', 'web_id', 'x_flow_trace'],
    targetDomains: ['.doubao.com', 'doubao.com', 'www.doubao.com'],
    successUrlPatterns: [/doubao\.com/i],
    windowTitle: 'Doubao Login',
  },
  // Assisted batch registration: Doubao is passwordless, so a batch "signup" is
  // a phone + SMS login. The flow leases a number from the configured number
  // API, opens the login page in a window (the operator solves any slider /
  // risk verification), checks the code, and — because an unregistered number
  // auto-creates an account on first login — keeps the captured session.
  registration: {
    registrationUrl: 'https://www.doubao.com/chat/',
    codeSource: 'sms',
    // Doubao's login lives in a modal that is opened from the chat page and is a
    // two-step flow: 手机号登录 tab -> phone -> 下一步 -> code. Selectors below
    // are the page's own data-testid hooks.
    // "登录" opens the login modal; "手机号登录" switches it to the phone form.
    activateTabText: '登录,手机号登录',
    fields: [
      { value: 'phone', selector: '[data-testid="login_phone_number_input"]' },
      // The code input has no testid of its own; it lives inside code_input.
      { value: 'code', selector: '[data-testid="code_input"] input' },
    ],
    termsCheckboxSelector: '[data-testid="login_agreement_check"]',
    advanceSelector: '[data-testid="login_next_button"]',
    windowTitle: 'Doubao Registration',
    smsKeyword: '豆包',
    descriptionKey: 'providers.doubaoBatchRegisterDescription',
  },
  tokenChecker: checkDoubaoToken,
}

export default doubaoModule
