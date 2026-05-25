/** Default permission gate — always allows all tool calls */
export const defaultCanUseTool = async (_tool, _input, _assistantMessageUuid, _toolUseId, _context) => {
    return { behavior: 'allow' };
};
//# sourceMappingURL=CanUseTool.js.map