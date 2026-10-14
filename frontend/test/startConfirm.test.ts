import assert from 'node:assert/strict';
import test from 'node:test';
import { startConfirmCopy } from '../src/lib/startConfirm.ts';

test('invoice generation asks again and names the generation process', () => {
  const copy = startConfirmCopy('invoice-generation', 12200, 'customers.xlsx');
  assert.equal(copy.title, 'Start invoice generation?');
  assert.equal(copy.confirm, 'Start invoice generation');
  assert.match(copy.body, /invoice generation process/);
  assert.match(copy.body, /12,200 customers/);
  assert.match(copy.body, /customers\.xlsx/);
});

test('invoice charge asks again and names the charge process', () => {
  const copy = startConfirmCopy('invoice-charge', 5, 'due.csv');
  assert.equal(copy.title, 'Start invoice charge?');
  assert.equal(copy.confirm, 'Start invoice charge');
  assert.match(copy.body, /invoice charge process/);
  assert.match(copy.body, /5 customers/);
  assert.match(copy.body, /due\.csv/);
  assert.doesNotMatch(copy.body, /invoice generation process/);
});
