# Shark

Shark is a production-oriented autonomous founder and operator that runs continuously inside Daytona. It uses Claude Agent SDK as the control brain, chooses from a toolset at runtime, and keeps building and operating an AI-native startup with long-term memory, durable state, and human steering through Slack plus a web UI.

## Core principles

- All execution happens inside Daytona in production. No local control plane is required.
- Claude Agent SDK is the single decision-maker. Tools remain loosely coupled and selectable at runtime.
- The system is autonomous by default, but it must notify the operator of important milestones and accept interrupts immediately.
- The agent can deploy and post publicly without approval, but it cannot spend money or create paid commitments without an explicit operator approval.
- Startup selection happens after market research. Once a startup is chosen, Shark commits to it and iterates instead of thrashing across ideas.

## Planned stack

- Brain: Anthropic Claude via Claude Agent SDK
- Long-term memory: Supermemory
- Realtime state and operator control: Convex
- Browser execution and research: Browser Use
- Authenticated inbox and outbound mail: AgentMail
- Sandboxed execution: Daytona
- Deployment: Vercel
- Operator messaging: Slack
- Operator UI: Vercel-hosted web app backed by Convex

## Repo layout

- `ARCHITECTURE.md`: production system contract and runtime design
- `IMPLEMENTATION_PLAN.md`: staged build plan
- `PROMPT_plan.md`: planning-mode prompt for Ralph-style iterations
- `PROMPT_build.md`: implementation-mode prompt for Ralph-style iterations
- `PROMPT_operate.md`: operations-mode prompt for post-launch iteration
- `AGENTS.md`: repo-specific execution rules and validation commands
- `src/`: TypeScript contracts and loop scaffolding

## Current status

This repository now defines the production contract and a typed scaffold for the orchestrator state machine. It does not yet include live API integrations, deployment wiring, or a UI implementation. Those are the next implementation phases in `IMPLEMENTATION_PLAN.md`.
