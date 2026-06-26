// Launcher that strips ELECTRON_RUN_AS_NODE before spawning Electron.
// VS Code's integrated terminal sets this var for its own tooling, and it
// leaks into child processes — causing Electron to launch as plain Node
// instead of the real runtime (require('electron') returns a path string,
// so `app` is undefined).
const { spawn } = require('child_process');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
