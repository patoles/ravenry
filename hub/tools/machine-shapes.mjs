// Machines in every shape the Machines page draws, as GET /api/machines
// lists them (server/remoteinstall.mjs view()), less their card: connected,
// older, newer, another protocol, not installed, ssh refused with its fix,
// an install half way, one stopped with a fix, one done with the hooks left
// as they were, and an uninstall waiting on sessions. Used by
// machineview-test.mjs and the native Mac app's sidetest (--screen machines).

const at = (m) => new Date(Date.UTC(2026, 10, 9, 9, m)).toISOString();
const base = { command: 'ravenryd proxy', error: null, answers: true, os: 'linux', arch: 'amd64', protocol: 1, older: [], missing: false, remote: null, ours: '0.1.24', explain: null, job: null };
const step = (id, title, state, extra = {}) => ({ id, title, state, detail: null, ...extra });

export const SHAPES = [
  { ...base, name: 'devbox', host: 'tester@devbox', state: 'connected', version: '0.1.24', compare: 'same' },
  { ...base, name: 'gpu-box', host: 'gpu-box', state: 'connected', version: '0.1.21', compare: 'older', older: ['0.1.21'] },
  { ...base, name: 'studio', host: 'studio.tail1234.ts.net', state: 'connected', os: 'darwin', arch: 'arm64', version: '0.1.26', compare: 'newer', answers: false },
  { ...base, name: 'old-nas', host: 'admin@nas', state: 'connected', version: '0.0.9', protocol: 0, compare: 'protocol', remote: { version: '0.0.9', protocol: 0, os: 'linux', arch: 'arm64' } },
  { ...base, name: 'pi', host: 'pi@raspberrypi', state: 'down', version: null, os: null, arch: null, missing: true, compare: 'missing' },
  { ...base, name: 'build-server', host: 'deploy@buildbox', state: 'down', version: null, os: null, arch: null, error: 'Permission denied (publickey).', compare: null,
    explain: { why: 'buildbox did not take your key: ssh tried ~/.ssh/id_ed25519 and was refused.', fix: 'ssh-copy-id deploy@buildbox', fixWhat: 'Copy your key there once:' } },
  { ...base, name: 'render-1', host: 'render-1', state: 'connected', version: null, compare: null,
    job: { kind: 'install', state: 'running', startedAt: at(1), endedAt: null, needs: null, version: '0.1.24', steps: [
      step('reach', 'Reach render-1', 'done', { detail: 'Linux, x86-64', ms: 1200 }),
      step('copy', 'Copy ravenryd 0.1.24', 'running', { progress: { done: 4404019, total: 9227468 } }),
      step('hooks', 'Add the hooks', 'pending'),
      step('start', 'Start it', 'pending')] } },
  { ...base, name: 'bsd-box', host: 'bsd-box', state: 'connected', version: null, compare: null,
    job: { kind: 'install', state: 'failed', startedAt: at(2), endedAt: at(3), needs: null, version: '0.1.24', steps: [
      step('reach', 'Reach bsd-box', 'done', { detail: 'FreeBSD, x86-64' }),
      step('copy', 'Copy ravenryd 0.1.24', 'failed', { detail: 'There is no ravenryd for FreeBSD. Ravenry runs on macOS and Linux.' }),
      step('disk', 'Room on the disk', 'failed', { detail: 'Only 3 MB free in ~/.ravenry/bin, and ravenryd needs 12 MB.', fix: 'df -h ~', fixWhat: 'See what takes the room:' })] } },
  { ...base, name: 'lab', host: 'lab', state: 'connected', version: '0.1.24', compare: 'same',
    job: { kind: 'install', state: 'done', startedAt: at(4), endedAt: at(5), needs: null, version: '0.1.24', steps: [
      step('copy', 'Copy ravenryd 0.1.24', 'done', { ms: 3400 }),
      step('hooks', 'Add the hooks', 'warn', { detail: 'Claude Code already runs other hooks for these events in ~/.claude/settings.json; they were left as they were.', action: 'replaceHooks' })] } },
  { ...base, name: 'old-laptop', host: 'old-laptop', state: 'connected', version: '0.1.24', compare: 'same',
    job: { kind: 'uninstall', state: 'needs', startedAt: at(6), endedAt: null, needs: { kind: 'sessions', count: 2 }, version: null, steps: [
      step('sessions', 'Sessions still run there', 'warn', { detail: '2 sessions run on old-laptop. Uninstall ends them.', action: 'endSessions' })] } },
];

export const HOSTS = ['devbox', 'gpu-box', 'studio', 'pi', 'build-server'];
export const BUILDS = { version: '0.1.24', systems: ['darwin-arm64', 'linux-x64'], source: 'app' };
