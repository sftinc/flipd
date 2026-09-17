import test from 'node:test';
import assert from 'node:assert/strict';
import upgrade, { parseSystemdShow } from '../lib/cli/upgrade.mjs';

function capture() {
  const out = [];
  const err = [];
  return {
    out, err,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    text: () => out.join(''),
    errText: () => err.join(''),
  };
}

test('parseSystemdShow reads labelled properties and the ExecStart path', () => {
  const out = [
    'LoadState=loaded',
    'ActiveState=active',
    'SubState=running',
    'MainPID=1234',
    'ExecStart={ path=/opt/flipd/bin/flipd ; argv[]=/opt/flipd/bin/flipd serve ; ignore_errors=no ; start_time=[n/a] ; pid=0 }',
  ].join('\n');
  const u = parseSystemdShow(out);
  assert.equal(u.loadState, 'loaded');
  assert.equal(u.activeState, 'active');
  assert.equal(u.subState, 'running');
  assert.equal(u.mainPid, '1234');
  assert.equal(u.execStart, '/opt/flipd/bin/flipd');
});

test('a unit that does not exist exits 0 and says so in LoadState, not in the exit code', () => {
  const u = parseSystemdShow('LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nExecStart=');
  assert.equal(u.loadState, 'not-found');
  assert.equal(u.execStart, '');
});

test('a bad flag is a usage error on stderr, exit 2', async () => {
  const c = capture();
  const code = await upgrade(['--nope'], { paths: {}, stdout: c.stdout, stderr: c.stderr });
  assert.equal(code, 2);
  assert.match(c.errText(), /usage: flipd upgrade \[--restart-only\]/);
});
