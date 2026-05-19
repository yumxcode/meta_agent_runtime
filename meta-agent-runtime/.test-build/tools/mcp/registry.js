export const mcpClients = new Map();
export function registerMcpClient(serverName, client) {
    mcpClients.set(serverName, client);
}
export function unregisterMcpClient(serverName) {
    mcpClients.delete(serverName);
}
export function getRegisteredMcpServers() {
    return [...mcpClients.keys()];
}
//# sourceMappingURL=registry.js.map