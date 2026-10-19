import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AccessClient, loadConfig, login } from './access-client.mjs';
import { createServer } from './server.mjs';

try {
  const config = loadConfig();
  const command = process.argv[2] ?? 'serve';
  if (process.argv.length > 3 || !['serve', 'login', 'doctor'].includes(command)) throw Error('usage');
  if (command === 'login') {
    process.stderr.write(`Opening Cloudflare Access login for ${config.origin}. Complete it in your browser.\n`);
    await login(config);
    process.stderr.write('Access login completed. Run doctor to verify Operations authorization.\n');
  } else if (command === 'doctor') {
    const result = await new AccessClient(config).session();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const server = createServer(new AccessClient(config), config);
    const close = async () => { await server.close(); process.exitCode = 0; };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    await server.connect(new StdioServerTransport());
  }
} catch (error) {
  process.stderr.write(error?.name === 'AccessClientError' ? `${error.message}\n` : 'Operations MCP could not start. Check configuration and use serve, login, or doctor.\n');
  process.exitCode = 1;
}
