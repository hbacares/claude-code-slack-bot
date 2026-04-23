import * as path from 'path';
import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager, McpServerConfig } from './mcp-manager';
import { SessionPersistence } from './session-persistence';
import { config } from './config';

function redactSecrets(text: string): string {
  return text
    .replace(/xox[bpas]-[0-9A-Za-z-]+/g, '[SLACK_TOKEN]')
    .replace(/sk-ant-[0-9A-Za-z-]+/g, '[ANTHROPIC_KEY]')
    .replace(/"SLACK_BOT_TOKEN"\s*:\s*"[^"]+"/g, '"SLACK_BOT_TOKEN":"[REDACTED]"')
    .replace(/"ANTHROPIC_API_KEY"\s*:\s*"[^"]+"/g, '"ANTHROPIC_API_KEY":"[REDACTED]"');
}

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;
  private persistence: SessionPersistence;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    this.persistence = new SessionPersistence(config.sessions.persistencePath);
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    this.persistence.saveSessions(this.sessions);
    return session;
  }

  loadPersistedSessions(): number {
    const loaded = this.persistence.loadSessions();
    this.sessions = loaded;
    this.logger.info('Loaded persisted sessions', { count: loaded.size });
    return loaded.size;
  }

  getAllSessions(): Map<string, ConversationSession> {
    return this.sessions;
  }

  clearAllSessions(): void {
    this.sessions.clear();
    this.persistence.saveSessions(this.sessions);
    this.logger.info('All sessions cleared');
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string }
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const options: any = {
      outputFormat: 'stream-json',
      permissionMode: 'bypassPermissions',
      ...(config.claude.executablePath && { pathToClaudeCodeExecutable: config.claude.executablePath }),
    };

    // Add permission prompt tool if we have Slack context
    if (slackContext) {
      options.permissionPromptToolName = 'mcp__permission-prompt__permission_prompt';
      this.logger.debug('Added permission prompt tool for Slack integration', slackContext);
    }

    if (workingDirectory) {
      options.cwd = workingDirectory;
    }

    // Add MCP server configuration if available
    const mcpServers = this.mcpManager.getServerConfiguration();
    
    // Add permission prompt server if we have Slack context
    if (slackContext) {
      const permissionServer = {
        'permission-prompt': {
          command: 'npx',
          args: ['tsx', path.join(process.cwd(), 'src', 'permission-mcp-server.ts')],
          env: {
            SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
            SLACK_CONTEXT: JSON.stringify(slackContext)
          }
        }
      };
      
      if (mcpServers) {
        options.mcpServers = { ...mcpServers, ...permissionServer };
      } else {
        options.mcpServers = permissionServer;
      }
    } else if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }
    
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      // Allow all MCP tools by default, plus permission prompt tool
      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (slackContext) {
        defaultMcpTools.push('mcp__permission-prompt');
      }
      if (defaultMcpTools.length > 0) {
        options.allowedTools = defaultMcpTools;
      }
      
      this.logger.debug('Added MCP configuration to options', {
        serverCount: Object.keys(options.mcpServers).length,
        servers: Object.keys(options.mcpServers),
        allowedTools: defaultMcpTools,
        hasSlackContext: !!slackContext,
      });
    }

    if (session?.sessionId) {
      options.resume = session.sessionId;
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    this.logger.debug('Claude query options', options);

    let lastStderr = '';
    options.stderr = (data: string) => {
      lastStderr = data.trim();
      this.logger.error('Claude process stderr', { stderr: redactSecrets(lastStderr) });
    };

    options.abortController = abortController || new AbortController();

    try {
      yield* this.runQuery(prompt, options, session);
    } catch (error: any) {
      const msg = (error?.message || '').toLowerCase();
      const stderrLower = lastStderr.toLowerCase();
      const isExitCode1 = msg.includes('exited with code 1');
      const isTooLong = stderrLower.includes('too long') || stderrLower.includes('prompt') ||
                        msg.includes('too long') || msg.includes('context') || msg.includes('token');

      if (session?.sessionId && (isTooLong || isExitCode1)) {
        this.logger.warn('Session resume failed — clearing sessionId and retrying fresh', {
          sessionId: session.sessionId,
          reason: lastStderr || error.message,
        });
        session.sessionId = undefined;
        delete options.resume;
        this.persistence.saveSessions(this.sessions);
        yield* this.runQuery(prompt, options, session);
      } else {
        this.logger.error('Error in Claude query', error);
        throw error;
      }
    }
  }

  private async *runQuery(
    prompt: string,
    options: any,
    session?: ConversationSession
  ): AsyncGenerator<SDKMessage, void, unknown> {
    let receivedResult = false;
    try {
      for await (const message of query({ prompt, options })) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (session) {
            session.sessionId = message.session_id;
            session.lastActivity = new Date();
            this.persistence.saveSessions(this.sessions);
            this.logger.info('Session initialized', {
              sessionId: message.session_id,
              model: (message as any).model,
              tools: (message as any).tools?.length || 0,
            });
          }
        }
        if (message.type === 'result' && message.subtype === 'success') {
          const resultText = ((message as any).result || '').toLowerCase();
          if (resultText.includes('prompt') && resultText.includes('too long')) {
            throw new Error('Prompt too long — session history exceeded context limit');
          }
          receivedResult = true;
        }
        yield message;
      }
    } catch (error: any) {
      if (receivedResult && (error?.message || '').includes('exited with code 1')) {
        this.logger.debug('Ignoring subprocess exit-code-1 after successful result');
        return;
      }
      throw error;
    }
  }

  cleanupInactiveSessions(maxAgeMs?: number) {
    // Use configured timeout (convert hours to milliseconds) or provided value
    const maxAge = maxAgeMs || (config.sessions.timeoutHours * 60 * 60 * 1000);
    const now = Date.now();
    let cleaned = 0;

    for (const [key, session] of this.sessions.entries()) {
      const ageMs = now - session.lastActivity.getTime();
      if (ageMs > maxAge) {
        this.sessions.delete(key);
        cleaned++;
        this.logger.debug('Session expired', {
          sessionKey: key,
          ageHours: (ageMs / (1000 * 60 * 60)).toFixed(2),
          maxAgeHours: (maxAge / (1000 * 60 * 60)).toFixed(2),
        });
      }
    }

    if (cleaned > 0) {
      this.persistence.saveSessions(this.sessions);
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`, {
        remaining: this.sessions.size,
        timeoutHours: (maxAge / (1000 * 60 * 60)).toFixed(2),
      });
    }

    return cleaned;
  }
}