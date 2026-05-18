Schedule a recurring task using a cron expression.

The task will run in-process on the given schedule for the lifetime of this session.
Returns a unique job ID that can be used with `cron_delete` to cancel the job.

Cron expression format: `second minute hour day month weekday`  
Standard 6-field format (e.g. `0 */5 * * * *` = every 5 minutes).  
Use `cron_list` to inspect all scheduled jobs.
