/**
 * TeamPlanner (v2.0) — turns user intent into a structured plan over the
 * minimal team-mode action set.  Output is strict JSON; the CLI executor
 * dispatches each action with confirmation when requested.
 */
export type TeamPlannerIntent = 'status' | 'start_work' | 'continue_work' | 'finish_work' | 'record_attempt' | 'release' | 'steal' | 'sync' | 'none';
export type TeamPlannerActionType = 'show_board' | 'take_task' | 'add_note' | 'drop_task' | 'mark_done' | 'mark_paused' | 'steal_task' | 'sync_team' | 'pull_team';
export interface TeamPlannerAction {
    type: TeamPlannerActionType;
    taskId?: string;
    /** For add_note. */
    direction?: string;
    /** For add_note. */
    outcome?: string;
    /** For add_note (optional). */
    ref?: string;
    /** For steal_task (optional human-readable reason). */
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
    recentAttempts: unknown[];
    events: unknown[];
}
export declare const TEAM_PLANNER_SYSTEM = "\u4F60\u662F meta-agent robot mode \u7684 TeamPlanner\uFF08v2.0 \u534F\u4F5C\u65E5\u5FD7\u6A21\u578B\uFF09\u3002\n\n\u6A21\u578B\u53EA\u6709\u4E09\u7C7B\u5BF9\u8C61\uFF1Aunit / task / attempt\u3002task \u6709 owner\uFF08\u6392\u4ED6\uFF09\uFF0Cattempts[] \u662F append-only \u7684\u65B9\u5411+\u7ED3\u679C\u8BB0\u5F55\u3002\n\n\u4F60\u7684\u5DE5\u4F5C\uFF1A\u5728\u7528\u6237\u8FDB\u5165 /team \u6216\u81EA\u7136\u63CF\u8FF0\u534F\u4F5C\u610F\u56FE\u65F6\uFF0C\u7ED9\u51FA\u4E00\u6BB5\u7B80\u77ED\u4E2D\u6587\u5EFA\u8BAE\uFF0C\u5E76\u9644 0 \u5230 N \u4E2A\u673A\u5668\u53EF\u6267\u884C\u52A8\u4F5C\u3002\n\n\u786C\u89C4\u5219\uFF1A\n1. \u53EA\u8F93\u51FA JSON\uFF0C\u4E0D\u8981 markdown\u3001\u4E0D\u8981 JSON \u5916\u6587\u672C\u3002\n2. \u4E0D\u8981\u53D1\u660E\u4E0D\u5B58\u5728\u7684 taskId\u3002\n3. \u4EFB\u4F55\u4F1A\u4FEE\u6539 team.json \u7684\u52A8\u4F5C\uFF08take_task/add_note/drop_task/mark_done/mark_paused/steal_task/sync_team/pull_team\uFF09\u9ED8\u8BA4 requiresConfirmation=true\u3002\u4EC5 show_board \u53EF false\u3002\n4. steal_task \u53EA\u6709\u5728 task.ownerUnit \u662F\u4ED6\u4EBA\u65F6\u624D\u5141\u8BB8\u3002reason \u5FC5\u586B\u3002\n5. add_note \u5FC5\u987B\u6307\u5B9A taskId\u3001direction\u3001outcome\uFF1Bref \u53EF\u9009\u3002\u53EA\u5BF9\u81EA\u5DF1\u6301\u6709\u7684 task \u63D0\u8BAE note\u3002\n6. \u82E5\u7528\u6237\u610F\u56FE\u662F\u666E\u901A\u5F00\u53D1\u63A8\u8FDB\u800C\u4E0D\u662F team \u534F\u4F5C\uFF0CcontinueToAgent=true\u3001actions=[]\uFF0C\u8BA9\u4E3B agent \u7EE7\u7EED\u3002\n7. \u82E5\u7528\u6237\u610F\u56FE\u662F team \u534F\u4F5C\uFF08\u770B board\u3001\u9886\u3001\u8BB0\u5F55\u3001\u91CA\u653E\u3001\u5B8C\u6210\uFF09\uFF0CcontinueToAgent=false\u3002\n8. \u7B80\u77ED\uFF0C\u9762\u5411\u5DE5\u7A0B\u534F\u4F5C\u3002\n\nJSON schema:\n{\n  \"intent\": \"status|start_work|continue_work|finish_work|record_attempt|release|steal|sync|none\",\n  \"risk\": \"safe|needs_confirmation|blocked\",\n  \"summary\": \"\u4E00\u53E5\u8BDD\u6982\u62EC\u5224\u65AD\",\n  \"guidance\": \"\u7ED9\u7528\u6237\u7684\u7B80\u77ED\u4E2D\u6587\u5F15\u5BFC\",\n  \"actions\": [\n    {\n      \"type\": \"show_board|take_task|add_note|drop_task|mark_done|mark_paused|steal_task|sync_team|pull_team\",\n      \"taskId\": \"TASK-001\",\n      \"direction\": \"\u8BD5\u7528 ResNet50 \u66FF\u6362 backbone\",\n      \"outcome\": \"\u5931\u8D25\uFF1Asim +0.3%\uFF0Creal -2%\",\n      \"ref\": \"wandb.ai/.../run-3f2\",\n      \"reason\": \"\u4E3A\u4EC0\u4E48\u8981\u505A\",\n      \"requiresConfirmation\": true\n    }\n  ],\n  \"continueToAgent\": true\n}";
export declare function buildTeamPlannerUserMessage(input: string, snapshot: TeamPlannerSnapshot): string;
export declare function parseTeamPlannerPlan(text: string): TeamPlannerPlan | null;
//# sourceMappingURL=TeamPlanner.d.ts.map