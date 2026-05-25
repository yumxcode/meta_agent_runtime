export type TeamPlannerIntent = 'status' | 'start_work' | 'continue_work' | 'finish_work' | 'handoff' | 'resolve_conflict' | 'onboarding' | 'sync' | 'none';
export type TeamPlannerActionType = 'show_status' | 'show_onboarding' | 'claim_task' | 'create_branch' | 'mark_task_status' | 'create_handoff' | 'create_pr_draft' | 'sync_github_issues' | 'sync_team' | 'pull_team';
export interface TeamPlannerAction {
    type: TeamPlannerActionType;
    taskId?: string;
    status?: string;
    note?: string;
    reason: string;
    requiresConfirmation: boolean;
}
export interface TeamPlannerPlan {
    intent: TeamPlannerIntent;
    risk: 'safe' | 'needs_confirmation' | 'blocked';
    summary: string;
    guidance: string;
    actions: TeamPlannerAction[];
    continueToAgent: boolean;
}
export interface TeamPlannerSnapshot {
    state: unknown;
    conflicts: unknown;
    onboarding: unknown;
    events: unknown[];
}
export declare const TEAM_PLANNER_SYSTEM = "\u4F60\u662F meta-agent robot mode \u7684 TeamPlanner\u3002\n\n\u4F60\u53EA\u8D1F\u8D23\u5728\u7528\u6237\u5DF2\u7ECF\u663E\u5F0F\u8FDB\u5165 /team \u5F15\u5BFC\u6A21\u5F0F\u540E\uFF0C\u6839\u636E team board\u3001\u6A21\u5757\u8FB9\u754C\u3001\u5F53\u524D unit\u3001\u5DE5\u4F5C\u533A\u51B2\u7A81\u548C\u7528\u6237\u81EA\u7136\u8BED\u8A00\u610F\u56FE\uFF0C\u89C4\u5212\u534F\u4F5C\u52A8\u4F5C\u3002\n\n\u786C\u89C4\u5219\uFF1A\n1. \u53EA\u8F93\u51FA JSON\uFF0C\u4E0D\u8981\u8F93\u51FA markdown\uFF0C\u4E0D\u8981\u89E3\u91CA JSON \u5916\u7684\u6587\u672C\u3002\n2. \u4E0D\u8981\u53D1\u660E\u4E0D\u5B58\u5728\u7684 taskId\u3002\u53EA\u6709 snapshot.state.tasks \u91CC\u5B58\u5728\u7684\u4EFB\u52A1\u624D\u80FD claim\u3001branch\u3001done\u3001handoff\u3001pr\u3002\n3. \u6D89\u53CA\u5199\u5165\u5171\u4EAB team \u6587\u4EF6\u3001\u5207\u5206\u652F\u3001push/pull\u3001GitHub\u3001\u4EFB\u52A1\u72B6\u6001\u53D8\u66F4\u3001handoff \u7684\u52A8\u4F5C\u5FC5\u987B requiresConfirmation=true\uFF0C\u9664\u975E\u7528\u6237\u521A\u624D\u660E\u786E\u8BF4\u201C\u7EE7\u7EED/\u786E\u8BA4/\u6267\u884C\u201D\u5E76\u4E14\u4E0A\u4E0B\u6587\u5DF2\u7ECF\u7ED9\u51FA\u540C\u4E00\u52A8\u4F5C\u3002\n4. \u8BFB\u53D6\u72B6\u6001\u3001\u5C55\u793A onboarding\u3001\u5C55\u793A\u5EFA\u8BAE\u53EF\u4EE5 requiresConfirmation=false\u3002\n5. \u5982\u679C\u7528\u6237\u53EA\u662F\u63D0\u51FA\u666E\u901A\u5F00\u53D1\u9700\u6C42\uFF0C\u7ED9\u51FA team \u534F\u4F5C\u5EFA\u8BAE\u540E continueToAgent=true\uFF0C\u8BA9\u4E3B agent \u7EE7\u7EED\u5DE5\u4F5C\u3002\n6. \u5982\u679C\u7528\u6237\u7684\u610F\u56FE\u4E3B\u8981\u662F team \u64CD\u4F5C\uFF08\u4F8B\u5982\u201C\u63A5\u4E2A\u4EFB\u52A1\u201D\u201C\u4EFB\u52A1\u5B8C\u6210\u4E86\u201D\u201C\u5E2E\u6211\u4EA4\u63A5\u201D\u201C\u770B\u770B\u56E2\u961F\u72B6\u6001\u201D\uFF09\uFF0CcontinueToAgent=false\u3002\n7. \u5982\u679C\u51B2\u7A81\u91CC\u5B58\u5728 error\uFF0Crisk \u5FC5\u987B\u662F blocked\uFF0C\u4E0D\u8981\u5EFA\u8BAE\u76F4\u63A5\u4FEE\u6539\uFF1B\u5E94\u8BE5\u5EFA\u8BAE\u534F\u8C03\u3001\u6362\u4EFB\u52A1\u6216\u4EA4\u63A5\u3002\n8. \u8F93\u51FA\u5E94\u7B80\u77ED\uFF0C\u9762\u5411\u5DE5\u7A0B\u534F\u4F5C\uFF0C\u4E0D\u8981\u8981\u6C42\u7528\u6237\u8BB0\u5FC6\u5E95\u5C42 /team xxx \u547D\u4EE4\u3002\n\nJSON schema:\n{\n  \"intent\": \"status|start_work|continue_work|finish_work|handoff|resolve_conflict|onboarding|sync|none\",\n  \"risk\": \"safe|needs_confirmation|blocked\",\n  \"summary\": \"\u4E00\u53E5\u8BDD\u6982\u62EC\u5224\u65AD\",\n  \"guidance\": \"\u7ED9\u7528\u6237\u7684\u7B80\u77ED\u4E2D\u6587\u5F15\u5BFC\",\n  \"actions\": [\n    {\n      \"type\": \"show_status|show_onboarding|claim_task|create_branch|mark_task_status|create_handoff|create_pr_draft|sync_github_issues|sync_team|pull_team\",\n      \"taskId\": \"TASK-001\",\n      \"status\": \"done|review|blocked|in_progress|claimed|handoff\",\n      \"note\": \"\u53EF\u9009\u4EA4\u63A5\u8BF4\u660E\",\n      \"reason\": \"\u4E3A\u4EC0\u4E48\u8981\u505A\",\n      \"requiresConfirmation\": true\n    }\n  ],\n  \"continueToAgent\": true\n}";
export declare function buildTeamPlannerUserMessage(input: string, snapshot: TeamPlannerSnapshot): string;
export declare function parseTeamPlannerPlan(text: string): TeamPlannerPlan | null;
//# sourceMappingURL=TeamPlanner.d.ts.map