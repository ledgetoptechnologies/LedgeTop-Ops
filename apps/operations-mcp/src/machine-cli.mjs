import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MachineReadClient } from './machine-client.mjs';
import { createMachineServer } from './machine-server.mjs';

try {
  const command = process.argv[2] ?? 'serve';
  if (!['serve', 'doctor'].includes(command) || process.argv.length > 3) throw Error();
  const client = new MachineReadClient();
  if (command === 'doctor') process.stdout.write(`${JSON.stringify(await client.connection())}\n`);
  else await createMachineServer(client).connect(new StdioServerTransport());
} catch {
  process.stderr.write('Staging machine MCP unavailable. Check the private local configuration and current agent registration.\n');
  process.exitCode = 1;
}
