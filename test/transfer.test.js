/**
 * Replies the client cannot use -- one that arrives after its call timed
 * out, one of the wrong kind, one without an id -- are dropped, they do not
 * take the process down.
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import transport from '../transfer.js';

const quiet = { unknown_message_id: false, invalid_kind: false, no_message_id: false };

for (const [name, warn] of [['with the default warnings', undefined], ['with warnings off', quiet]]) {
  test(`unusable replies are dropped ${name}`, (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const { tp } = transport(warn ? { warn } : {}, {});

    assert.equal(tp.handleResponse({ k: 'res', id: 'timed-out', res: 1 }, {}), false);
    assert.equal(tp.handleResponse({ k: 'req', id: 'x' }, {}), false);
    assert.equal(tp.handleResponse({ k: 'res', id: null }, {}), false);
    assert.equal(log.mock.callCount(), warn ? 0 : 3);
  });
}
