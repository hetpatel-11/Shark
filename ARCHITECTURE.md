# Shark Architecture

## Product definition

Shark is a 24/7 autonomous founder and startup operator. It runs entirely inside Daytona, performs market research to identify a venture-scale AI startup, commits to the selected opportunity, and then continuously builds, launches, operates, markets, and iterates that company.

The system is not a chatbot. It is a persistent agent runtime with durable memory, structured state, operator observability, and interruption support.

## Non-negotiable constraints

- Runtime location: all execution happens in Daytona in production
- Primary model runtime: Anthropic via Claude Agent SDK
- Public actions: autonomous, but always notify the operator in Slack
- Spending money: blocked until the operator explicitly approves a requested action
- Human steering: available at any time through Slack
- Startup strategy: perform market research first, then commit to a chosen AI startup and keep iterating on it

## Core system components

### 1. Agent brain

Claude Agent SDK is the orchestration core. It owns task selection, tool choice, and loop continuation. The top-level agent must decide which tool to use instead of routing through hard-coded orchestration trees.

Responsibilities:

- maintain the top-level objective
- choose between planning, building, and operating modes
- request tools dynamically based on current state
- summarize decisions and push durable state updates
- escalate only for blocked critical actions such as spending money

### 2. Execution runtime

Daytona is the only production execution environment.

Responsibilities:

- host the long-running control loop
- execute code generation, dependency installs, tests, and build commands
- run background workers and tool adapters
- maintain a sandbox boundary for autonomous actions
- host temporary workspaces for generated products and internal services

### 3. Long-term memory

Supermemory stores durable semantic memory and retrieval context for the founder agent.

Responsibilities:

- persist market research
- retain architectural decisions
- track product decisions and positioning
- preserve prior experiments, wins, and failures
- support retrieval of relevant context each iteration without replaying full history

Boundary:

- Supermemory is for semantic and long-horizon memory
- Convex is for transactional state, queues, logs, and operator-visible system state

### 4. State and control plane

Convex is the realtime operational database.

Responsibilities:

- run metadata and lifecycle state
- task queue and task ownership
- event logs and structured tool traces
- Slack message mirror and interrupt queue
- operator commands and acknowledgements

### 5. Browser execution

Browser Use is the general-purpose web interaction layer.

Responsibilities:

- market research and web navigation
- product analysis
- signup and workflow automation
- authenticated web actions when paired with AgentMail
- content publishing and operational tasks across third-party web products

Constraint:

Tool access remains broad. Claude decides when Browser Use is appropriate rather than a narrow policy layer constraining it to a single use case.

### 6. Inbox and outbound communications

AgentMail provides authenticated inbox and outbound communications for the agent.

Responsibilities:

- receive workflow-triggering mail
- support outbound outreach such as investor or customer contact
- support authenticated workflows that require inbox-based verification
- provide a durable communication surface the agent can use without involving the operator directly

### 7. Operator surfaces

Slack is the primary interrupt and notification interface.

Slack responsibilities:

- milestone updates
- public posting notifications
- deployment notifications
- warnings and escalations
- operator interrupt commands

### 8. Deployment

Vercel is used for:

- deploying products that Shark builds
- deploying Shark’s operator UI

Deployment is autonomous and does not require approval, but the operator must be notified in Slack.

## Runtime loop design

Shark uses a Ralph-inspired outer loop, but with an explicit production operations mode.

### Mode A: DISCOVERY

Goal: identify the most promising AI-native startup to build.

Loop behavior:

- perform market and competitor research
- synthesize opportunity areas
- score opportunities against market size, execution feasibility, and differentiation
- choose one startup direction
- persist the thesis and commit to it

Output artifacts:

- `docs/venture-thesis.md` (planned)
- memory entries in Supermemory
- Convex records for research findings and the selected startup thesis

### Mode B: PLANNING

Goal: update the implementation and operating plan from current reality.

Loop behavior:

- compare goals, current code, current product state, and telemetry
- rewrite the plan into the next prioritized queue of work
- do not implement changes in this mode

### Mode C: BUILDING

Goal: implement one high-value task from the current plan.

Loop behavior:

- select the highest-value task
- inspect the relevant code and product state
- implement the task
- validate using tests, builds, and smoke checks
- update plan and state
- deploy if needed
- notify the operator

### Mode D: OPERATING

Goal: run the startup after launch and keep compounding progress.

Loop behavior:

- monitor metrics, errors, and user feedback
- post updates and marketing content
- perform outreach
- refine the product and backlog
- push back into planning or building when product work is needed

## Safety model

Autonomy is broad, but not unlimited.

Allowed without approval:

- writing and modifying code
- deploying code
- public posting
- product changes
- sending operational Slack updates
- sending low-risk outbound communications

Requires approval:

- spending money
- any action that creates a paid commitment
- actions that would transfer funds or create direct financial liability

Enforcement design:

- tool adapters must expose a `riskLevel`
- critical actions generate a pending approval event in Convex
- Slack and the UI show the approval request
- the Claude loop pauses that action but continues non-blocked work when possible

## Control-plane data model

Primary entities:

- `runs`: long-lived autonomous runs
- `iterations`: one loop pass by a mode
- `tasks`: prioritized units of work
- `events`: append-only timeline of decisions and tool activity
- `approvals`: blocked critical actions awaiting operator approval
- `operatorCommands`: interruptions and steering directives
- `artifacts`: generated code, documents, posts, and deployment links
- `memoryRefs`: links between Convex state and Supermemory items

## Integration boundaries

The first implementation should keep each external system behind a thin adapter:

- `AnthropicClient`
- `DaytonaExecutor`
- `SupermemoryStore`
- `ConvexStore`
- `BrowserUseAdapter`
- `AgentMailAdapter`
- `SlackAdapter`
- `VercelAdapter`

This keeps the agent loop stable while integrations evolve independently.

## Deployment topology

### Inside Daytona

- main Shark loop worker
- tool adapters
- scheduled jobs and monitors
- generated startup codebases

### On Vercel

- Shark operator UI
- startup apps built by Shark

### In external managed services

- Anthropic API
- Supermemory
- Convex
- Slack
- AgentMail

## What “end to end” means for this repo

For this repository, “end to end” should mean:

- a deterministic long-running loop
- durable state
- durable memory
- operator interrupts
- typed integration boundaries
- explicit safety gates
- automated deployment paths

It should not rely on manually shepherding the agent turn by turn.
