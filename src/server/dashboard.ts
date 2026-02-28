import type { DashboardSnapshot, ProviderHealth } from "../contracts.js";

export function renderDashboard(snapshot: DashboardSnapshot): string {
  const providerRows = Object.entries(snapshot.providerHealth)
    .map(([name, health]) => renderProviderRow(name, health))
    .join("");

  const taskRows = snapshot.pendingTasks
    .map(
      (task) => `
        <tr>
          <td>${escapeHtml(task.title)}</td>
          <td>${task.priority}</td>
          <td>${escapeHtml(task.kind)}</td>
          <td>${escapeHtml(task.status)}</td>
        </tr>`,
    )
    .join("");

  const eventRows = snapshot.recentEvents
    .slice(0, 12)
    .map(
      (event) => `
        <li><strong>${escapeHtml(event.kind)}</strong> ${escapeHtml(event.message)}<br><small>${escapeHtml(event.timestamp)}</small></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shark Control Plane</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f7fb;
      --ink: #112033;
      --muted: #5b6b7f;
      --card: #ffffff;
      --line: #d7e1ec;
      --accent: #0e7490;
      --accent-2: #0f172a;
      --good: #0f766e;
      --bad: #b91c1c;
    }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
      background:
        radial-gradient(circle at top right, rgba(14, 116, 144, 0.14), transparent 32%),
        linear-gradient(180deg, #eef5ff 0%, var(--bg) 40%, #edf6f3 100%);
      color: var(--ink);
    }
    main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px;
    }
    .hero, .card {
      background: rgba(255, 255, 255, 0.92);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 20px;
      box-shadow: 0 12px 40px rgba(17, 32, 51, 0.08);
      backdrop-filter: blur(12px);
    }
    .hero {
      display: grid;
      gap: 16px;
      margin-bottom: 18px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 18px;
    }
    h1, h2 {
      margin: 0 0 8px;
    }
    p {
      margin: 0;
      color: var(--muted);
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      background: var(--accent-2);
      color: white;
      cursor: pointer;
      font: inherit;
    }
    button.alt {
      background: var(--accent);
    }
    input {
      width: min(420px, 100%);
      padding: 12px;
      border-radius: 12px;
      border: 1px solid var(--line);
      font: inherit;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      text-align: left;
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
      font-size: 14px;
    }
    ul {
      margin: 0;
      padding-left: 18px;
    }
    li {
      margin-bottom: 10px;
    }
    .pill {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: rgba(15, 118, 110, 0.12);
      color: var(--good);
    }
    .pill.bad {
      background: rgba(185, 28, 28, 0.12);
      color: var(--bad);
    }
    .meta {
      display: grid;
      gap: 4px;
      font-size: 14px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <h1>Shark Control Plane</h1>
        <p>Continuous founder loop with operator interrupts, persistent state, and live provider visibility.</p>
      </div>
      <div class="meta">
        <div>Run ID: ${escapeHtml(snapshot.runId)}</div>
        <div>Mode: ${escapeHtml(snapshot.mode)}</div>
        <div>Loop: ${snapshot.isRunning ? "running" : "idle"}</div>
        <div>Storage: ${escapeHtml(snapshot.storage)}</div>
        <div>Last summary: ${escapeHtml(snapshot.lastSummary ?? "No iterations yet")}</div>
      </div>
      <div class="controls">
        <button onclick="post('/api/start')">Start Loop</button>
        <button class="alt" onclick="post('/api/run-once')">Run Once</button>
        <button onclick="post('/api/stop')">Stop Loop</button>
      </div>
      <div class="controls">
        <input id="command" placeholder="Interrupt Shark: e.g. focus on B2B pricing page" />
        <button class="alt" onclick="sendCommand()">Send Command</button>
      </div>
    </section>

    <section class="grid">
      <article class="card">
        <h2>Startup Thesis</h2>
        <p>${escapeHtml(snapshot.thesis?.headline ?? "Not selected yet")}</p>
        <div class="meta" style="margin-top: 12px;">
          <div>Customer: ${escapeHtml(snapshot.thesis?.targetCustomer ?? "n/a")}</div>
          <div>Mailbox: ${escapeHtml(snapshot.mailboxAddress ?? "n/a")}</div>
          <div>Approval: ${escapeHtml(snapshot.pendingApproval?.reason ?? "none")}</div>
        </div>
      </article>

      <article class="card">
        <h2>Provider Health</h2>
        <table>
          <thead>
            <tr><th>Provider</th><th>Status</th><th>Message</th></tr>
          </thead>
          <tbody>${providerRows}</tbody>
        </table>
      </article>

      <article class="card">
        <h2>Pending Tasks</h2>
        <table>
          <thead>
            <tr><th>Task</th><th>Priority</th><th>Kind</th><th>Status</th></tr>
          </thead>
          <tbody>${taskRows || '<tr><td colspan="4">No pending tasks</td></tr>'}</tbody>
        </table>
      </article>

      <article class="card">
        <h2>Recent Events</h2>
        <ul>${eventRows || "<li>No events yet</li>"}</ul>
      </article>
    </section>
  </main>
  <script>
    async function post(path, body) {
      await fetch(path, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: body ? JSON.stringify(body) : '{}'
      });
      location.reload();
    }

    async function sendCommand() {
      const input = document.getElementById('command');
      const text = input.value.trim();
      if (!text) return;
      await post('/api/command', { text });
      input.value = '';
    }
  </script>
</body>
</html>`;
}

function renderProviderRow(name: string, health?: ProviderHealth): string {
  if (!health) {
    return `<tr><td>${escapeHtml(name)}</td><td><span class="pill bad">unknown</span></td><td>Not checked yet</td></tr>`;
  }

  return `
    <tr>
      <td>${escapeHtml(name)}</td>
      <td><span class="pill ${health.ok ? "" : "bad"}">${health.ok ? "ready" : "missing"}</span></td>
      <td>${escapeHtml(health.message)}</td>
    </tr>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
