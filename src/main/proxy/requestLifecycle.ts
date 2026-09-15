export class RequestTimeoutError extends Error {
  readonly status = 504
  readonly code = 'request_timeout'
  readonly requestId: string
  readonly timeoutMs: number
  readonly phase: string

  constructor(requestId: string, timeoutMs: number, phase: string = 'request') {
    super(`${phase} timed out after ${timeoutMs}ms`)
    this.name = 'RequestTimeoutError'
    this.requestId = requestId
    this.timeoutMs = timeoutMs
    this.phase = phase
  }
}

export class ClientDisconnectedError extends Error {
  readonly status = 499
  readonly code = 'client_disconnected'
  readonly requestId: string

  constructor(requestId: string) {
    super('Client disconnected before the request completed')
    this.name = 'ClientDisconnectedError'
    this.requestId = requestId
  }
}

export interface RequestDeadline {
  signal: AbortSignal
  deadlineAt: number
  dispose: () => void
}

export function createTimeoutErrorPayload(message: string, requestId: string) {
  return {
    error: {
      message,
      type: 'timeout_error',
      param: null,
      code: 'request_timeout',
    },
    request_id: requestId,
  }
}

export function getAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === 'string' ? signal.reason : 'Request aborted')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw getAbortReason(signal)
}

export function getRemainingTimeout(deadlineAt: number | undefined, fallbackMs: number): number {
  const safeFallbackMs = Number.isFinite(fallbackMs) ? Math.max(1, Math.floor(fallbackMs)) : 60000
  if (deadlineAt === undefined || !Number.isFinite(deadlineAt)) return safeFallbackMs
  return Math.max(1, Math.min(safeFallbackMs, deadlineAt - Date.now()))
}

export function createRequestDeadline(input: {
  requestId: string
  timeoutMs: number
  parentSignal?: AbortSignal
  startedAt?: number
}): RequestDeadline {
  const timeoutMs = Number.isFinite(input.timeoutMs)
    ? Math.max(1, Math.floor(input.timeoutMs))
    : 60000
  const startedAt =
    typeof input.startedAt === 'number' && Number.isFinite(input.startedAt)
      ? input.startedAt
      : Date.now()
  const deadlineAt = startedAt + timeoutMs
  const remainingMs = Math.max(0, deadlineAt - Date.now())
  const controller = new AbortController()
  const forwardParentAbort = () => {
    if (!controller.signal.aborted && input.parentSignal) {
      controller.abort(getAbortReason(input.parentSignal))
    }
  }

  if (input.parentSignal?.aborted) {
    forwardParentAbort()
  } else {
    input.parentSignal?.addEventListener('abort', forwardParentAbort, { once: true })
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new RequestTimeoutError(input.requestId, timeoutMs))
    }
  }, remainingMs)

  return {
    signal: controller.signal,
    deadlineAt,
    dispose: () => {
      clearTimeout(timer)
      input.parentSignal?.removeEventListener('abort', forwardParentAbort)
    },
  }
}

export function waitForAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) return Promise.reject(getAbortReason(signal))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(getAbortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })

    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
