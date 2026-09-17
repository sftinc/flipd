import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSite, MARKER } from '../lib/cli/domain.mjs';

test('a port site renders a reverse_proxy block with every host on one line', () => {
  assert.equal(renderSite({ hosts: ['app.example.com', 'www.example.com'], port: '3000' }), `${MARKER} — edits are lost on the next \`flipd domain\` command
app.example.com, www.example.com {
    log {
        output stderr
    }
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
`);
});

test('a root site renders file_server, and --spa adds the try_files fallback', () => {
  const plain = renderSite({ hosts: ['a.example.com'], root: '/var/www/app' });
  assert.match(plain, /^    root \* \/var\/www\/app$/m);
  assert.match(plain, /^    file_server$/m);
  assert.doesNotMatch(plain, /try_files/);
  assert.doesNotMatch(plain, /handle/);

  const spa = renderSite({ hosts: ['a.example.com'], root: '/var/www/app', spa: true });
  assert.match(spa, /^    handle \{\n        try_files \{path\} \/index\.html\n        file_server\n    \}$/m);
});

test('every rendered file starts with the marker', () => {
  for (const s of [renderSite({ hosts: ['a.example.com'], port: '80' }), renderSite({ hosts: ['a.example.com'], root: '/x' })]) {
    assert.ok(s.startsWith(MARKER));
  }
});
