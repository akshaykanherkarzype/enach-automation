import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { delayQueueSetup, shouldRequeueHandlerError } from '../src/infrastructure/rabbitmq/client.ts';

describe('delay queue lease', () => {
  it('keeps the queue long after the message should have dead-lettered', () => {
    const hold = delayQueueSetup(300_000);
    assert.equal(hold.ttlMs, 300_000);
    assert.ok(hold.expiresMs - hold.ttlMs >= 60 * 60 * 1000);

    const pause = delayQueueSetup(30_000);
    assert.equal(pause.ttlMs, 30_000);
    assert.ok(pause.expiresMs > pause.ttlMs);
  });

  it('rounds a fractional delay up to a whole millisecond', () => {
    const setup = delayQueueSetup(1500.2);
    assert.equal(setup.ttlMs, 1501);
  });
});

describe('handler failures', () => {
  it('puts the customer back when the database connection drops', () => {
    const closed = new Error('Server has closed the connection.');
    (closed as { code?: string }).code = 'P1017';
    assert.equal(shouldRequeueHandlerError(closed), true);
    assert.equal(shouldRequeueHandlerError(new Error("Can't reach database server at `127.0.0.1:3307`")), true);
    assert.equal(shouldRequeueHandlerError(new Error('Shutting down — message will be nacked')), true);
    assert.equal(shouldRequeueHandlerError(new Error('Unexpected token')), false);
  });
});
