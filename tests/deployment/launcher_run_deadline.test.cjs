const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRunDeadline } = require('../installer/desktop/operation-delegate');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('expires after the stall window when nothing resets it', async () => {
  let expired = false;
  const deadline = createRunDeadline({ stallMs: 25, onExpire: () => { expired = true; } });
  await wait(60);
  assert.equal(expired, true);
  deadline.cancel();
});

test('refresh defers expiry while progress continues', async () => {
  let expired = false;
  const deadline = createRunDeadline({ stallMs: 40, onExpire: () => { expired = true; } });
  for (let index = 0; index < 4; index += 1) {
    await wait(20);
    deadline.refresh();
  }
  assert.equal(expired, false, 'progress keeps the deadline alive');
  await wait(70);
  assert.equal(expired, true, 'expiry fires once progress stops');
});

test('hard ceiling expires despite refreshes and reports stalled', async () => {
  let expired = false;
  const deadline = createRunDeadline({ stallMs: 500, hardTimeoutMs: 40, onExpire: () => { expired = true; } });
  const refresher = setInterval(() => deadline.refresh(), 10);
  await wait(90);
  clearInterval(refresher);
  assert.equal(expired, true);
  assert.equal(deadline.isStalled(), true, 'hard-ceiling expiry is distinguishable from a stall');
});

test('cancel prevents expiry', async () => {
  let expired = false;
  const deadline = createRunDeadline({ stallMs: 20, hardTimeoutMs: 40, onExpire: () => { expired = true; } });
  deadline.cancel();
  await wait(80);
  assert.equal(expired, false);
});
