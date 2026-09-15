import axios, { AxiosError } from 'axios'
import type { Account, Provider } from '../../../shared/types'
import type { TokenCheckResult } from '../types'

const CHECK_TIMEOUT = 15000

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

async function generateGLMSignV2(): Promise<{ timestamp: string; nonce: string; sign: string }> {
  const crypto = await import('crypto')
  const secret = '8a1317a7468aa3ad86e997d08f3f31cb'

  // GLM timestamp algorithm
  const now = Date.now()
  const timestampStr = now.toString()
  const len = timestampStr.length
  const digits = timestampStr.split('').map((d) => parseInt(d))
  const sum = digits.reduce((a, b) => a + b, 0) - digits[len - 2]
  const checkDigit = sum % 10
  const timestamp =
    timestampStr.substring(0, len - 2) + checkDigit + timestampStr.substring(len - 1)

  // Random UUID (no separators)
  const nonce = generateUUID().replace(/-/g, '')

  // Signature
  const sign = crypto.createHash('md5').update(`${timestamp}-${nonce}-${secret}`).digest('hex')

  return { timestamp, nonce, sign }
}

export async function checkGLMToken(
  _provider: Provider,
  account: Account,
): Promise<TokenCheckResult> {
  const refreshToken = account.credentials.refresh_token

  try {
    console.log('[GLM] Validating configured refresh token')

    const sign = await generateGLMSignV2()

    const response = await axios.post(
      'https://chatglm.cn/chatglm/user-api/user/refresh',
      {},
      {
        headers: {
          Accept: 'text/event-stream',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
          'App-Name': 'chatglm',
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/json',
          Origin: 'https://chatglm.cn',
          Pragma: 'no-cache',
          Priority: 'u=1, i',
          'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-App-Fr': 'browser_extension',
          'X-App-Platform': 'pc',
          'X-App-Version': '0.0.1',
          'X-Device-Brand': '',
          'X-Device-Model': '',
          'X-Exp-Groups':
            'na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user,app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5,ai_wallet:exp:ai_wallet_enable',
          'X-Lang': 'zh',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          Authorization: `Bearer ${refreshToken}`,
          'X-Device-Id': generateUUID().replace(/-/g, ''),
          'X-Nonce': sign.nonce,
          'X-Request-Id': generateUUID().replace(/-/g, ''),
          'X-Sign': sign.sign,
          'X-Timestamp': `${sign.timestamp}`,
        },
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      },
    )

    console.log('[GLM] Response status:', response.status)

    if (response.status === 200 && response.data?.result?.access_token) {
      return {
        valid: true,
        userInfo: {
          name: response.data.result.user?.name,
        },
      }
    }

    if (response.status === 401 || response.data?.status === 40001) {
      return { valid: false, error: 'Token expired or invalid' }
    }

    return {
      valid: false,
      error: `Validation failed: ${response.data?.message || response.data?.msg || `HTTP ${response.status}`}`,
    }
  } catch (error) {
    console.error(
      '[GLM] Validation error:',
      error instanceof Error ? error.message : 'Unknown error',
    )
    return {
      valid: false,
      error: error instanceof AxiosError ? error.message : 'Connection failed',
    }
  }
}
