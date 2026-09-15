import axios, { AxiosError } from 'axios'
import type { Account, Provider } from '../../../shared/types'
import type { TokenCheckResult } from '../types'

const CHECK_TIMEOUT = 15000

export async function checkMiniMaxToken(
  _provider: Provider,
  account: Account,
): Promise<TokenCheckResult> {
  const token = account.credentials.token

  try {
    console.log('[MiniMax] Validating configured token')

    const crypto = await import('crypto')

    let realUserID = ''
    let jwtToken = token

    if (token.includes('+')) {
      const parts = token.split('+')
      realUserID = parts[0]
      jwtToken = parts[1]
    } else {
      try {
        const parts = token.split('.')
        if (parts.length >= 2) {
          let payload = parts[1]
          const padding = payload.length % 4
          if (padding > 0) {
            payload += '='.repeat(4 - padding)
          }
          payload = payload.replace(/-/g, '+').replace(/_/g, '/')
          const decoded = Buffer.from(payload, 'base64').toString('utf8')
          const data = JSON.parse(decoded)
          realUserID = data.user?.id || data.id || data.sub || ''
          console.log('[MiniMax] Extracted userId from token')
        }
      } catch (e) {
        console.log(
          '[MiniMax] Failed to parse JWT:',
          e instanceof Error ? e.message : 'Unknown error',
        )
      }
    }

    if (!realUserID) {
      return { valid: false, error: 'Cannot extract user ID from token' }
    }

    const uuid = realUserID
    const unix = Date.now().toString()
    const timestamp = Math.floor(Date.now() / 1000)
    const dataJson = JSON.stringify({ uuid })

    const signature = crypto
      .createHash('md5')
      .update(`${timestamp}${jwtToken}${dataJson}`)
      .digest('hex')

    const queryParams = new URLSearchParams({
      device_platform: 'web',
      biz_id: '3',
      app_id: '3001',
      version_code: '22201',
      uuid: uuid,
      user_id: realUserID,
    }).toString()

    const fullUri = `/v1/api/user/device/register?${queryParams}`
    const yy = crypto
      .createHash('md5')
      .update(
        `${encodeURIComponent(fullUri)}_${dataJson}${crypto.createHash('md5').update(unix).digest('hex')}ooui`,
      )
      .digest('hex')

    const response = await axios.post(
      `https://agent.minimaxi.com${fullUri}`,
      { uuid },
      {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/json',
          Origin: 'https://agent.minimaxi.com',
          Pragma: 'no-cache',
          Referer: 'https://agent.minimaxi.com/',
          'Sec-Ch-Ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"macOS"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
          token: jwtToken,
          'x-timestamp': String(timestamp),
          'x-signature': signature,
          yy: yy,
        },
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      },
    )

    console.log('[MiniMax] Response status:', response.status)

    if (response.status === 200 && response.data?.data?.deviceIDStr) {
      const userInfo = response.data.data.userInfo
      return {
        valid: true,
        userInfo: {
          name: userInfo?.name || userInfo?.nickname,
          email: userInfo?.email,
        },
      }
    }

    if (response.data?.statusInfo?.code === 1001) {
      return { valid: false, error: 'Token expired or invalid' }
    }

    return {
      valid: false,
      error: `Validation failed: ${response.data?.statusInfo?.message || 'Unknown error'}`,
    }
  } catch (error) {
    console.error(
      '[MiniMax] Validation error:',
      error instanceof Error ? error.message : 'Unknown error',
    )
    return {
      valid: false,
      error: error instanceof AxiosError ? error.message : 'Connection failed',
    }
  }
}
