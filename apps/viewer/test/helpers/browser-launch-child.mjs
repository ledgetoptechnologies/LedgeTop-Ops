import path from 'node:path';
import { launchBrowser } from '../browser-launch.mjs';
import { waitForDevToolsPort } from '../devtools-port.mjs';

// Child process for browser-launch.test.mjs: start a browser, report its
// profile, then leave without calling cleanup, the way a crashed or aborted
// test file would. The helper's exit/uncaught-error hooks must still stop it.
const [executable, mode = 'exit'] = process.argv.slice(2);
const { profile } = launchBrowser(executable, (dir) => ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { prefix: 'ltds-browser-launch-child-' });
await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'), { timeoutMs: 30_000 });
console.log(`PROFILE=${profile}`);
if (mode === 'throw') setTimeout(() => { throw new Error('simulated test crash'); }, 0);
else if (mode === 'signal') setInterval(() => {}, 1_000); // wait for the parent's SIGTERM
else process.exit(0);
