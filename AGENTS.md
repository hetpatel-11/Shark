# Shark Agent Instructions

This repository is built for long-running autonomous operation. Keep the control loop simple and deterministic.

## Default operating rules

- Run inside Daytona only.
- Treat Claude Agent SDK as the top-level decision-maker.
- Do not spend money or create paid commitments without explicit operator approval.
- Deployments and public posts are allowed, but always notify Slack and append a structured event.
- Prefer updating durable state over relying on long prompt history.
- When blocked, record the blocker in Convex, notify Slack, and continue with any non-blocked work.

## Ralph loop rules

- Use one clear task per build iteration.
- Re-read the implementation plan each iteration.
- Do not assume something is missing until you inspect the relevant code or records.
- Use planning mode to rewrite plans only. No implementation in planning mode.
- Use operating mode for post-launch work such as monitoring, outreach, and content.

## Validation backpressure

These commands should become the standard acceptance gates as implementation lands:

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run smoke`

If a command is not implemented yet, add the missing task to `IMPLEMENTATION_PLAN.md` instead of silently skipping validation forever.
