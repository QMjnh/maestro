// Start a program without it inheriting our handles. A plain child_process.spawn would hand
// the server's listening socket to Spotify/Edge on Windows, and they'd keep Maestro's port busy
// after Maestro exits. Start-Process goes through ShellExecute, which doesn't pass handles on.
const { spawn } = require('child_process');

function launch(exe, args = []) {
  if (process.platform !== 'win32') {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return Promise.resolve();
  }
  // Values travel through env vars so no quoting/escaping of paths is needed.
  const script = args.length
    ? 'Start-Process -FilePath $env:MAESTRO_EXE -ArgumentList ($env:MAESTRO_ARGS | ConvertFrom-Json)'
    : 'Start-Process -FilePath $env:MAESTRO_EXE';
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      // Windows PowerShell joins -ArgumentList with plain spaces, so quote anything with spaces.
      env: { ...process.env, MAESTRO_EXE: exe, MAESTRO_ARGS: JSON.stringify(args.map((a) => (/\s/.test(a) ? `"${a}"` : a))) },
    });
    let err = '';
    ps.stderr.on('data', (d) => (err += d));
    ps.on('error', reject);
    ps.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n')[0] || `Could not start ${exe}`))));
  });
}

module.exports = { launch };
