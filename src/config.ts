import dotenv from 'dotenv';

dotenv.config();

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
    executablePath: process.env.CLAUDE_CODE_PATH || '',
  },
  baseDirectory: process.env.BASE_DIRECTORY || '',
  debug: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
  sessions: {
    timeoutHours: parseFloat(process.env.SESSION_TIMEOUT_HOURS || '24'),
    persistencePath: process.env.SESSION_PERSISTENCE_PATH || './data/sessions.json',
    cleanupIntervalMinutes: parseFloat(process.env.SESSION_CLEANUP_INTERVAL_MINUTES || '5'),
  },
};

export function validateConfig() {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}