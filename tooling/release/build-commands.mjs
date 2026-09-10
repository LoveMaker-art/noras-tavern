import path from 'node:path';

export function buildCommand(command, args, { platform = process.platform, executable = process.execPath,
    systemRoot = process.env.SystemRoot } = {}) {
    if (platform !== 'win32') return { command, args };
    const windows = path.win32;
    const tar = () => {
        if (!systemRoot) throw new Error('Windows SystemRoot is required for native archive tools.');
        return windows.join(systemRoot, 'System32', 'tar.exe');
    };
    if (command === 'tar') return { command: tar(), args };
    if (command === 'npm') return { command: executable,
        args: [windows.join(windows.dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args] };
    if (command === 'zip') {
        if (args[0] !== '-qry') throw new Error('Unsupported launcher archive options.');
        return { command: tar(), args: ['-a', '-cf', ...args.slice(1)] };
    }
    return { command, args };
}
