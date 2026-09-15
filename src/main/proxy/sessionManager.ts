/**
 * Session Manager Module
 * Manages conversation sessions for stateless single-turn dialogue
 */

import { storeManager } from '../store/store'
import { SessionRecord, SessionConfig, ChatMessage } from '../store/types'
import type { ChatMessage as ProxyChatMessage } from './types'
import { cloneChatMessage, mergeSessionMessages } from './services/sessionContextService'

export interface CreateSessionOptions {
  /** Client-provided FluxMeld session identifier for stateful requests. */
  sessionId?: string
  providerId: string
  accountId: string
  model?: string
  sessionType?: 'chat' | 'agent'
}

export interface SessionContext {
  sessionId: string
  providerSessionId: string | undefined
  parentMessageId: string | undefined
  messages: ChatMessage[]
  isNew: boolean
}

export interface PreparedSessionContext {
  sessionId: string
  messages: ProxyChatMessage[]
  isNew: boolean
}

export interface PersistSessionContextOptions {
  sessionId: string
  providerId: string
  accountId: string
  model?: string
  messages: ProxyChatMessage[]
  assistantMessage?: ProxyChatMessage
  providerSessionId?: string
}

class SessionManagerClass {
  private cleanupInterval: NodeJS.Timeout | null = null

  initialize(): void {
    this.startCleanupScheduler()
    console.log('[SessionManager] Initialized')
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    console.log('[SessionManager] Destroyed')
  }

  private startCleanupScheduler(): void {
    const CLEANUP_INTERVAL_MS = 60 * 1000

    this.cleanupInterval = setInterval(() => {
      this.cleanExpiredSessions()
    }, CLEANUP_INTERVAL_MS)

    console.log('[SessionManager] Cleanup scheduler started, interval: 1 minute')
  }

  getSessionConfig(): SessionConfig {
    return storeManager.getSessionConfig()
  }

  updateSessionConfig(updates: Partial<SessionConfig>): SessionConfig {
    const newConfig = storeManager.updateSessionConfig(updates)
    console.log('[SessionManager] Session config updated:', newConfig)
    return newConfig
  }

  getOrCreateSession(options: CreateSessionOptions): SessionContext {
    const { sessionId, providerId, accountId, model } = options

    if (sessionId) {
      const existingSession = this.getSession(sessionId)

      if (existingSession) {
        const reactivatedSession =
          existingSession.status === 'active'
            ? existingSession
            : (storeManager.updateSession(sessionId, {
                status: 'active',
                lastActiveAt: Date.now(),
              }) ?? existingSession)

        return {
          sessionId: reactivatedSession.id,
          providerSessionId: reactivatedSession.metadata?.providerSessionId,
          parentMessageId: undefined,
          messages: reactivatedSession.messages.map((message) => this.cloneStoredMessage(message)),
          isNew: false,
        }
      }

      const newSession = this.createSession(options)
      return {
        sessionId: newSession.id,
        providerSessionId: undefined,
        parentMessageId: undefined,
        messages: [],
        isNew: true,
      }
    }

    const existingSession = this.getActiveSession(providerId, accountId)

    if (existingSession) {
      return {
        sessionId: existingSession.id,
        providerSessionId: undefined,
        parentMessageId: undefined,
        messages: existingSession.messages.map((message) => this.cloneStoredMessage(message)),
        isNew: false,
      }
    }

    const newSession = this.createSession({
      providerId,
      accountId,
      model,
    })

    return {
      sessionId: newSession.id,
      providerSessionId: undefined,
      parentMessageId: undefined,
      messages: [],
      isNew: true,
    }
  }

  getActiveSession(providerId: string, accountId: string): SessionRecord | undefined {
    const sessions = storeManager.getSessionsByProviderId(providerId)
    const accountSessions = sessions.filter((s) => s.accountId === accountId)
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()

    return accountSessions.find((s) => s.status === 'active' && now - s.lastActiveAt < timeoutMs)
  }

  createSession(options: CreateSessionOptions): SessionRecord {
    const { sessionId, providerId, accountId, model, sessionType = 'chat' } = options
    const now = Date.now()
    const id = sessionId || this.generateSessionId()

    if (storeManager.getSessionById(id)) {
      throw new Error(`Session already exists: ${id}`)
    }

    const session: SessionRecord = {
      id,
      providerId,
      accountId,
      sessionType,
      messages: [],
      createdAt: now,
      lastActiveAt: now,
      status: 'active',
      model,
    }

    storeManager.addSession(session)
    return session
  }

  /**
   * Restores a persisted conversation and merges the incoming request without
   * duplicating a full-history client payload.
   */
  prepareSessionMessages(
    options: CreateSessionOptions & { sessionId: string },
    incomingMessages: ProxyChatMessage[],
  ): PreparedSessionContext {
    const session = this.getOrCreateSession(options)
    const persistedMessages = session.messages.map((message) => this.toProxyMessage(message))

    return {
      sessionId: session.sessionId,
      messages: mergeSessionMessages(persistedMessages, incomingMessages),
      isNew: session.isNew,
    }
  }

