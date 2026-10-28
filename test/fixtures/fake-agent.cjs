const fs = require('node:fs');
// Used by the .cmd fixture. Native argv capture; no agent services required.
if (process.argv.length < 3) {
  // node --test also discovers .cjs fixtures. Import/discovery must be inert.
} else if (process.argv[2] === '--version') {
  console.log('fake-agent 1.2.3');
} else {
  console.log(JSON.stringify({ type: 'fixture.args', stdin: process.argv.at(-1) === '-' ? fs.readFileSync(0, 'utf8') : null, arguments: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));
  console.error('fixture stderr: café 中文');
  if (process.env.FAKE_AGENT_MODE === 'cursor') {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-session', model: 'reported-model' }));
  } else {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'cmd-thread' }));
  }
}
