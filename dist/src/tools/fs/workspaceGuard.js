import { existsSync, realpathSync } from 'fs';
import { dirname, isAbsolute, resolve, sep } from 'path';
function findExistingAncestor(path) {
    let current = path;
    while (!existsSync(current)) {
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return current;
}
function resolvePathForGuard(path, workspaceRoot) {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
    if (existsSync(absolute))
        return realpathSync(absolute);
    const ancestor = findExistingAncestor(absolute);
    const realAncestor = existsSync(ancestor) ? realpathSync(ancestor) : resolve(ancestor);
    return resolve(realAncestor, absolute.slice(ancestor.length));
}
export function assertInsideWorkspace(path, workspaceRoot = process.cwd()) {
    const workspace = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot);
    const target = resolvePathForGuard(path, workspace);
    const inside = target === workspace || target.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep);
    return inside ? null : `Error: path is outside workspace: ${path}`;
}
//# sourceMappingURL=workspaceGuard.js.map