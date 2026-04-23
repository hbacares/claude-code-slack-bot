import * as fs from 'fs';
import * as path from 'path';
import { ConversationSession } from './types';
import { Logger } from './logger';

export class SessionPersistence {
  private logger = new Logger('SessionPersistence');
  private persistencePath: string;

  constructor(persistencePath: string = './data/sessions.json') {
    this.persistencePath = path.resolve(persistencePath);
    this.ensureDirectoryExists();
  }

  private ensureDirectoryExists() {
    const dir = path.dirname(this.persistencePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      this.logger.info('Created sessions directory', { path: dir });
    }
  }

  /**
   * Save sessions to disk
   */
  saveSessions(sessions: Map<string, ConversationSession>): boolean {
    try {
      // Convert Map to object for JSON serialization
      const sessionsObject: Record<string, any> = {};

      for (const [key, session] of sessions.entries()) {
        sessionsObject[key] = {
          ...session,
          lastActivity: session.lastActivity.toISOString(), // Convert Date to string
        };
      }

      const data = JSON.stringify(sessionsObject, null, 2);
      fs.writeFileSync(this.persistencePath, data, 'utf-8');

      this.logger.debug('Sessions saved to disk', {
        count: sessions.size,
        path: this.persistencePath
      });

      return true;
    } catch (error) {
      this.logger.error('Failed to save sessions', error);
      return false;
    }
  }

  /**
   * Load sessions from disk
   */
  loadSessions(): Map<string, ConversationSession> {
    const sessions = new Map<string, ConversationSession>();

    try {
      if (!fs.existsSync(this.persistencePath)) {
        this.logger.info('No persisted sessions file found, starting fresh');
        return sessions;
      }

      const data = fs.readFileSync(this.persistencePath, 'utf-8');
      const sessionsObject = JSON.parse(data);

      for (const [key, sessionData] of Object.entries(sessionsObject)) {
        const session = sessionData as any;

        // Reconstruct the session with Date object
        sessions.set(key, {
          userId: session.userId,
          channelId: session.channelId,
          threadTs: session.threadTs,
          sessionId: session.sessionId,
          isActive: session.isActive,
          lastActivity: new Date(session.lastActivity), // Convert string back to Date
          workingDirectory: session.workingDirectory,
        });
      }

      this.logger.info('Sessions loaded from disk', {
        count: sessions.size,
        path: this.persistencePath
      });

      return sessions;
    } catch (error) {
      this.logger.error('Failed to load sessions, starting fresh', error);
      return sessions;
    }
  }

  /**
   * Delete the persistence file (useful for testing or manual cleanup)
   */
  clearPersistedSessions(): boolean {
    try {
      if (fs.existsSync(this.persistencePath)) {
        fs.unlinkSync(this.persistencePath);
        this.logger.info('Persisted sessions file deleted');
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error('Failed to delete persisted sessions', error);
      return false;
    }
  }

  /**
   * Get stats about persisted sessions
   */
  getStats(): { exists: boolean; count: number; size: number; lastModified?: Date } {
    try {
      if (!fs.existsSync(this.persistencePath)) {
        return { exists: false, count: 0, size: 0 };
      }

      const stats = fs.statSync(this.persistencePath);
      const data = fs.readFileSync(this.persistencePath, 'utf-8');
      const sessionsObject = JSON.parse(data);

      return {
        exists: true,
        count: Object.keys(sessionsObject).length,
        size: stats.size,
        lastModified: stats.mtime,
      };
    } catch (error) {
      this.logger.error('Failed to get persistence stats', error);
      return { exists: false, count: 0, size: 0 };
    }
  }
}
