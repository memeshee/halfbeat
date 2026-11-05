// HalfBeat — configuration and CLI parsing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_KEY_FILE = path.join(os.homedir(), '.presage_api_key');

/** API key resolution order: --key, SMARTSPECTRA_API_KEY, ~/.presage_api_key */
export function resolveApiKey(cliKey) {
  if (cliKey && cliKey.trim()) return { key: cliKey.trim(), from: '--key' };
  const env = process.env.SMARTSPECTRA_API_KEY;
  if (env && env.trim()) return { key: env.trim(), from: 'env:SMARTSPECTRA_API_KEY' };
  try {
    const raw = fs.readFileSync(HOME_KEY_FILE, 'utf8').trim();
    if (raw) return { key: raw, from: HOME_KEY_FILE };
  } catch {
    /* not present */
  }
  return { key: null, from: 'none' };
}

export const QUESTIONS = [
  'Tell me about yourself.',
  'Why do you want to work here?',
  'Walk me through a project you are proud of.',
  'Tell me about a time you disagreed with a teammate.',
  'What is your greatest weakness?',
  'What are your salary expectations?',
];

export function parseArgs(argv = process.argv.slice(2)) {
  const cfg = {
    source: 'camera',           // camera | file | mock
    file: null,
    cameraId: null,
    port: 7777,
    open: true,
    headless: false,
    out: null,
    key: null,
    baselineSec: 45,
    answerSec: 60,
    recoverSec: 60,
    questions: QUESTIONS,
    rounds: QUESTIONS.length,
    width: 1280,
    height: 720,
    telemetry: false,           // we ship with SDK telemetry OFF by default
    maxSeconds: 0,              // file mode safety stop
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--source': cfg.source = next(); break;
      case '--file': cfg.file = path.resolve(next()); break;
      case '--camera': cfg.cameraId = next(); break;
      case '--port': cfg.port = Number(next()); break;
      case '--out': cfg.out = path.resolve(next()); break;
      case '--key': cfg.key = next(); break;
      case '--baseline': cfg.baselineSec = Number(next()); break;
      case '--answer': cfg.answerSec = Number(next()); break;
      case '--recover': cfg.recoverSec = Number(next()); break;
      case '--rounds': cfg.rounds = Number(next()); break;
      case '--width': cfg.width = Number(next()); break;
      case '--height': cfg.height = Number(next()); break;
      case '--max-seconds': cfg.maxSeconds = Number(next()); break;
      case '--headless': cfg.headless = true; break;
      case '--no-open': cfg.open = false; break;
      case '--telemetry': cfg.telemetry = true; break;
      case '--help': cfg.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (cfg.source === 'file' && !cfg.file) throw new Error('--source file requires --file <path>');
  cfg.questions = QUESTIONS.slice(0, Math.max(1, Math.min(cfg.rounds, QUESTIONS.length)));
  cfg.rounds = cfg.questions.length;
  return cfg;
}

export const HELP = `
HalfBeat — how fast do you come back down?

  npm start                         live camera session (default)
  npm run replay                    mock signal source (no camera, no API key)
  npm run file -- --file clip.mp4   run a recorded video through the SDK

Flags
  --source camera|file|mock   input source (default: camera)
  --file <path>               video file for --source file
  --camera <id>               camera id (see --list-cameras)
  --port <n>                  UI port (default 7777)
  --baseline <s> --answer <s> --recover <s>   phase lengths in seconds
  --rounds <n>                number of questions (max ${QUESTIONS.length})
  --out <path>                write the session JSON here
  --headless                  no UI, print one JSON line per sample
  --telemetry                 leave the SDK's aggregate telemetry ON (default: off)
  --key <key>                 SmartSpectra API key (default: $SMARTSPECTRA_API_KEY, ~/.presage_api_key)
`;
