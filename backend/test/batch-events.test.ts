import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createBatchEventScheduler } from '../src/infrastructure/realtime/batch-events.js';

test('batch updates collapse a burst and still flush immediately when asked', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const published: string[] = [];
  const scheduler = createBatchEventScheduler((batchId) => published.push(batchId), 400);

  scheduler.schedule('4');
  scheduler.schedule('4');
  scheduler.schedule('9');
  assert.deepEqual(published, []);

  mock.timers.tick(400);
  assert.deepEqual(published, ['4', '9']);

  scheduler.schedule('4');
  scheduler.schedule('4', true);
  assert.deepEqual(published, ['4', '9', '4']);

  mock.timers.tick(400);
  assert.deepEqual(published, ['4', '9', '4']);
  mock.timers.reset();
});
