// After the recovery scenarios: every executor child must be idle, unrestricted, and able to run an ordinary tool call.
//   node t2-postcheck.mjs --root /private/tmp/heimdall-0006.XXXXXX
// The check prompts each executor child directly (its agent allows all tools) to write one file in its own disposable
// repository, then verifies the file and that the call reached every hook (not stopped by Heimdall).
import fs from 'node:fs';
import path from 'node:path';
import { assertFixtureRoot, parseArguments } from './lib.mjs';
import { connect, control, prompt, readLog, transcript, waitIdle } from './t2-client.mjs';

const root = assertFixtureRoot(parseArguments(process.argv.slice(2)).root ?? '');
const results = [];
for (const scenario of ['correct', 'cap', 'interrupt']) {
  const connection = await connect(root, `recovery:${scenario}`);
  const runs = path.join(connection.directory, '.heimdall', 'runs');
  const id = fs.readdirSync(runs).find(name => fs.existsSync(path.join(runs, name, 'state.json')));
  const state = JSON.parse(fs.readFileSync(path.join(runs, id, 'state.json'), 'utf8'));
  const child = state.child ?? state.results[0]?.sessionId;
  const active = await connection.client.session.active();
  const before = await control(root, 'has', { sessionID: child });
  const file = `after-release-${scenario}.txt`;
  const offset = readLog(root, 'observer.jsonl').length;
  await prompt(connection, child, `Use the write tool to create the file ${file} in the repository root containing exactly the text ok. Then reply done.`);
  await waitIdle(connection, child, 300_000);
  const events = readLog(root, 'observer.jsonl').slice(offset).filter(event => event.sessionID === child);
  results.push({
    scenario, child, idleBefore: !(child in active), restrictionBefore: before,
    fileWritten: fs.existsSync(path.join(connection.directory, file)) && fs.readFileSync(path.join(connection.directory, file), 'utf8') === 'ok',
    writeReachedAllHooks: events.some(event => event.stage === 'post' && event.event === 'execute.before' && event.tool === 'write'),
    writeCompleted: events.some(event => event.stage === 'post' && event.event === 'execute.after' && event.status === 'completed'),
    contextToolCounts: events.filter(event => event.stage === 'post' && event.event === 'context').map(event => event.tools.length),
  });
}
fs.writeFileSync(path.join(root, 'evidence', 'recovery-postcheck.json'), JSON.stringify(results, null, 2));
process.stdout.write(JSON.stringify(results, null, 1) + '\n');