  /**
   * Persists the exact context sent upstream plus the resulting assistant
   * message. This makes summaries durable and lets a later `session_id` turn
   * resume without the client resending the entire transcript.
   */
  persistSessionContext(options: PersistSessionContextOptions): SessionRecord | null {
    const session = this.getSession(options.sessionId)
    if (!session) return null

    const conversation = [
      ...options.messages.map(cloneChatMessage),
      ...(options.assistantMessage ? [cloneChatMessage(options.assistantMessage)] : []),
    ]
    const storedMessages = this.limitStoredMessages(
      conversation.map((message) => this.toStoredMessage(message)),
    )
    const summary = this.extractSummary(storedMessages)
    const now = Date.now()
    const {
      contextSummary: _previousSummary,
      summarizedAt: _previousSummaryTimestamp,
      ...metadataWithoutSummary
    } = session.metadata ?? {}
    const metadata = {
      ...metadataWithoutSummary,
      ...(summary ? { contextSummary: summary, summarizedAt: now } : {}),
      ...(options.providerSessionId ? { providerSessionId: options.providerSessionId } : {}),
    }

    return storeManager.updateSession(options.sessionId, {
      providerId: options.providerId,
      accountId: options.accountId,
      ...(options.model ? { model: options.model } : {}),
      messages: storedMessages,
      lastActiveAt: now,
      status: 'active',
      metadata,
    })
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return storeManager.getSessionById(sessionId)
  }

  getAllActiveSessions(): SessionRecord[] {
    return storeManager.getActiveSessions()
  }

  getAllSessions(): SessionRecord[] {
    return storeManager.getSessions()
  }

  deleteSession(sessionId: string): boolean {
    const result = storeManager.deleteSession(sessionId)
    if (result) {
      console.log('[SessionManager] Deleted session:', sessionId)
    }
    return result
  }

  cleanExpiredSessions(): number {
    const removedCount = storeManager.cleanExpiredSessions()
    if (removedCount > 0) {
      console.log('[SessionManager] Cleaned expired sessions:', removedCount)
    }
    return removedCount
  }

  clearAllSessions(): void {
    storeManager.clearAllSessions()
    console.log('[SessionManager] Cleared all sessions')
  }

  getSessionsByAccount(accountId: string): SessionRecord[] {
    return storeManager.getSessionsByAccountId(accountId)
  }

  getSessionsByProvider(providerId: string): SessionRecord[] {
    return storeManager.getSessionsByProviderId(providerId)
  }

  shouldDeleteAfterChat(): boolean {
    const config = this.getSessionConfig()
    // The persisted setting predates the UI label. Existing users expect it
    // to control provider-side cleanup immediately after a completed chat.
    return config.deleteAfterTimeout
  }

  private toProxyMessage(message: ChatMessage): ProxyChatMessage {
    return cloneChatMessage({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.toolCalls
        ? {
            tool_calls: message.toolCalls.map((toolCall) => ({
              ...toolCall,
              function: { ...toolCall.function },
            })),
          }
        : {}),
    })
  }

  private toStoredMessage(message: ProxyChatMessage): ChatMessage {
    return {
      role: message.role,
      content: this.cloneContent(message.content),
      timestamp: Date.now(),
      ...(message.name ? { name: message.name } : {}),
      ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
      ...(message.tool_calls
        ? {
            toolCalls: message.tool_calls.map((toolCall) => ({
              ...toolCall,
              function: { ...toolCall.function },
            })),
          }
        : {}),
    }
  }

  private cloneStoredMessage(message: ChatMessage): ChatMessage {
    return {
      ...message,
      content: this.cloneContent(message.content),
      ...(message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((toolCall) => ({
              ...toolCall,
              function: { ...toolCall.function },
            })),
          }
        : {}),
    }
  }

  private cloneContent(content: ChatMessage['content']): ChatMessage['content'] {
    if (!Array.isArray(content)) return content
    return content.map((part) => ({
      ...part,
      ...(part?.image_url ? { image_url: { ...part.image_url } } : {}),
    }))
  }

  private limitStoredMessages(messages: ChatMessage[]): ChatMessage[] {
    const maxMessages = Math.max(1, this.getSessionConfig().maxMessagesPerSession)
    if (messages.length <= maxMessages)
      return messages.map((message) => this.cloneStoredMessage(message))

    const systemMessages = messages.filter((message) => message.role === 'system')
    const nonSystemMessages = messages.filter((message) => message.role !== 'system')
    const keepNonSystem = Math.max(0, maxMessages - systemMessages.length)
    let start = Math.max(0, nonSystemMessages.length - keepNonSystem)

    if (nonSystemMessages[start]?.role === 'tool') {
      let toolGroupStart = start
      while (toolGroupStart > 0 && nonSystemMessages[toolGroupStart - 1]?.role === 'tool') {
        toolGroupStart--
      }
      const precedingMessage = nonSystemMessages[toolGroupStart - 1]
      if (precedingMessage?.role === 'assistant' && precedingMessage.toolCalls?.length) {
        start = toolGroupStart - 1
      } else {
        while (start < nonSystemMessages.length && nonSystemMessages[start]?.role === 'tool')
          start++
      }
    }

    return [...systemMessages, ...nonSystemMessages.slice(start)].map((message) =>
      this.cloneStoredMessage(message),
    )
  }

  private extractSummary(messages: ChatMessage[]): string | undefined {
    const summaryPrefix = '[Conversation Summary]\n'
    const summaryMessage = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.startsWith(summaryPrefix),
      )

    return typeof summaryMessage?.content === 'string'
      ? summaryMessage.content.slice(summaryPrefix.length)
      : undefined
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }
}

export const sessionManager = new SessionManagerClass()
export default sessionManager
