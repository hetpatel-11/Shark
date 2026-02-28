# Shark Implementation Plan

## Phase 1: foundation

- Create the TypeScript workspace for the orchestrator, shared contracts, and future UI.
- Define the run state machine for discovery, planning, building, operating, and blocked states.
- Implement typed adapters for Anthropic, Daytona, Supermemory, Convex, Browser Use, AgentMail, Slack, and Vercel.
- Define environment variable contracts and startup validation.

## Phase 2: durable runtime

- Implement the long-running loop worker that can resume after failure.
- Persist runs, iterations, tasks, events, approvals, and operator commands in Convex.
- Add Supermemory persistence and retrieval for semantic memory snapshots.
- Implement Slack notifications and operator interrupt ingestion.

## Phase 3: startup discovery

- Implement market research workflows using Browser Use.
- Add opportunity scoring and startup selection logic.
- Persist a venture thesis and lock the selected startup direction.
- Add an operator summary of the chosen startup and why it was selected.

## Phase 4: building and deployment

- Implement plan generation and task execution flows.
- Add code generation and command execution through Daytona.
- Add deployment flows for generated products on Vercel.
- Add artifact tracking for preview links and production deployments.

## Phase 5: operating mode

- Add marketing and content workflows for X and LinkedIn.
- Add outbound communication workflows through AgentMail.
- Add KPI tracking, incident detection, and retry logic.
- Add public-action logging and Slack summaries.

## Phase 6: operator UI

- Build the Vercel-hosted control dashboard.
- Mirror Slack-visible state in the UI.
- Add live run feed, current task, approvals, and interrupt controls.
- Add drill-down views for events, artifacts, and memory references.

## Phase 7: hardening

- Add crash recovery and idempotent retries.
- Add policy enforcement for blocked financial actions.
- Add smoke tests for core tool adapters.
- Add tracing, alerting, and operational dashboards.
