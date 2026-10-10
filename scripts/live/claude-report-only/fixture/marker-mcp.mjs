// Disposable stdio MCP server for the live verification. Its one tool appends a line to a marker file,
// so a namespaced mcp call that really executed is visible as a file effect. No dependencies.
//   MARKER_FILE=<path> node marker-mcp.mjs
import fs from 'node:fs';
import readline from 'node:readline';

const marker = process.env.MARKER_FILE;
if (!marker) { process.stderr.write('MARKER_FILE is required\n'); process.exit(2); }
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');

readline.createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params } = request;
  if (method === 'initialize') {
    reply(id, { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'heimdall-marker', version: '0.0.0' } });
  } else if (method === 'tools/list') {
    reply(id, { tools: [{ name: 'write_marker', description: 'Append one line to the disposable fixture marker file and return the line count.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] });
  } else if (method === 'tools/call') {
    if (params?.name !== 'write_marker') return fail(id, -32602, 'unknown tool');
    fs.appendFileSync(marker, JSON.stringify({ at: Date.now(), text: String(params.arguments?.text ?? '') }) + '\n');
    const lines = fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length;
    reply(id, { content: [{ type: 'text', text: `marker written, lines=${lines}` }] });
  } else if (id !== undefined) fail(id, -32601, 'method not found');
});
