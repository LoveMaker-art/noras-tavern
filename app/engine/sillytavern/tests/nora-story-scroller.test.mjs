import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoryScroller } from '../../../native-extensions/nora-ui/story-scroller.js';

test('scrolls to the latest message after layout height settles', async () => {
    const container = { scrollHeight: 120, scrollTop: 0 };
    const frameHeights = [240, 360, 360];
    const scroller = createStoryScroller({
        getContainer: () => container,
        scheduleFrame: callback => {
            container.scrollHeight = frameHeights.shift() ?? container.scrollHeight;
            callback();
        },
    });

    await scroller.toLatest();

    assert.equal(container.scrollTop, 360);
});

test('keeps the story pinned to the latest message while a World layout is replaced', async () => {
    const container = { scrollHeight: 120, scrollTop: 0 };
    const frames = [];
    const scroller = createStoryScroller({
        getContainer: () => container,
        scheduleFrame: callback => frames.push(callback),
    });

    const stopFollowing = scroller.followLatest();
    assert.equal(container.scrollTop, 120);

    container.scrollHeight = 360;
    frames.shift()();
    assert.equal(container.scrollTop, 360);

    container.scrollHeight = 720;
    frames.shift()();
    assert.equal(container.scrollTop, 720);

    const stopped = stopFollowing();
    container.scrollHeight = 960;
    for (let frame = 0; frame < 3; frame += 1) frames.shift()();
    await stopped;
    assert.equal(container.scrollTop, 960);

    container.scrollHeight = 1200;
    assert.equal(container.scrollTop, 960);
});

test('pins rich content resize before the next layout frame is painted', async () => {
    const container = { scrollHeight: 120, scrollTop: 0 };
    const frames = [];
    let onResize;
    let onUserIntent;
    let disconnected = false;
    const scroller = createStoryScroller({
        getContainer: () => container,
        scheduleFrame: callback => frames.push(callback),
        observeResize: (element, callback) => {
            assert.equal(element, container);
            onResize = callback;
            return () => { disconnected = true; };
        },
        observeUserIntent: (_element, callback) => {
            onUserIntent = callback;
            return () => {};
        },
    });

    const stopFollowing = scroller.followLatest();
    container.scrollHeight = 640;
    onResize();

    assert.equal(container.scrollTop, 640);
    const stopped = stopFollowing();
    for (let frame = 0; frame < 3; frame += 1) frames.shift()();
    await stopped;
    assert.equal(disconnected, false);
    container.scrollTop = 0;
    onUserIntent();
    assert.equal(disconnected, true);
});

test('pins rich DOM mutations before layout is recalculated', async () => {
    const container = { scrollHeight: 120, scrollTop: 0 };
    const frames = [];
    let onMutation;
    let onUserIntent;
    let disconnected = false;
    const scroller = createStoryScroller({
        getContainer: () => container,
        scheduleFrame: callback => frames.push(callback),
        observeMutations: (element, callback) => {
            assert.equal(element, container);
            onMutation = callback;
            return () => { disconnected = true; };
        },
        observeUserIntent: (_element, callback) => {
            onUserIntent = callback;
            return () => {};
        },
    });

    const stopFollowing = scroller.followLatest();
    container.scrollHeight = 840;
    onMutation();

    assert.equal(container.scrollTop, 840);
    const stopped = stopFollowing();
    for (let frame = 0; frame < 3; frame += 1) frames.shift()();
    await stopped;
    assert.equal(disconnected, false);
    container.scrollTop = 0;
    onUserIntent();
    assert.equal(disconnected, true);
});

test('keeps following while late rich frames finish resizing', async () => {
    const container = { scrollHeight: 120, scrollTop: 0 };
    const frames = [];
    let onMutation;
    let disconnected = false;
    let onUserIntent;
    const scroller = createStoryScroller({
        getContainer: () => container,
        scheduleFrame: callback => frames.push(callback),
        observeMutations: (_element, callback) => {
            onMutation = callback;
            return () => { disconnected = true; };
        },
        observeUserIntent: (_element, callback) => {
            onUserIntent = callback;
            return () => {};
        },
    });

    const stopFollowing = scroller.followLatest();
    container.scrollHeight = 640;
    onMutation();
    assert.equal(container.scrollTop, 640);

    const stopped = stopFollowing();
    container.scrollHeight = 1438;
    onMutation();

    assert.equal(container.scrollTop, 1438);
    assert.equal(disconnected, false);
    assert.ok(stopped instanceof Promise);

    for (let frame = 0; frame < 3; frame += 1) frames.shift()();
    await stopped;
    assert.equal(disconnected, false);

    container.scrollHeight = 1800;
    onMutation();
    assert.equal(container.scrollTop, 1800);

    container.scrollTop = 0;
    onUserIntent();
    assert.equal(disconnected, true);
});

test('starting a new follow releases observers from the previous World', () => {
    const container = { scrollHeight: 120, scrollTop: 0 };
    const frames = [];
    let disconnects = 0;
    const scroller = createStoryScroller({
        getContainer: () => container,
        scheduleFrame: callback => frames.push(callback),
        observeMutations: () => () => { disconnects += 1; },
    });

    scroller.followLatest();
    scroller.followLatest();

    assert.equal(disconnects, 1);
});
