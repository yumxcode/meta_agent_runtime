export { createBashTool } from './bash/index.js';
export { createPowerShellTool } from './powershell/index.js';
import { createBashTool } from './bash/index.js';
import { createPowerShellTool } from './powershell/index.js';
export async function createShellTools() {
    return Promise.all([createBashTool(), createPowerShellTool()]);
}
//# sourceMappingURL=index.js.map