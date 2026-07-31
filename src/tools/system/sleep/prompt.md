Pause the current process for a short, in-process delay.

Usage:
- duration_ms: milliseconds to sleep (max 60000 = 1 minute)
- Use sparingly for short local backoff only; do not repeatedly poll long-running external work
- Do not use sleep to wait for remote training expected to take longer than 1 hour; in plain Auto mode, use self_timer so the session is durably parked and resumed
