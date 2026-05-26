import { describe, expect, it } from 'vitest';
import { DEFAULT_WEB_SEARCH_MODEL } from '../web_search/index.js';
describe('web_search defaults', () => {
    it('uses an Anthropic model by default for Anthropic web-search API calls', () => {
        expect(DEFAULT_WEB_SEARCH_MODEL).toMatch(/^claude-/);
    });
});
//# sourceMappingURL=WebSearch.test.js.map