import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
function declaration(name, next) {
    return source.slice(source.indexOf(`export async function ${name}`), source.indexOf(next, source.indexOf(`export async function ${name}`))).replace('export ', '');
}
function fixture(product = true) {
    const scope = {
        characters: [{ avatar: 'owned.png', name: 'World', chat: 'nora-session' }],
        this_chid: 0,
        isNoraProductMode: () => product,
        getRequestHeaders: () => ({}), DOMPurify: { sanitize: x => x },
        humanizedDateTime: () => 'fallback', printCharacters: async () => {},
        console, toastr: { error: () => assert.fail('unexpected missing card') },
    };
    scope.setCharacterId = id => { scope.this_chid = id; };
    scope.fetch = async url => ({ ok: true, json: async () => url.endsWith('/all')
        ? [{ avatar: 'other.png', name: 'Other' }, { avatar: 'owned.png', name: 'Updated', shallow: true }]
        : { avatar: 'owned.png', name: 'Updated', chat: 'legacy-card-chat' } });
    vm.createContext(scope);
    vm.runInContext(declaration('getOneCharacter', 'export function getCharacterSource') + '\n' + declaration('getCharacters', 'async function delChat'), scope);
    scope.selectCharacterById = async id => scope.getOneCharacter(scope.characters[id].avatar);
    return scope;
}

test('Nora library refresh and subsequent full-card refresh preserve the active session', async () => {
    const scope = fixture();
    await scope.getCharacters();
    assert.equal(scope.this_chid, 1);
    assert.equal(scope.characters[1].chat, 'nora-session');
    assert.equal(scope.characters[1].name, 'Updated');
    assert.equal(scope.characters[0].chat, 'Other - fallback');
});

test('single-card refresh preserves only the active Nora binding', async () => {
    const scope = fixture();
    await scope.getOneCharacter('owned.png');
    assert.equal(scope.characters[0].chat, 'nora-session');
    scope.this_chid = undefined;
    await scope.getOneCharacter('owned.png');
    assert.equal(scope.characters[0].chat, 'legacy-card-chat');
});

test('legacy ST card refresh continues accepting the persisted chat selection', async () => {
    const scope = fixture(false);
    await scope.getOneCharacter('owned.png');
    assert.equal(scope.characters[0].chat, 'legacy-card-chat');
});
