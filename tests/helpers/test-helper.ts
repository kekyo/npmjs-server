import path from 'path';
import net from 'node:net';
import dayjs from 'dayjs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LogLevel } from '../../src/types';
import { ensureDir } from './fs-utils';

const execAsync = promisify(exec);

// Test global log level string
export const testGlobalLogLevel =
  (process.env['NPMJS_SERVER_TEST_LOGLEVEL'] as LogLevel | undefined) ?? 'warn';

// Timestamp for test directories
const timestamp = dayjs().format('YYYYMMDD_HHmmss');

/**
 * Creates a test directory with timestamp for test isolation
 * @remarks WARNING: Do NOT construct nested `describe()` tests, isolation environment will break.
 */
export const createTestDirectory = async (
  categoryName: string,
  testName: string
): Promise<string> => {
  // Sanitize names to be filesystem-safe
  const sanitize = (name: string) =>
    name
      .replaceAll(' ', '-')
      .replaceAll('/', '_') // Replace slash with underscore
      .replaceAll('\\', '_') // Replace backslash
      .replaceAll(':', '_') // Replace colon
      .replaceAll('*', '_') // Replace asterisk
      .replaceAll('?', '_') // Replace question mark
      .replaceAll('"', '_') // Replace double quote
      .replaceAll('<', '_') // Replace less than
      .replaceAll('>', '_') // Replace greater than
      .replaceAll('|', '_'); // Replace pipe

  const testDir = path.join(
    process.cwd(),
    'test-results',
    timestamp,
    sanitize(categoryName),
    sanitize(testName)
  );
  await ensureDir(testDir);
  return testDir;
};

const isPortAvailable = async (port: number): Promise<boolean> =>
  await new Promise((resolve) => {
    const server = net.createServer();

    server.unref();

    server.once('error', () => {
      resolve(false);
    });

    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });

/**
 * Finds an available test port near the requested base port.
 * Uses process.pid and a randomized starting offset, then scans for the first free port.
 * @remarks WARNING: Do NOT construct nested `describe()` tests, isolation environment will break.
 */
export const getTestPort = async (basePort: number = 6000): Promise<number> => {
  const rangeSize = 5000;
  const pidComponent = process.pid % 1000;
  const randomComponent = Math.floor(Math.random() * 4000);
  const initialOffset = (pidComponent + randomComponent) % rangeSize;

  for (let attempt = 0; attempt < rangeSize; attempt++) {
    const port = basePort + ((initialOffset + attempt) % rangeSize);

    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(
    `Could not find an available test port in range ${basePort}-${basePort + rangeSize - 1}`
  );
};

/**
 * Forcefully terminates any remaining CLI processes
 * Used in test cleanup to prevent zombie processes
 */
export const cleanupCLIProcesses = async (): Promise<void> => {
  try {
    // Use shell command with proper error suppression
    // pkill returns 1 when no processes are found, which is normal
    await execAsync('pkill -f "dist/cli" 2>/dev/null || true');
  } catch (error) {
    // Silently ignore all errors - this is expected when no processes exist
  }
};
