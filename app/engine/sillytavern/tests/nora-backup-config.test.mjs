import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { addMissingConfigValues } from '../src/config-init.js';
import { keyToEnv } from '../src/util.js';

const defaults = yaml.parse(fs.readFileSync(new URL('../default/config.yaml', import.meta.url), 'utf8'));
const retiredKeys = ['maxTotalChatBackups', 'backups.chat.maxTotalBackups'];

function fixture(t, config = defaults) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-backup-config-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'config.yaml');
    if (config) fs.writeFileSync(file, yaml.stringify(config));
    const warnings = [];
    t.mock.method(console, 'warn', message => warnings.push(String(message)));
    t.mock.method(console, 'log', () => {});
    for (const key of retiredKeys.map(keyToEnv)) {
        const previous = process.env[key];
        delete process.env[key];
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    return { file, warnings, read: () => yaml.parse(fs.readFileSync(file, 'utf8')) };
}

test('obsolete backup limits are retained and warned about, not silently migrated', t => {
    const config = structuredClone(defaults);
    config.maxTotalChatBackups = -1;
    config.backups.chat.maxTotalBackups = 7;
    config.backups.chat.retention = { maxPerSession: 8, maxAgeDays: 14, maxBytes: 104857600 };
    config.backups.chat.enabled = false;
    const f = fixture(t, config);
    const original = fs.readFileSync(f.file, 'utf8');
    addMissingConfigValues(f.file);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    assert.deepEqual(f.read(), config);
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /maxTotalChatBackups/);
    assert.match(f.warnings[0], /backups\.chat\.maxTotalBackups/);
    assert.match(f.warnings[0], /ignored/);
    assert.match(f.warnings[0], /backups\.chat\.retention/);
});

test('old total count does not create an unused migrated key or change new defaults', t => {
    const config = structuredClone(defaults);
    config.maxTotalChatBackups = 0;
    delete config.backups.chat.retention;
    const f = fixture(t, config);
    addMissingConfigValues(f.file);
    assert.equal(f.read().maxTotalChatBackups, 0);
    assert.equal(Object.hasOwn(f.read().backups.chat, 'maxTotalBackups'), false);
    assert.deepEqual(f.read().backups.chat.retention, defaults.backups.chat.retention);
    assert.equal(f.warnings.length, 1);
});

test('obsolete environment limits warn even on first install without being redirected', t => {
    const f = fixture(t, null);
    const oldKey = keyToEnv(retiredKeys[0]), nestedKey = keyToEnv(retiredKeys[1]);
    process.env[oldKey] = '-1';
    addMissingConfigValues(f.file);
    assert.equal(process.env[oldKey], '-1');
    assert.equal(process.env[nestedKey], undefined);
    assert.deepEqual(f.read(), defaults);
    assert.ok(f.warnings.some(message => message.includes('ignored') && message.includes(oldKey)));
    f.warnings.length = 0;
    delete process.env[oldKey];
    process.env[nestedKey] = '0';
    addMissingConfigValues(f.file);
    assert.equal(process.env[nestedKey], '0');
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], new RegExp(nestedKey));
});

test('current configuration remains silent and byte-identical across repeated initialization', t => {
    const f = fixture(t);
    const original = fs.readFileSync(f.file, 'utf8');
    addMissingConfigValues(f.file);
    addMissingConfigValues(f.file);
    assert.deepEqual(f.warnings, []);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
});

test('supported backup switches, settings retention and throttle still migrate normally', t => {
    const config = structuredClone(defaults);
    config.disableChatBackup = true;
    config.numberOfBackups = 12;
    config.chatBackupThrottleInterval = 2000;
    const f = fixture(t, config);
    addMissingConfigValues(f.file);
    const saved = f.read();
    assert.equal(saved.backups.chat.enabled, false);
    assert.equal(saved.backups.common.numberOfBackups, 12);
    assert.equal(saved.backups.chat.throttleInterval, 2000);
    assert.deepEqual(saved.backups.chat.retention, defaults.backups.chat.retention);
    for (const key of ['disableChatBackup', 'numberOfBackups', 'chatBackupThrottleInterval']) {
        assert.equal(Object.hasOwn(saved, key), false);
    }
    assert.deepEqual(f.warnings, []);
});
