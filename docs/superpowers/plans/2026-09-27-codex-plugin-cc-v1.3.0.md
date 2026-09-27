# codex-plugin-cc v1.3.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть класс «job висит в `running` навсегда» и «SessionEnd/teardown сигналит не тот процесс» на posix, дать stop-gate явную модель/усилие, сделать алиасы моделей data-driven и убрать два security-дефекта в state/broker.json.

**Architecture:** Все изменения — в companion-runtime (`plugins/codex/scripts/**`), без новых зависимостей. Терминальность turn'а решается в одном месте (`applyTurnNotification`), идентичность процесса — в одном модуле (`lib/process.mjs`) с одной обёрткой `terminateRecordedProcess`, через которую проходят все kill-сайты. Каталог моделей — новый модуль `lib/model-catalog.mjs`, читающий `$CODEX_HOME/models_cache.json`; хардкод остаётся последним fallback. Windows-ветка identity — v1.4.0.

**Tech Stack:** Node ≥18.18, ESM `.mjs`, `node --test`, fake Codex fixture (`tests/fake-codex-fixture.mjs`), `gh`.

**Spec:** `/Users/g.mehrenin/.claude/plans/glistening-chasing-backus.md` (раздел «v1.3.0» + «Дизайн: process identity»). Upstream-референсы: #698/#710, #757/#763, #775, #781, #773, #774, #753/#762/#782, #768, #749, #743, #769, #548/#565, #589, #483/#573, #459, #721, #468/#703/#485/#128, #521, #609/#631/#683.

## Global Constraints

- Worktree `/Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.3.0`, ветка `release/v1.3.0` от `main` (858188f). `main` остаётся установленным плагином `codex@cbepx` — не редактировать его рабочее дерево.
- Гейт на задачу: `npm test > /tmp/npm-test.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test.log; test "$st" -eq 0` → `fail 0` (239 на базе); `sleep 10; pgrep -f codex-plugin-test- | wc -l` → 0; `npm run build`.
- Никаких `grep` — только `rg`. Никаких `git add -A`. Трейлер коммита: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; для портированных upstream-PR дополнительно `Co-authored-by: <author> <login@users.noreply.github.com>` (авторы — в `docs/superpowers/triage/2026-09-27-upstream-triage.md`, раздел «Authors to credit»). Не пушить без команды пользователя.
- Порт-механика: тест и намерение из upstream PR, реализация против кода форка. `git merge pr/N` не используется.
- Совместимость: записи v1.2.x без `pidIdentity`, bare-integer sidecar `jobs/<id>.pid`, `broker.json` без identity — читаются и работают как раньше на posix.
- Порядок: Task 1–8 независимы и малы; Task 9 (identity) — последней; если не укладывается, релиз v1.3.0 без него, identity → v1.3.1.

## Review Focus

1. `error`-нотификация с `willRetry: true` посреди живого turn'а — turn обязан продолжаться, а не завершаться `failed` (тест в Task 1).
2. `turn/start` без `turn.id` + последующие нотификации с `turnId` — `turn/completed` не должен потеряться в буфере (тест в Task 2).
3. `ensureBrokerSession` при живом, но медленном broker (readiness-probe 150 ms не успел) — broker не убивается без повторной пробы 2 s (тест в Task 4).
4. `status <id> --wait` с истёкшим таймаутом должен быть отличим от успеха и в тексте, и по exit-коду (тест в Task 3).
5. Fallback-каталог state в `os.tmpdir()`, уже созданный другим пользователем/с mode 0755 — использовать нельзя (тест в Task 8).

---

### Task 1: Терминальные ошибки turn'а: `error` (без retry), `errorMessage` при не-бросающем провале, `fileChange` без `changes`

**Files:**
- Modify: `plugins/codex/scripts/lib/codex.mjs` — `applyTurnNotification` (`case "error"`, ~591), `describeStartedItem` (~303)
- Modify: `plugins/codex/scripts/codex-companion.mjs` — сборка результата `task` (~688–697: `errorMessage`, `summary`)
- Modify: `tests/fake-codex-fixture.mjs` — новые `BEHAVIOR`: `error-notification`, `error-notification-retry`, `file-change-no-changes`, `turn-failed-silently`
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: `completeTurn(state, turn)` (идемпотентен по `state.completed`), `emitProgress`, `buildResultStatus` (`finalTurn.status === "completed" ? 0 : 1`).
- Produces: turn с `error.willRetry !== true` завершается `finalTurn = { id, status: "failed", error }`; `result.error.message` заполнен; `task`-результат при `status !== 0` имеет `errorMessage` и `summary`, взятые из ошибки, а не из `rawOutput`.

- [ ] **Step 1: Fixture behaviors.** В `tests/fake-codex-fixture.mjs`, в `case "turn/start":` сразу после `send({ id: message.id, result: { turn: buildTurn(turnId) } });` добавить:

```js
        if (BEHAVIOR === "error-notification" || BEHAVIOR === "error-notification-retry") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "error",
            params: {
              threadId: thread.id,
              turnId,
              willRetry: BEHAVIOR === "error-notification-retry",
              error: { message: "Selected model is at capacity" }
            }
          });
          if (BEHAVIOR === "error-notification-retry") {
            // Codex retried and finished: the earlier error was not terminal.
            emitTurnCompleted(thread.id, turnId, [
              { completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" } }
            ]);
          }
          // error-notification: no turn/completed ever arrives.
          break;
        }
        if (BEHAVIOR === "file-change-no-changes") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({ method: "item/started", params: { threadId: thread.id, turnId, item: { type: "fileChange", id: "fc_" + turnId } } });
          emitTurnCompleted(thread.id, turnId, [
            { completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" } }
          ]);
          break;
        }
        if (BEHAVIOR === "turn-failed-silently") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/completed",
            params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: "{\n  \"error\": \"quota exhausted\"\n}", phase: "final_answer" } }
          });
          send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "failed") } });
          break;
        }
```

(`payload` уже вычислен строкой выше в этом же `case`; `emitTurnCompleted` уже существует в fixture.)

- [ ] **Step 2: Failing tests.** В `tests/runtime.test.mjs` (helpers `makeTempDir`, `installFakeCodex`, `buildEnv`, `run`, `SCRIPT`, `initGitRepo` уже импортированы):

```js
test("task fails fast when Codex sends a terminal error notification (#698)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "error-notification");
  const result = run("node", [SCRIPT, "task", "--json", "do the thing"], {
    cwd: repo,
    env: buildEnv(binDir),
    timeout: 15000
  });
  assert.equal(result.error, undefined, "companion must not hang until the test timeout");
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 1);
  assert.match(result.stderr, /Selected model is at capacity/);
});

test("task keeps running through an error notification that Codex will retry", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "error-notification-retry");
  const result = run("node", [SCRIPT, "task", "--json", "do the thing"], { cwd: repo, env: buildEnv(binDir), timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).rawOutput, /./);
});

test("task survives fileChange started items that omit changes (#775)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "file-change-no-changes");
  const result = run("node", [SCRIPT, "task", "--json", "edit"], { cwd: repo, env: buildEnv(binDir), timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Cannot read properties of undefined/);
});

test("a server-side turn failure that terminates normally still records an errorMessage (#757)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-failed-silently");
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "do the thing"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const done = run("node", [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "15000", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(done.status, 0, done.stderr);
  const status = run("node", [SCRIPT, "status", jobId], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Status: failed/);
  assert.doesNotMatch(status.stdout, /Summary: \{$/m);
  assert.match(status.stdout, /Codex turn ended with status "failed"/);
});
```

- [ ] **Step 3: Run, expect failures.** `node --import ./tests/test-env.mjs --test --test-name-pattern "#698|will retry|#775|#757" tests/runtime.test.mjs` → первый тест падает по таймауту/`result.error`, третий — по `Cannot read properties of undefined`, четвёртый — по `Summary: {`.

- [ ] **Step 4: Implement.** `lib/codex.mjs`:

```js
    case "error": {
      const error = message.params.error ?? { message: "Codex reported an error." };
      state.error = error;
      if (message.params.willRetry === true) {
        emitProgress(state.onProgress, `Codex error (retrying): ${error.message}`, null);
        break;
      }
      emitProgress(state.onProgress, `Codex error: ${error.message}`, "failed");
      // Terminal: no turn/completed follows a non-retried error (#698). completeTurn
      // is idempotent, so a late turn/completed is harmless.
      completeTurn(state, { id: state.turnId ?? "errored-turn", status: "failed", error });
      break;
    }
```

`describeStartedItem`:

```js
    case "fileChange": {
      const count = Array.isArray(item.changes) ? item.changes.length : 0;
      return { message: `Applying ${count} file change(s).`, phase: "editing" };
    }
```

`codex-companion.mjs`, сборка `task`-результата:

```js
  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const turnStatus = result.turnStatus ?? null;
  const failureMessage =
    result.error?.message ??
    (result.status !== 0 ? (result.stderr || `Codex turn ended with status "${turnStatus ?? "failed"}"`) : "");
  ...
    errorMessage: failureMessage || null,
    summary:
      result.status === 0
        ? firstMeaningfulLine(rawOutput, `${taskMetadata.title} finished.`)
        : firstMeaningfulLine(failureMessage, firstMeaningfulLine(rawOutput, `${taskMetadata.title} failed.`)),
```

и в `lib/codex.mjs` там, где `runAppServerTurn` формирует возвращаемый объект (`status: buildResultStatus(turnState)`), добавить `turnStatus: turnState.finalTurn?.status ?? null`.

- [ ] **Step 5: Run tests** → 4 новых PASS; полный гейт.
- [ ] **Step 6: Commit** `fix(runtime): terminal error notifications, errorMessage on silent turn failure, fileChange guard` с `Co-authored-by` авторов #710 (ALV0612), #763 (Soumya95), #775 (kevin9327).

---

### Task 2: `turn/start` без `turn.id` не подвешивает захват (#781)

**Files:**
- Modify: `plugins/codex/scripts/lib/codex.mjs` — `createTurnCaptureState` (`started` флаг), `captureTurn` (~720–760)
- Modify: `tests/fake-codex-fixture.mjs` — `BEHAVIOR` `turn-start-without-id`
- Test: `tests/runtime.test.mjs`

**Interfaces:** буферизация нотификаций гейтится новым `state.started`, а не `state.turnId`; `belongsToTurn` при `trackedTurnId === null` уже принимает любые turnId.

- [ ] **Step 1: Fixture.** В `case "turn/start":` заменить строку `send({ id: message.id, result: { turn: buildTurn(turnId) } });` на:

```js
        send({ id: message.id, result: { turn: BEHAVIOR === "turn-start-without-id" ? { status: "inProgress", items: [] } : buildTurn(turnId) } });
```

- [ ] **Step 2: Failing test.**

```js
test("task completes when the turn/start response carries no turn id (#781)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-start-without-id");
  const result = run("node", [SCRIPT, "task", "--json", "hello"], { cwd: repo, env: buildEnv(binDir), timeout: 15000 });
  assert.equal(result.error, undefined, "must not hang");
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).rawOutput, /./);
});
```

- [ ] **Step 3: Run** → падает по таймауту.
- [ ] **Step 4: Implement.** В `createTurnCaptureState` добавить `started: false,`. В `captureTurn`:

```js
  client.setNotificationHandler((message) => {
    if (!state.started) {
      state.bufferedNotifications.push(message);
      return;
    }
    ...
  });
  try {
    const response = await startRequest();
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    state.started = true;
    for (const message of state.bufferedNotifications) { ... }   // без изменений
```

- [ ] **Step 5: Run** → PASS; гейт.
- [ ] **Step 6: Commit** `fix(runtime): gate turn notification buffering on turn start, not on turn id`.

---

### Task 3: Ограниченные connect'ы к broker (#773) и честный `status --wait` (#774)

**Files:**
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs` — `waitForBrokerEndpoint`
- Modify: `plugins/codex/scripts/lib/app-server.mjs` — `BrokerCodexAppServerClient.initialize`
- Modify: `plugins/codex/scripts/lib/codex.mjs` — `withAppServer` (`shouldRetryDirect`)
- Modify: `plugins/codex/scripts/codex-companion.mjs` — `handleStatus`
- Test: `tests/broker-stale-pid.test.mjs`, `tests/app-server.test.mjs`, `tests/runtime.test.mjs`

**Interfaces:**
- `waitForBrokerEndpoint(endpoint, timeoutMs = 2000, { connectImpl } = {})` — `connectImpl(path)` возвращает socket-like `EventEmitter` с `destroy()`; каждая попытка ограничена `min(500, remaining)` ms.
- `BrokerCodexAppServerClient` принимает `options.connectImpl` и `options.connectTimeoutMs` (default 2000); при истечении — reject `Error` с `code: "ETIMEDOUT"`.
- `status <id> --wait` при таймауте печатает `Timed out after <N>s while the job was still running.` и ставит `process.exitCode = 1`; JSON-снимок с `waitTimedOut`/`timeoutMs` без изменений.

- [ ] **Step 1: Failing tests.** `tests/broker-stale-pid.test.mjs`:

```js
import { EventEmitter } from "node:events";

test("waitForBrokerEndpoint gives up on a socket that never connects or errors (#773)", async () => {
  let destroyed = 0;
  const connectImpl = () => {
    const socket = new EventEmitter();
    socket.destroy = () => { destroyed += 1; socket.emit("close"); };
    socket.end = () => {};
    return socket;
  };
  const started = Date.now();
  const ready = await waitForBrokerEndpoint("unix:/nonexistent/broker.sock", 600, { connectImpl });
  assert.equal(ready, false);
  assert.ok(Date.now() - started < 1500, "must respect the overall timeout");
  assert.ok(destroyed >= 1, "hung probe sockets must be destroyed");
});
```

`tests/app-server.test.mjs` (импортировать `BrokerCodexAppServerClient` — экспортировать класс, если ещё не экспортирован):

```js
test("broker client connect times out with ETIMEDOUT instead of hanging", async () => {
  const connectImpl = () => {
    const socket = new EventEmitter();
    socket.setEncoding = () => {};
    socket.destroy = () => socket.emit("close");
    socket.end = () => {};
    return socket;
  };
  const client = new BrokerCodexAppServerClient(process.cwd(), { brokerEndpoint: "unix:/nonexistent.sock", connectImpl, connectTimeoutMs: 200 });
  await assert.rejects(client.initialize(), (error) => error.code === "ETIMEDOUT");
});
```

`tests/runtime.test.mjs`:

```js
test("status --wait reports a timeout in text output and exits 1 while the job is still active (#774)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "4000" });
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "slow"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const status = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "500"], { cwd: repo, env });
  assert.equal(status.status, 1);
  assert.match(status.stdout, /Timed out after 1s while the job was still running\./);
  const done = run("node", [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "20000"], { cwd: repo, env });
  assert.equal(done.status, 0, done.stderr);
});
```

- [ ] **Step 2: Run** → первый тест зависает до `timeoutMs`/падает по `destroyed`, второй — hang/reject-mismatch, третий — exit 0 без текста.
- [ ] **Step 3: Implement.** `broker-lifecycle.mjs`:

```js
const PROBE_ATTEMPT_MS = 500;

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000, options = {}) {
  const connectImpl = options.connectImpl ?? ((socketPath) => net.createConnection({ path: socketPath }));
  const target = parseBrokerEndpoint(endpoint);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const attemptMs = Math.max(1, Math.min(PROBE_ATTEMPT_MS, timeoutMs - (Date.now() - start)));
    const ready = await new Promise((resolve) => {
      const socket = connectImpl(target.path);
      let connected = false;
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      // A socket stuck in `connecting` fires neither connect nor error (#773).
      const timer = setTimeout(() => { socket.destroy(); finish(false); }, attemptMs);
      socket.on("connect", () => { connected = true; socket.end(); });
      socket.on("close", () => finish(connected));
      socket.on("error", () => finish(false));
    });
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
```

`app-server.mjs`, `BrokerCodexAppServerClient.initialize`:

```js
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      const connectImpl = this.options.connectImpl ?? ((socketPath) => net.createConnection({ path: socketPath }));
      const connectTimeoutMs = this.options.connectTimeoutMs ?? 2000;
      this.socket = connectImpl(target.path);
      this.socket.setEncoding("utf8");
      const timer = setTimeout(() => {
        const error = Object.assign(new Error(`codex app-server broker connect timed out after ${connectTimeoutMs} ms.`), { code: "ETIMEDOUT" });
        this.socket.destroy();
        reject(error);
      }, connectTimeoutMs);
      this.socket.on("connect", () => { clearTimeout(timer); resolve(); });
      this.socket.on("error", (error) => { clearTimeout(timer); if (!this.exitResolved) reject(error); this.handleExit(error); });
      ...
```

`codex.mjs` `withAppServer`: `(brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED" || error?.code === "ETIMEDOUT"))`.

`codex-companion.mjs` `handleStatus`:

```js
    if (snapshot.waitTimedOut) {
      const seconds = Math.max(1, Math.round(snapshot.timeoutMs / 1000));
      outputCommandResult(snapshot, `${renderJobStatusReport(snapshot.job)}\nTimed out after ${seconds}s while the job was still running.\n`, options.json);
      process.exitCode = 1;
      return;
    }
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
```

- [ ] **Step 4: Run** → PASS; гейт. Проверить, что `tests/commands.test.mjs`/README не обещают exit 0 для `status --wait` (`rg -n "status --wait" README.md tests/commands.test.mjs`); README: добавить строку «`status <id> --wait` exits 1 when the wait times out».
- [ ] **Step 5: Commit** `fix(broker): bound hung connects; status --wait exits 1 on timeout` с `Co-authored-by` kevin9327 (#773, #774).

---

### Task 4: Teardown broker без утечек: kill при пересоздании, повторная проба, без сигнала устаревшему pid (#753/#762/#768/#749)

**Files:**
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs` — `ensureBrokerSession`, `teardownBrokerSession`, `ownsBrokerProcess` (экспортировать)
- Test: `tests/broker-stale-pid.test.mjs`

**Interfaces:**
- `ensureBrokerSession(cwd, options)` новые опции: `killProcess` (default `terminateProcessTree`), `isAliveImpl` (default `isPidAlive`), `ownsProcessImpl` (default `ownsBrokerProcess`), `retryTimeoutMs` (default 2000).
- Правило: existing не ready → если `pid` жив **и** принадлежит broker'у → повторная проба `retryTimeoutMs`; всё ещё не ready → `killProcess(pid)` (#762/#768), затем очистка файлов; если `pid` мёртв или не наш → только очистка, **без сигнала** (#749).

- [ ] **Step 1: Failing tests.**

```js
import { ensureBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

function deadPid() {
  const result = run(process.execPath, ["-e", ""]);
  assert.equal(result.status, 0);
  return result.pid;
}

test("ensureBrokerSession kills a live unreachable broker before replacing it (#753/#762)", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const staleEndpoint = createBrokerEndpoint(sessionDir); // nothing listens here
  saveBrokerSession(workspace, { endpoint: staleEndpoint, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"), sessionDir, pid: process.pid });
  const killed = [];
  let probes = 0;
  const session = await ensureBrokerSession(workspace, {
    env: buildEnv(binDir),
    isAliveImpl: () => true,
    ownsProcessImpl: () => { probes += 1; return true; },
    killProcess: (pid) => { killed.push(pid); },
    retryTimeoutMs: 300
  });
  try {
    assert.deepEqual(killed, [process.pid], "the unreachable but live broker must be signalled");
    assert.ok(probes >= 1);
    assert.ok(session && session.endpoint !== staleEndpoint, "a fresh broker must be spawned");
    assert.equal(loadBrokerSession(workspace)?.endpoint, session.endpoint);
  } finally {
    if (session?.pid) { try { process.kill(session.pid, "SIGTERM"); } catch {} }
    clearBrokerSession(workspace);
  }
});

test("ensureBrokerSession never signals a dead or foreign pid from a stale record (#749)", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  saveBrokerSession(workspace, { endpoint: createBrokerEndpoint(sessionDir), pidFile: null, logFile: null, sessionDir, pid: deadPid() });
  const killed = [];
  const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir), killProcess: (pid) => killed.push(pid) });
  try {
    assert.deepEqual(killed, []);
    assert.ok(session);
  } finally {
    if (session?.pid) { try { process.kill(session.pid, "SIGTERM"); } catch {} }
    clearBrokerSession(workspace);
  }
});

test("ensureBrokerSession retries the readiness probe before giving up on a slow broker (#768)", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => setTimeout(resolve, 300)); // not listening yet during the first probe
  const listening = new Promise((resolve) => server.listen(parseBrokerEndpoint(endpoint).path, resolve));
  saveBrokerSession(workspace, { endpoint, pidFile: null, logFile: null, sessionDir, pid: process.pid });
  const killed = [];
  const sessionPromise = ensureBrokerSession(workspace, {
    isAliveImpl: () => true,
    ownsProcessImpl: () => true,
    killProcess: (pid) => killed.push(pid),
    retryTimeoutMs: 2000
  });
  await listening;
  const session = await sessionPromise;
  try {
    assert.deepEqual(killed, [], "a broker that answers within the retry window must not be killed");
    assert.equal(session.endpoint, endpoint);
  } finally {
    server.close();
    clearBrokerSession(workspace);
  }
});
```

(В третьем тесте порядок: probe 150 ms не успевает, retry 2 s успевает, потому что `listen` стартует после первого probe.)

- [ ] **Step 2: Run** → 1-й: `killed` пуст (нет `killProcess` по умолчанию и нет retry-семантики); 3-й: broker убит/пересоздан.
- [ ] **Step 3: Implement.**

```js
import { isPidAlive, processCommandLine, terminateProcessTree } from "./process.mjs";

export function ownsBrokerProcess(pid, endpoint, timeoutMs) {
  if (process.platform === "win32") {
    return true; // v1.4.0: CIM identity
  }
  const commandLine = processCommandLine(pid, { timeoutMs });
  if (!commandLine || !commandLine.includes("app-server-broker.mjs")) return false;
  return !endpoint || commandLine.includes(endpoint);
}

const STALE_BROKER_RETRY_MS = 2000;

export async function ensureBrokerSession(cwd, options = {}) {
  const killProcess = options.killProcess ?? terminateProcessTree;
  const isAliveImpl = options.isAliveImpl ?? isPidAlive;
  const ownsProcessImpl = options.ownsProcessImpl ?? ownsBrokerProcess;
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    const pid = Number.isFinite(existing.pid) ? existing.pid : null;
    const liveOwned = pid !== null && isAliveImpl(pid) === true && ownsProcessImpl(pid, existing.endpoint ?? null, options.timeoutMs);
    // A live broker that missed the 150 ms probe is not a dead one (#768): give it the
    // full window before deciding it is wedged.
    const stillDown = liveOwned && !(await waitForBrokerEndpoint(existing.endpoint, options.retryTimeoutMs ?? STALE_BROKER_RETRY_MS).catch(() => false));
    if (liveOwned && !stillDown) {
      return existing;
    }
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      // Only a live broker that is provably ours gets a signal (#762); a dead or
      // recycled pid is left alone (#749) — the files are stale either way.
      pid: liveOwned ? pid : null,
      killProcess: liveOwned ? killProcess : null,
      ownsProcess: () => true
    });
    clearBrokerSession(cwd);
  }
  ... // spawn как раньше; в not-ready ветке после spawn: killProcess (не options.killProcess ?? null)
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null, timeoutMs = undefined, ownsProcess = ownsBrokerProcess }) {
  let signalled = false;
  if (Number.isFinite(pid) && killProcess && ownsProcess(pid, endpoint, timeoutMs)) { ... }
```

- [ ] **Step 4: Run** → PASS; полный гейт (существующие тесты SessionEnd в `broker-stale-pid.test.mjs` не должны измениться).
- [ ] **Step 5: Commit** `fix(broker): kill a live wedged broker on replace, retry the readiness probe, never signal a stale pid` с `Co-authored-by` Soumya95 (#762), mzl9039 (#768), sylvesterkaczmarek (#749).

---

### Task 5: Stop-review gate: модель/усилие, bounded rounds по умолчанию, signal в причине, подсказка отключения, `hooks.json` без `description`

**Files:**
- Modify: `plugins/codex/scripts/stop-review-gate-hook.mjs` — `getMaxRounds`, `runStopReview`, reason-строки
- Modify: `plugins/codex/scripts/codex-companion.mjs` — `handleSetup`, `buildSetupReport`, `printUsage`
- Modify: `plugins/codex/scripts/lib/render.mjs` — `renderSetupReport` (строка про gate model/effort)
- Modify: `plugins/codex/commands/setup.md` — `argument-hint`, прокидывание флагов
- Modify: `plugins/codex/hooks/hooks.json` — убрать top-level `description` (#459)
- Modify: `README.md` — раздел review gate
- Test: `tests/runtime.test.mjs`, `tests/commands.test.mjs`

**Interfaces:**
- Config keys: `stopReviewGateModel: string|null`, `stopReviewGateEffort: string|null` (через существующие `getConfig`/`setConfig`).
- `setup --review-gate-model <model|inherit> --review-gate-effort <effort|inherit>`; `inherit` очищает. Алиасы моделей нормализуются той же `normalizeRequestedModel`, effort — `normalizeReasoningEffort`.
- `CODEX_REVIEW_GATE_MAX_ROUNDS` unset → default **3** (было 0 = без предела; #548). `0` явно → без предела (сохранить старое поведение по явному запросу).
- Reason-строки при провале gate заканчиваются `Disable with /codex:setup --disable-review-gate.`; signal-terminated review: `The stop-time Codex review task was terminated by signal SIGKILL.`

- [ ] **Step 1: Failing tests.** `tests/runtime.test.mjs` (по образцу теста на строке ~2340):

```js
test("stop gate forwards the configured model and effort to the review task (#769)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--review-gate-model", "spark", "--review-gate-effort", "low", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.reviewGateModel, "gpt-5.3-codex-spark");
  assert.equal(payload.reviewGateEffort, "low");
  const hook = run("node", [STOP_HOOK], { cwd: repo, env: buildEnv(binDir), input: JSON.stringify({ cwd: repo, session_id: "sess-gate-model", last_assistant_message: "done" }) });
  assert.equal(hook.status, 0, hook.stderr);
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.config.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastThreadStart.config.model_reasoning_effort, "low");
  const cleared = run("node", [SCRIPT, "setup", "--review-gate-model", "inherit", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(JSON.parse(cleared.stdout).reviewGateModel, null);
});

test("stop gate stops blocking after three gate-induced rounds by default (#548)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  run("node", [SCRIPT, "setup", "--enable-review-gate"], { cwd: repo, env: buildEnv(binDir) });
  const env = { ...buildEnv(binDir) };
  delete env.CODEX_REVIEW_GATE_MAX_ROUNDS;
  const input = (active) => JSON.stringify({ cwd: repo, session_id: "sess-rounds", stop_hook_active: active, last_assistant_message: "I completed the refactor." });
  const decisions = [];
  for (const active of [false, true, true, true]) {
    const r = run("node", [STOP_HOOK], { cwd: repo, env, input: input(active) });
    assert.equal(r.status, 0, r.stderr);
    decisions.push(r.stdout.trim() ? JSON.parse(r.stdout).decision : "allow");
  }
  assert.deepEqual(decisions, ["block", "block", "block", "allow"]);
});

test("stop gate names the signal when the review task is killed and always names the escape hatch (#589/#483)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  run("node", [SCRIPT, "setup", "--enable-review-gate"], { cwd: repo, env: buildEnv(binDir) });
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", CODEX_STOP_REVIEW_TIMEOUT_MS: "800" });
  const r = run("node", [STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo, session_id: "sess-signal", last_assistant_message: "x" }) });
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /timed out after 0\.8 minutes|terminated by signal SIGKILL/);
  assert.match(payload.reason, /Disable with \/codex:setup --disable-review-gate\./);
});
```

`tests/commands.test.mjs`, в тест `hooks keep session-end cleanup and stop gating enabled` добавить `assert.equal("description" in JSON.parse(source), false);`.

- [ ] **Step 2: Run** → падают (неизвестные флаги setup; decisions `["block","block","block","block"]`; нет текста escape hatch; `description` присутствует).
- [ ] **Step 3: Implement.**

`codex-companion.mjs` `handleSetup`: `valueOptions: ["cwd", "review-gate-model", "review-gate-effort"]`; после обработки enable/disable:

```js
  if (options["review-gate-model"] != null) {
    const value = String(options["review-gate-model"]).trim().toLowerCase() === "inherit" ? null : normalizeRequestedModel(options["review-gate-model"]);
    setConfig(workspaceRoot, "stopReviewGateModel", value);
    actionsTaken.push(value ? `Stop-time review gate model set to ${value}.` : "Stop-time review gate model now inherits Codex config.");
  }
  if (options["review-gate-effort"] != null) {
    const value = String(options["review-gate-effort"]).trim().toLowerCase() === "inherit" ? null : normalizeReasoningEffort(options["review-gate-effort"]);
    setConfig(workspaceRoot, "stopReviewGateEffort", value);
    actionsTaken.push(value ? `Stop-time review gate effort set to ${value}.` : "Stop-time review gate effort now inherits Codex config.");
  }
```

`buildSetupReport`: добавить `reviewGateModel: config.stopReviewGateModel ?? null, reviewGateEffort: config.stopReviewGateEffort ?? null`. `render.mjs` `renderSetupReport`: строка `- Review gate model/effort: <model|inherit> / <effort|inherit>` под строкой про gate. `printUsage`: `setup [--enable-review-gate|--disable-review-gate] [--review-gate-model <model|inherit>] [--review-gate-effort <effort|inherit>] [--json]`. `commands/setup.md`: `argument-hint` и тело уже прокидывают `$ARGUMENTS` через `--args-stdin` — проверить, что новые флаги проходят (`rg -n "args-stdin" plugins/codex/commands/setup.md`).

`stop-review-gate-hook.mjs`:

```js
const DEFAULT_MAX_ROUNDS = 3;
const STOP_REVIEW_TIMEOUT_MS = Number(process.env.CODEX_STOP_REVIEW_TIMEOUT_MS) > 0 ? Number(process.env.CODEX_STOP_REVIEW_TIMEOUT_MS) : STOP_REVIEW_TIMEOUT_MINUTES * 60 * 1000;
const ESCAPE_HATCH = "Disable with /codex:setup --disable-review-gate.";

function getMaxRounds() {
  const raw = process.env.CODEX_REVIEW_GATE_MAX_ROUNDS;
  if (raw == null || raw === "") return DEFAULT_MAX_ROUNDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_ROUNDS;
}

function runStopReview(cwd, input = {}, config = {}) {
  ...
  const args = [scriptPath, "task", "--json"];
  if (config.stopReviewGateModel) args.push("--model", config.stopReviewGateModel);
  if (config.stopReviewGateEffort) args.push("--effort", config.stopReviewGateEffort);
  args.push(prompt);
  const result = spawnSync(process.execPath, args, { ... });
  if (result.error?.code === "ETIMEDOUT") {
    return { ok: false, reason: `The stop-time Codex review task timed out after ${(STOP_REVIEW_TIMEOUT_MS / 60000).toFixed(1)} minutes. Run /codex:review --wait manually. ${ESCAPE_HATCH}` };
  }
  if (result.signal) {
    return { ok: false, reason: `The stop-time Codex review task was terminated by signal ${result.signal}. Run /codex:review --wait manually. ${ESCAPE_HATCH}` };
  }
  if (result.status !== 0) { ... `${detail} ${ESCAPE_HATCH}` }
  // invalid JSON / no output / unexpected answer: append ESCAPE_HATCH
```

Вызов: `runStopReview(cwd, input, config)`. `hooks.json`: удалить ключ `"description"`. Существующий тест `stop gate script timeout is shorter than the Stop hook timeout` читает `STOP_REVIEW_TIMEOUT_MINUTES` — константа остаётся; env-override используется только тестами.

- [ ] **Step 4: Run** → PASS; гейт; README: описать `--review-gate-model/--review-gate-effort`, default 3 rounds, `CODEX_REVIEW_GATE_MAX_ROUNDS=0` = без предела.
- [ ] **Step 5: Commit** `feat(stop-gate): pin model/effort, bound rounds by default, name signal and escape hatch; drop hooks.json description` с `Co-authored-by` mittalpk (#565), SomSamantray (#573).

---

### Task 6: Transfer учитывает `CLAUDE_CONFIG_DIR` (#721)

**Files:**
- Modify: `plugins/codex/scripts/lib/claude-session-transfer.mjs`
- Modify: `tests/test-env.mjs` — добавить `CLAUDE_CONFIG_DIR` в список стираемых
- Test: `tests/runtime.test.mjs` (рядом с существующими transfer-тестами; `rg -n "^test\(.*transfer" tests/runtime.test.mjs`)

**Interfaces:** `resolveClaudeProjectsDir(env = process.env)` → `path.join(env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude"), "projects")`; экспортируется для тестов; `resolveClaudeSessionPath(cwd, options)` принимает `options.env`.

- [ ] **Step 1: Failing test.**

```js
import { resolveClaudeSessionPath, resolveClaudeProjectsDir } from "../plugins/codex/scripts/lib/claude-session-transfer.mjs";

test("transfer resolves transcripts under CLAUDE_CONFIG_DIR when it is set (#721)", () => {
  const configDir = makeTempDir();
  const projectDir = path.join(configDir, "projects", "-tmp-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, "sess.jsonl");
  fs.writeFileSync(transcript, "{}\n");
  const env = { CLAUDE_CONFIG_DIR: configDir };
  assert.equal(resolveClaudeProjectsDir(env), path.join(configDir, "projects"));
  assert.equal(resolveClaudeSessionPath(process.cwd(), { source: transcript, env }), fs.realpathSync(transcript));
  assert.throws(() => resolveClaudeSessionPath(process.cwd(), { source: transcript, env: {} }), /can import Claude sessions only from/);
});
```

- [ ] **Step 2: Run** → `resolveClaudeProjectsDir is not a function`.
- [ ] **Step 3: Implement.**

```js
export function resolveClaudeProjectsDir(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR ? path.resolve(String(env.CLAUDE_CONFIG_DIR)) : path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const env = options.env ?? process.env;
  const projectsDir = resolveClaudeProjectsDir(env);
  const requestedPath = options.source || env[TRANSCRIPT_PATH_ENV];
  ... // далее вместо CLAUDE_PROJECTS_DIR использовать projectsDir (и в сообщении об ошибке)
```

Удалить константу `CLAUDE_PROJECTS_DIR`. В `tests/test-env.mjs` добавить `"CLAUDE_CONFIG_DIR"`.

- [ ] **Step 4: Run** → PASS; гейт. README раздел transfer: одна строка «honours `CLAUDE_CONFIG_DIR`».
- [ ] **Step 5: Commit** `fix(transfer): resolve Claude transcripts under CLAUDE_CONFIG_DIR`.

---

### Task 7: Data-driven каталог моделей (#468/#703/#485/#128)

**Files:**
- Create: `plugins/codex/scripts/lib/model-catalog.mjs`
- Modify: `plugins/codex/scripts/codex-companion.mjs` — `MODEL_ALIASES`, `normalizeRequestedModel`, `normalizeReasoningEffort` (+ проверка по модели), `printUsage`
- Create: `tests/fixtures/models-catalog.json`
- Modify: `tests/test-env.mjs` — `process.env.CODEX_COMPANION_MODEL_CATALOG = <fixture path>`
- Create: `tests/model-catalog.test.mjs`
- Test: `tests/runtime.test.mjs`
- Docs: `README.md` (алиасы), `plugins/codex/skills/codex-cli-runtime/SKILL.md:27-28,37`, `plugins/codex/agents/codex-rescue.md:39-40`, `plugins/codex/commands/rescue.md:3`

**Interfaces:**
- `loadModelCatalog({ env = process.env, runCommandImpl = runCommand } = {})` → `Array<{ slug, visibility, priority, efforts: string[] }>`; источник по порядку: `env.CODEX_COMPANION_MODEL_CATALOG` (файл, для тестов) → `${CODEX_HOME ?? ~/.codex}/models_cache.json` → `codex debug models --bundled` (timeoutMs 10000, maxBuffer 64 MiB) → `[]`. Никогда не бросает; результат кешируется на процесс.
- `resolveModelAlias(alias, catalog)` → slug. Точное совпадение со slug из каталога → как есть. Иначе family-алиас: кандидаты `visibility === "list"` и (`slug === alias` или `slug.endsWith("-" + alias)`), сортировка: `priority` по возрастанию, затем по убыванию числа семейства из `/^gpt-(\d+(?:\.\d+)?)/` → первый. Иначе `FALLBACK_ALIASES.get(alias)`; иначе `alias`.
- `supportedEfforts(slug, catalog)` → `string[] | null` (`null` = модель не в каталоге → принять любой из `VALID_REASONING_EFFORTS`).
- `FALLBACK_ALIASES`: `spark→gpt-5.3-codex-spark`, `astra→gpt-6-astra`, `sol→gpt-6-sol`, `luna→gpt-6-luna`, `terra→gpt-5.6-terra`, `mini→gpt-5.4-mini`.

- [ ] **Step 1: Fixture** `tests/fixtures/models-catalog.json`:

```json
{ "models": [
  { "slug": "gpt-6-astra", "visibility": "list", "priority": 1, "supported_reasoning_levels": [ {"effort":"low"}, {"effort":"medium"}, {"effort":"high"}, {"effort":"xhigh"}, {"effort":"max"}, {"effort":"ultra"} ] },
  { "slug": "gpt-6-sol",   "visibility": "list", "priority": 2, "supported_reasoning_levels": [ {"effort":"low"}, {"effort":"medium"}, {"effort":"high"}, {"effort":"xhigh"}, {"effort":"max"}, {"effort":"ultra"} ] },
  { "slug": "gpt-5.6-sol", "visibility": "list", "priority": 5, "supported_reasoning_levels": [ {"effort":"low"}, {"effort":"medium"}, {"effort":"high"} ] },
  { "slug": "gpt-5.6-terra", "visibility": "list", "priority": 6, "supported_reasoning_levels": [ {"effort":"low"}, {"effort":"medium"}, {"effort":"high"}, {"effort":"xhigh"} ] },
  { "slug": "gpt-reserve", "visibility": "hide", "priority": 9, "supported_reasoning_levels": [ {"effort":"low"} ] },
  { "slug": "gpt-5.3-codex-spark", "visibility": "list", "priority": 7, "supported_reasoning_levels": [ {"effort":"low"}, {"effort":"medium"}, {"effort":"high"} ] }
] }
```

- [ ] **Step 2: Failing tests** `tests/model-catalog.test.mjs`:

```js
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadModelCatalog, resolveModelAlias, supportedEfforts } from "../plugins/codex/scripts/lib/model-catalog.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "models-catalog.json");
const catalog = loadModelCatalog({ env: { CODEX_COMPANION_MODEL_CATALOG: FIXTURE } });

test("family alias resolves to the listed model with the lowest priority, newest family on ties", () => {
  assert.equal(resolveModelAlias("sol", catalog), "gpt-6-sol");
  assert.equal(resolveModelAlias("terra", catalog), "gpt-5.6-terra");
  assert.equal(resolveModelAlias("astra", catalog), "gpt-6-astra");
  assert.equal(resolveModelAlias("SOL", catalog), "gpt-6-sol");
});

test("hidden models never resolve from an alias and exact slugs pass through", () => {
  assert.equal(resolveModelAlias("reserve", catalog), "reserve");
  assert.equal(resolveModelAlias("gpt-reserve", catalog), "gpt-reserve");
  assert.equal(resolveModelAlias("gpt-5.6-sol", catalog), "gpt-5.6-sol");
});

test("hardcoded fallback applies only without a catalogue", () => {
  assert.equal(resolveModelAlias("sol", []), "gpt-6-sol");
  assert.equal(resolveModelAlias("mini", catalog), "gpt-5.4-mini");
});

test("supportedEfforts reports the catalogue list or null for unknown models", () => {
  assert.deepEqual(supportedEfforts("gpt-5.6-sol", catalog), ["low", "medium", "high"]);
  assert.equal(supportedEfforts("o3", catalog), null);
});

test("loadModelCatalog never throws on a missing or malformed source", () => {
  assert.deepEqual(loadModelCatalog({ env: { CODEX_COMPANION_MODEL_CATALOG: "/nonexistent.json", CODEX_HOME: "/nonexistent" }, runCommandImpl: () => ({ status: 1, stdout: "", stderr: "", error: null }) }), []);
});
```

`tests/runtime.test.mjs`:

```js
test("task --model sol resolves through the model catalogue and rejects an unsupported effort", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  const ok = run("node", [SCRIPT, "task", "--json", "--model", "sol", "--effort", "max", "hello"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).lastThreadStart.config.model, "gpt-6-sol");
  const bad = run("node", [SCRIPT, "task", "--json", "--model", "gpt-5.6-sol", "--effort", "max", "hello"], { cwd: repo, env: buildEnv(binDir) });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /gpt-5\.6-sol supports: low, medium, high/);
});
```

Существующие assert'ы `lastThreadStart.model === "gpt-5.3-codex-spark"` (runtime ~998/1020) и `thread-config` остаются валидными (spark в fixture-каталоге).

- [ ] **Step 3: Run** → `Cannot find module model-catalog.mjs`.
- [ ] **Step 4: Implement** `lib/model-catalog.mjs`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runCommand } from "./process.mjs";

export const CATALOG_ENV = "CODEX_COMPANION_MODEL_CATALOG";
export const FALLBACK_ALIASES = new Map([
  ["spark", "gpt-5.3-codex-spark"],
  ["astra", "gpt-6-astra"],
  ["sol", "gpt-6-sol"],
  ["luna", "gpt-6-luna"],
  ["terra", "gpt-5.6-terra"],
  ["mini", "gpt-5.4-mini"]
]);

let cached = null;

function normalizeEntries(raw) {
  const models = Array.isArray(raw?.models) ? raw.models : Array.isArray(raw) ? raw : [];
  return models
    .filter((m) => m && typeof m.slug === "string")
    .map((m) => ({
      slug: m.slug,
      visibility: m.visibility ?? "list",
      priority: Number.isFinite(m.priority) ? m.priority : Number.MAX_SAFE_INTEGER,
      efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l) => l?.effort).filter(Boolean) : []
    }));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function loadModelCatalog({ env = process.env, runCommandImpl = runCommand, cache = true } = {}) {
  if (cache && cached) return cached;
  const sources = [];
  if (env[CATALOG_ENV]) sources.push(() => readJson(env[CATALOG_ENV]));
  const codexHome = path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  sources.push(() => readJson(path.join(codexHome, "models_cache.json")));
  // Last resort: the bundled catalogue, never the network-refreshing form — its
  // output is ~500 KB and this runs on every companion invocation.
  sources.push(() => {
    const result = runCommandImpl("codex", ["debug", "models", "--bundled"], { env, timeoutMs: 10000, maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) return null;
    try { return JSON.parse(result.stdout); } catch { return null; }
  });
  let entries = [];
  for (const source of sources) {
    entries = normalizeEntries(source());
    if (entries.length > 0) break;
  }
  if (cache) cached = entries;
  return entries;
}

function familyNumber(slug) {
  const match = /^gpt-(\d+(?:\.\d+)?)/.exec(slug);
  return match ? Number(match[1]) : -1;
}

export function resolveModelAlias(alias, catalog) {
  const wanted = String(alias ?? "").trim();
  if (!wanted) return null;
  if (catalog.some((m) => m.slug === wanted)) return wanted;
  const lower = wanted.toLowerCase();
  const candidates = catalog
    .filter((m) => m.visibility === "list" && (m.slug === lower || m.slug.endsWith(`-${lower}`)))
    .sort((a, b) => a.priority - b.priority || familyNumber(b.slug) - familyNumber(a.slug));
  if (candidates.length > 0) return candidates[0].slug;
  return FALLBACK_ALIASES.get(lower) ?? wanted;
}

export function supportedEfforts(slug, catalog) {
  const entry = catalog.find((m) => m.slug === slug);
  return entry && entry.efforts.length > 0 ? entry.efforts : null;
}
```

`codex-companion.mjs`: удалить `MODEL_ALIASES`; `normalizeRequestedModel(model)` → `resolveModelAlias(model, loadModelCatalog())`; `normalizeReasoningEffort(effort, model = null)`: после проверки `VALID_REASONING_EFFORTS`, если `model` задан: `const allowed = supportedEfforts(model, loadModelCatalog()); if (allowed && !allowed.includes(normalized)) throw new Error(\`Reasoning effort "${normalized}" is not supported by ${model}. ${model} supports: ${allowed.join(", ")}.\`)`. Во всех трёх местах вызова (`review`, `adversarial-review`, `task`) сначала нормализовать модель, затем `normalizeReasoningEffort(options.effort, model)`. `printUsage`: `--model <model|spark|astra|sol|luna|terra|mini>`. `tests/test-env.mjs`: `process.env.CODEX_COMPANION_MODEL_CATALOG = new URL("./fixtures/models-catalog.json", import.meta.url).pathname;` (после цикла `delete`).

- [ ] **Step 5: Docs.** README алиасы: «aliases resolve against the local Codex model catalogue (`$CODEX_HOME/models_cache.json`); today `sol → gpt-6-sol`, `astra → gpt-6-astra`, `luna → gpt-6-luna`, `terra → gpt-5.6-terra`, `spark → gpt-5.3-codex-spark`, `mini → gpt-5.4-mini`; run `codex debug models` to see yours». SKILL.md:27-28,37, agent:39-40, rescue.md argument-hint — то же, без хардкода семейства (`sol` → «the newest listed `*-sol` model»). Пример README:150/298 → `gpt-6-astra`.
- [ ] **Step 6: Run** → PASS; гейт; `tests/commands.test.mjs` README-assertions (`rg -n "gpt-5" tests/commands.test.mjs`) обновить при необходимости.
- [ ] **Step 7: Commit** `feat(models): resolve aliases and validate efforts against the Codex model catalogue`.

---

### Task 8: Security: приватный fallback state root с plugin-сегментом (#521/#609) и валидация `broker.json`

**Files:**
- Modify: `plugins/codex/scripts/lib/state.mjs` — `FALLBACK_STATE_ROOT_DIR` → `resolveFallbackStateRoot()`, `resolveStateDir`
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs` — `loadBrokerSession` валидация
- Test: `tests/state.test.mjs`, `tests/broker-stale-pid.test.mjs`

**Interfaces:**
- `resolveFallbackStateRoot({ env = process.env, tmpdir = os.tmpdir(), uid = process.getuid?.() ?? null, pluginRoot })` → `path.join(tmpdir, \`codex-companion-${uid ?? "user"}\`, sha256(realpath(pluginRoot)).slice(0, 12))`; `pluginRoot` = `env.CLAUDE_PLUGIN_ROOT` или `path.resolve(SCRIPT_DIR, "..")`. Каталог создаётся с `mode: 0o700`; на posix после `mkdirSync` проверяется `stat`: `uid === process.getuid()` и `(mode & 0o077) === 0`, иначе `throw new Error("Refusing to use shared state directory <path>: owned by another user or group/world accessible. Set CLAUDE_PLUGIN_DATA.")`.
- `loadBrokerSession(cwd)` возвращает `null` (и пишет в stderr `[codex] Ignoring malformed broker.json at <path>: <why>`), если: не объект; `endpoint` не строка или `parseBrokerEndpoint` бросает; `pid` не `null` и не положительное целое; любой из `pidFile`/`logFile`/`sessionDir` задан и не абсолютный путь.

- [ ] **Step 1: Failing tests.** `tests/state.test.mjs`:

```js
import { resolveFallbackStateRoot } from "../plugins/codex/scripts/lib/state.mjs";

test("fallback state root is private to the user and namespaced per plugin root (#521/#609)", { skip: process.platform === "win32" }, () => {
  const tmp = makeTempDir();
  const pluginA = makeTempDir();
  const pluginB = makeTempDir();
  const a = resolveFallbackStateRoot({ env: {}, tmpdir: tmp, pluginRoot: pluginA });
  const b = resolveFallbackStateRoot({ env: {}, tmpdir: tmp, pluginRoot: pluginB });
  assert.notEqual(a, b);
  assert.ok(a.startsWith(path.join(tmp, `codex-companion-${process.getuid()}`)));
  assert.equal(fs.statSync(path.dirname(a)).mode & 0o077, 0);
});

test("fallback state root refuses a pre-existing world-accessible directory", { skip: process.platform === "win32" }, () => {
  const tmp = makeTempDir();
  const shared = path.join(tmp, `codex-companion-${process.getuid()}`);
  fs.mkdirSync(shared, { mode: 0o755 });
  assert.throws(() => resolveFallbackStateRoot({ env: {}, tmpdir: tmp, pluginRoot: makeTempDir() }), /Refusing to use shared state directory/);
});
```

`tests/broker-stale-pid.test.mjs`:

```js
test("loadBrokerSession ignores a malformed record instead of trusting it", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "broker.json");
  for (const bad of [
    "[]",
    JSON.stringify({ endpoint: "ftp://x", pid: 1 }),
    JSON.stringify({ endpoint: "unix:/tmp/x.sock", pid: -5 }),
    JSON.stringify({ endpoint: "unix:/tmp/x.sock", pid: 1, pidFile: "relative/broker.pid" })
  ]) {
    fs.writeFileSync(file, bad);
    assert.equal(loadBrokerSession(workspace), null, bad);
  }
  fs.writeFileSync(file, JSON.stringify({ endpoint: "unix:/tmp/x.sock", pid: null, pidFile: null, logFile: null, sessionDir: null }));
  assert.ok(loadBrokerSession(workspace));
});
```

- [ ] **Step 2: Run** → `resolveFallbackStateRoot is not a function`; broker-тест: malformed записи возвращаются как есть.
- [ ] **Step 3: Implement.** `state.mjs`:

```js
import { fileURLToPath } from "node:url";
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function resolveFallbackStateRoot({ env = process.env, tmpdir = os.tmpdir(), uid = typeof process.getuid === "function" ? process.getuid() : null, pluginRoot = env.CLAUDE_PLUGIN_ROOT || SCRIPT_ROOT } = {}) {
  let canonicalPluginRoot = pluginRoot;
  try { canonicalPluginRoot = fs.realpathSync.native(pluginRoot); } catch { /* keep as given */ }
  const userDir = path.join(tmpdir, `codex-companion-${uid ?? "user"}`);
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    const stats = fs.statSync(userDir);
    if ((uid !== null && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
      throw new Error(`Refusing to use shared state directory ${userDir}: owned by another user or group/world accessible. Set CLAUDE_PLUGIN_DATA.`);
    }
  }
  // ponytail: plugin identity = hash of the install root; sibling plugins/forks get separate roots (#609)
  return path.join(userDir, createHash("sha256").update(canonicalPluginRoot).digest("hex").slice(0, 12));
}
```

`resolveStateDir`: `const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : resolveFallbackStateRoot();`. Удалить `FALLBACK_STATE_ROOT_DIR`.

`broker-lifecycle.mjs`:

```js
function describeBrokerRecordProblem(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "not an object";
  if (typeof record.endpoint !== "string") return "endpoint is not a string";
  try { parseBrokerEndpoint(record.endpoint); } catch (error) { return error.message; }
  if (record.pid != null && !(Number.isInteger(record.pid) && record.pid > 0)) return "pid is not a positive integer";
  for (const key of ["pidFile", "logFile", "sessionDir"]) {
    if (record[key] != null && !(typeof record[key] === "string" && path.isAbsolute(record[key]))) return `${key} is not an absolute path`;
  }
  return null;
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) return null;
  let record;
  try { record = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; }
  const problem = describeBrokerRecordProblem(record);
  if (problem) {
    process.stderr.write(`[codex] Ignoring malformed broker.json at ${stateFile}: ${problem}.\n`);
    return null;
  }
  return record;
}
```

- [ ] **Step 4: Run** → PASS; гейт. Проверить, что тесты, которые пишут `broker.json` вручную с относительными путями, не сломались (`rg -n "saveBrokerSession\(" tests/*.mjs`).
- [ ] **Step 5: Commit** `fix(state): private per-user, per-plugin fallback state root; validate broker.json before use`.

---

### Task 9: Process identity на posix (#743) — по разделу «Дизайн: process identity» спека

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs` — `runCommand` (`status ?? null`), `getProcessIdentity`, `terminateProcessTreeIfIdentityMatches`, `terminateRecordedProcess`
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs` — identity в `ensureBrokerSession`/`teardownBrokerSession`
- Modify: `plugins/codex/scripts/lib/state.mjs` — `writeJobPidFile`/`readJobPidSidecar` (JSON + bare integer), `updateJobPid(cwd, jobId, pid, identity)`, `resolveJobPid` → `{ pid, identity }`, ticket owner identity + `judgeLockEntry`
- Modify: `plugins/codex/scripts/lib/tracked-jobs.mjs` — `runTrackedJob` (`pidIdentity`), `reapDeadJobs`
- Modify: `plugins/codex/scripts/codex-companion.mjs` — `enqueueBackgroundTask`, `handleCancel`
- Modify: `plugins/codex/scripts/session-lifecycle-hook.mjs` — `cleanupSessionJobs`, вызов `teardownBrokerSession`
- Test: `tests/process.test.mjs`, `tests/tracked-jobs.test.mjs`, `tests/state.test.mjs`, `tests/broker-stale-pid.test.mjs`, `tests/runtime.test.mjs`

**Interfaces (обязательные сигнатуры):**
- `getProcessIdentity(pid, { platform = process.platform, timeoutMs = 10000, runCommandImpl = runCommand, readFileSyncImpl = fs.readFileSync } = {})` → `string | null`. linux: поле 22 из `/proc/<pid>/stat` (после последней `)`), формат `linux:<starttime>`; darwin: `ps -o lstart=,comm= -p <pid>` → `darwin:<lstart>|<comm>`; win32: `null` (v1.4.0). Свой pid кешируется.
- `terminateRecordedProcess(pid, { identity = null, commandLineMatch = null, timeoutMs, platform, killImpl, runCommandImpl } = {})` → `{ attempted: boolean, delivered: boolean, reason: "identity-match"|"command-line-match"|"identity-mismatch"|"identity-unavailable"|"no-pid" }`. identity задан → сравнить с `getProcessIdentity`; mismatch/unavailable → `attempted:false`. identity `null` и posix → `commandLineMatch(processCommandLine(pid))` (функция или RegExp); нет match → `attempted:false, reason:"identity-mismatch"`. identity `null` и win32 → `attempted:false, reason:"identity-unavailable"`.
- Sidecar `jobs/<id>.pid`: `{"pid":N,"identity":"..."}`; читалка принимает и старый bare-integer. `resolveJobPid(cwd, job)` → `{ pid: number|null, identity: string|null }` (три вызывающих места обновить).
- Job-record: `pidIdentity: string|null` рядом с `pid` (в `runTrackedJob` и во всех местах, где `pid: null`).
- `broker.json`: `pidIdentity: string|null`.

- [ ] **Step 1: Failing unit tests** `tests/process.test.mjs`:

```js
import { getProcessIdentity, terminateRecordedProcess } from "../plugins/codex/scripts/lib/process.mjs";

test("getProcessIdentity is stable for the same process and differs for another one", { skip: process.platform === "win32" }, () => {
  const mine = getProcessIdentity(process.pid);
  assert.ok(mine && mine.length > 0);
  assert.equal(getProcessIdentity(process.pid), mine);
  const child = spawnSync(process.execPath, ["-e", "setTimeout(()=>{}, 2000); console.log(process.pid)"], { encoding: "utf8", timeout: 100 });
  // The child was killed by the timeout; its identity, if any, must not equal ours.
  assert.notEqual(getProcessIdentity(Number(child.stdout.trim()) || 999999), mine);
});

test("getProcessIdentity parses linux /proc stat and darwin ps output", () => {
  assert.equal(getProcessIdentity(42, { platform: "linux", readFileSyncImpl: () => "42 (node (x)) S 1 42 42 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 123456 1 2 3" }), "linux:123456");
  assert.equal(getProcessIdentity(42, { platform: "darwin", runCommandImpl: () => ({ status: 0, stdout: "Mon Sep 27 10:00:00 2026 node\n", stderr: "", error: null }) }), "darwin:Mon Sep 27 10:00:00 2026|node");
  assert.equal(getProcessIdentity(42, { platform: "win32" }), null);
});

test("terminateRecordedProcess refuses on identity mismatch and without identity on win32", () => {
  let killed = false;
  const mismatch = terminateRecordedProcess(4242, { identity: "linux:1", platform: "linux", readFileSyncImpl: () => "4242 (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 1 0 999 0 0 0", killImpl: () => { killed = true; } });
  assert.equal(mismatch.attempted, false);
  assert.equal(mismatch.reason, "identity-mismatch");
  assert.equal(killed, false);
  const win = terminateRecordedProcess(4242, { identity: null, platform: "win32", killImpl: () => { killed = true; } });
  assert.deepEqual([win.attempted, win.reason, killed], [false, "identity-unavailable", false]);
});

test("terminateRecordedProcess falls back to the command line on posix when no identity was recorded", () => {
  const calls = [];
  const ok = terminateRecordedProcess(4242, { identity: null, platform: "linux", commandLineMatch: /app-server-broker\.mjs/, runCommandImpl: () => ({ status: 0, stdout: "node app-server-broker.mjs serve\n", stderr: "", error: null }), killImpl: (pid, sig) => calls.push([pid, sig]) });
  assert.equal(ok.attempted, true);
  assert.equal(ok.reason, "command-line-match");
  assert.deepEqual(calls[0], [-4242, "SIGTERM"]);
  const no = terminateRecordedProcess(4242, { identity: null, platform: "linux", commandLineMatch: /app-server-broker\.mjs/, runCommandImpl: () => ({ status: 0, stdout: "bash\n", stderr: "", error: null }), killImpl: () => calls.push("must not") });
  assert.equal(no.attempted, false);
});
```

`tests/tracked-jobs.test.mjs`:

```js
test("reapDeadJobs fails a running job whose pid was recycled by another process", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-recycled", status: "running", phase: "delegating", pid: process.pid, pidIdentity: "linux:not-this-process", logFile: null });
  const reaped = reapDeadJobs(workspace, listJobs(workspace), { getProcessIdentityImpl: () => "linux:something-else" });
  assert.equal(reaped[0].status, "failed");
  assert.match(reaped[0].errorMessage, /pid reused/);
});

test("reapDeadJobs leaves a running job alone when the identity probe fails", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-probe-fails", status: "running", phase: "delegating", pid: process.pid, pidIdentity: "linux:x", logFile: null });
  const reaped = reapDeadJobs(workspace, listJobs(workspace), { getProcessIdentityImpl: () => { throw new Error("ps unavailable"); } });
  assert.equal(reaped[0].status, "running");
});

test("pid sidecar round-trips identity and still reads the legacy bare integer", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-sidecar", status: "queued", phase: "queued", pid: null, logFile: null });
  updateJobPid(workspace, "job-sidecar", 777, "linux:777");
  assert.deepEqual(resolveJobPid(workspace, listJobs(workspace)[0]), { pid: 777, identity: "linux:777" });
  fs.writeFileSync(resolveJobPidFile(workspace, "job-sidecar"), "778\n");
  assert.deepEqual(resolveJobPid(workspace, { id: "job-sidecar", status: "queued", pid: null }), { pid: 778, identity: null });
});
```

`tests/broker-stale-pid.test.mjs`:

```js
test("SessionEnd leaves a recorded broker pid alone when its identity no longer matches (#743)", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  saveBrokerSession(workspace, { endpoint, pidFile: null, logFile: null, sessionDir, pid: process.pid, pidIdentity: "darwin:definitely-not-this|nope" });
  const hook = run("node", [SESSION_HOOK, "SessionEnd"], { cwd: workspace, env: buildEnv(binDir), input: JSON.stringify({ cwd: workspace, session_id: "sess-identity" }) });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stderr, /signalled=false/);
  assert.match(hook.stderr, /identity-mismatch/);
  clearBrokerSession(workspace);
});
```

`tests/runtime.test.mjs` (e2e):

```js
test("cancel refuses to signal a worker whose recorded identity no longer matches and says so", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "8000" });
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "slow"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const sidecar = resolveJobPidFile(repo, jobId);
  const record = JSON.parse(fs.readFileSync(sidecar, "utf8"));
  fs.writeFileSync(sidecar, JSON.stringify({ pid: record.pid, identity: "linux:tampered" }));
  const job = readPersistedJob(repo, jobId);
  if (job.pid != null) { fs.writeFileSync(resolveJobFile(repo, jobId), JSON.stringify({ ...job, pidIdentity: "linux:tampered" })); }
  const cancel = run("node", [SCRIPT, "cancel", jobId], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, /worker pid \d+ left running: identity-mismatch/);
  try { process.kill(record.pid, "SIGKILL"); } catch {}
});
```

(`resolveJobPidFile`, `resolveJobFile` импортировать из `state.mjs`.)

- [ ] **Step 2: Run** → все новые тесты падают на отсутствующих экспортах/полях.
- [ ] **Step 3: Implement `process.mjs`.**

```js
import fs from "node:fs";

// runCommand: status: result.status ?? null  (a timed-out spawnSync has null status; never read it as exit 0)

const ownIdentityCache = new Map();

export function getProcessIdentity(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return null; // ponytail: CIM identity lands in v1.4.0
  if (pid === process.pid && ownIdentityCache.has(platform)) return ownIdentityCache.get(platform);
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const readFileSyncImpl = options.readFileSyncImpl ?? fs.readFileSync;
  let identity = null;
  if (platform === "linux") {
    try {
      const stat = String(readFileSyncImpl(`/proc/${pid}/stat`, "utf8"));
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const starttime = fields[19]; // field 22 overall: pid(1) comm(2) then 20 fields after ")"
      identity = starttime ? `linux:${starttime}` : null;
    } catch { identity = null; }
  } else {
    const result = runCommandImpl("ps", ["-o", "lstart=,comm=", "-p", String(pid)], { timeoutMs: options.timeoutMs ?? 10000, shell: false });
    const line = !result.error && result.status === 0 ? result.stdout.trim() : "";
    if (line) {
      const idx = line.lastIndexOf(" ");
      identity = `darwin:${line.slice(0, idx).trim()}|${line.slice(idx + 1).trim()}`;
    }
  }
  if (pid === process.pid && identity) ownIdentityCache.set(platform, identity);
  return identity;
}

export function terminateRecordedProcess(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { attempted: false, delivered: false, reason: "no-pid" };
  const platform = options.platform ?? process.platform;
  const identity = options.identity ?? null;
  if (identity) {
    const actual = getProcessIdentity(pid, options);
    if (!actual) return { attempted: false, delivered: false, reason: "identity-unavailable" };
    if (actual !== identity) return { attempted: false, delivered: false, reason: "identity-mismatch" };
    const outcome = terminateProcessTree(pid, options);
    return { ...outcome, reason: "identity-match" };
  }
  if (platform === "win32") return { attempted: false, delivered: false, reason: "identity-unavailable" };
  const commandLine = processCommandLine(pid, options);
  const match = options.commandLineMatch;
  const matched = commandLine && (typeof match === "function" ? match(commandLine) : match instanceof RegExp ? match.test(commandLine) : false);
  if (!matched) return { attempted: false, delivered: false, reason: "identity-mismatch" };
  return { ...terminateProcessTree(pid, options), reason: "command-line-match" };
}
```

(`processCommandLine` и `terminateProcessTree` уже принимают `runCommandImpl`/`killImpl`/`platform`.) В `processCommandLine` вызов `ps` — добавить `shell: false`.

- [ ] **Step 4: Implement `state.mjs`.**

```js
export function writeJobPidFile(cwd, jobId, pid, identity = null) {
  return writeFileAtomic(resolveJobPidFile(cwd, jobId), `${JSON.stringify({ pid, identity })}\n`);
}
function readJobPidSidecar(cwd, jobId) {
  try {
    const raw = fs.readFileSync(resolveJobPidFile(cwd, jobId), "utf8").trim();
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      const pid = Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
      return pid ? { pid, identity: typeof parsed.identity === "string" ? parsed.identity : null } : null;
    }
    const pid = Number.parseInt(raw, 10); // v1.2.x bare integer
    return Number.isInteger(pid) && pid > 0 ? { pid, identity: null } : null;
  } catch { return null; }
}
export function updateJobPid(cwd, jobId, pid, identity = null) {
  writeJobPidFile(cwd, jobId, pid, identity);
  withStateLock(cwd, () => {
    const indexed = listJobs(cwd).find((job) => job.id === jobId);
    if (indexed?.status === "queued") upsertJob(cwd, { id: jobId, pid, pidIdentity: identity });
  });
}
export function resolveJobPid(cwd, job) {
  if (job?.pid != null) return { pid: job.pid, identity: job.pidIdentity ?? null };
  if (job?.status !== "queued" && job?.status !== "running") return { pid: null, identity: null };
  return readJobPidSidecar(cwd, job.id) ?? { pid: null, identity: null };
}
```

Ticket lock (posix only): в записи владельца добавить `identity: process.platform === "win32" ? null : getProcessIdentity(process.pid)`; в `judgeLockEntry` после `alive === true`: `if (owner.identity) { const actual = getProcessIdentity(owner.pid); if (actual && actual !== owner.identity) return LOCK_ENTRY_ABANDONED; }` — `// ponytail: win32 lock entries stay PID-liveness only`.

- [ ] **Step 5: Implement `tracked-jobs.mjs`, `codex-companion.mjs`, `broker-lifecycle.mjs`, `session-lifecycle-hook.mjs`.**

`runTrackedJob`: рядом с `pid: process.pid` → `pidIdentity: getProcessIdentity(process.pid)`; каждое `pid: null` → `pidIdentity: null`. `reapDeadJobs`:

```js
    const { pid, identity } = resolveJobPid(workspaceRoot, job);
    if (isPidAlive(pid) === false || isQueuedWithoutWorker(job, pid)) {
      return markJobDead(workspaceRoot, job, DEAD_WORKER_MESSAGE, waitFor());
    }
    if (pid && identity) {
      let actual = null;
      try { actual = (options.getProcessIdentityImpl ?? getProcessIdentity)(pid, { timeoutMs: Math.min(2000, remainingMs ? Math.max(0, remainingMs()) : 2000) }); }
      catch { actual = null; }
      if (actual && actual !== identity) {
        return markJobDead(workspaceRoot, job, `${DEAD_WORKER_MESSAGE} (worker pid ${pid} reused by another process)`, waitFor());
      }
    }
    return job;
```

(`markJobDead` должен положить причину в `errorMessage`; проверить сигнатуру — если она принимает только message, текст `pid reused` попадёт в `errorMessage` через неё.)

`enqueueBackgroundTask`: `updateJobPid(job.workspaceRoot, job.id, child.pid, getProcessIdentity(child.pid))`. `handleCancel`:

```js
  const { pid, identity } = resolveJobPid(workspaceRoot, job);
  const kill = terminateRecordedProcess(pid, { identity, commandLineMatch: new RegExp(`task-worker.*--job-id ${job.id}(\\s|$)`) });
  if (pid && !kill.attempted) {
    appendLogLine(job.logFile, `worker pid ${pid} left running: ${kill.reason}`);
  }
  ... // payload/rendered: добавить строку `worker pid ${pid} left running: ${kill.reason}` когда !kill.attempted
```

`ensureBrokerSession`: `pidIdentity: getProcessIdentity(child.pid)` в сохраняемую сессию; `teardownBrokerSession({ ..., pidIdentity = null })`: заменить блок kill на `const outcome = terminateRecordedProcess(pid, { identity: pidIdentity, commandLineMatch: (line) => line.includes("app-server-broker.mjs") && (!endpoint || line.includes(endpoint)), timeoutMs, killImpl: killProcess ? (p) => killProcess(p) : undefined })` и вернуть `{ signalled: outcome.attempted && outcome.delivered, reason: outcome.reason }`. Внимание: `killProcess` в хуке = `terminateProcessTree` (принимает pid) — `killImpl` в `terminateProcessTree` ожидает сигнатуру `process.kill`; поэтому в `terminateRecordedProcess` добавить опцию `terminateImpl` (default `terminateProcessTree`) и в teardown передавать `terminateImpl: killProcess`.

`session-lifecycle-hook.mjs`: `teardownBrokerSession({ ..., pidIdentity: brokerSession?.pidIdentity ?? null, ... })`; строка решения: `signalled=${teardown.signalled} reason=${teardown.reason}`. `cleanupSessionJobs`: `const { pid, identity } = resolveJobPid(workspaceRoot, job); terminateRecordedProcess(pid, { identity, commandLineMatch: new RegExp(\`task-worker.*--job-id ${job.id}(\\s|$)\`), timeoutMs: Math.min(2000, lockWaitMs ?? 2000) })`.

- [ ] **Step 6: Run** → PASS; полный гейт; `sleep 10; pgrep -f codex-plugin-test-` = 0.
- [ ] **Step 7: Commit** `fix(process): identity-checked kills and reaping on posix; identity in pid sidecar, job records and broker.json`.

---

### Task 10: Release v1.3.0

**Files:** `package.json`, `package-lock.json`, `plugins/codex/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (через `scripts/bump-version.mjs`), `CHANGELOG.md`, `plugins/codex/CHANGELOG.md`, `README.md`, `docs/superpowers/triage/2026-09-27-upstream-triage.md` (статусы `fixed-in v1.3.0`).

- [ ] **Step 1:** `node scripts/bump-version.mjs 1.3.0 && npm run check-version`.
- [ ] **Step 2:** CHANGELOG `## 1.3.0 (2026-MM-DD)` — по одному bullet на задачу с upstream-номерами (формат как в 1.2.0); `plugins/codex/CHANGELOG.md` синхронизировать с корневым (скопировать секцию 1.3.0 и предыдущие, чтобы файл перестал быть «1.0.0»).
- [ ] **Step 3:** Полный гейт + `claude plugin validate . --strict` + `npm audit --omit=dev` + `npm pack --dry-run`.
- [ ] **Step 4:** Claude code review (pr-review-toolkit: code-reviewer, silent-failure-hunter, pr-test-analyzer) по `git diff main...release/v1.3.0`; исправить блокеры.
- [ ] **Step 5:** `/codex:adversarial-review --base main --effort max` из установленного плагина на `main` (worktree `release/v1.3.0` как `--cwd`); DO-NOT-SHIP → исправить и повторить.
- [ ] **Step 6:** Ручной smoke в свежей сессии Claude Code после `claude plugin update`: `/codex:status`, `/codex:rescue --effort low Strictly read-only: reply PONG`, `/codex:review --background` → `/codex:result`, `/codex:setup --review-gate-model spark`.
- [ ] **Step 7:** По команде пользователя: push, PR `release/v1.3.0 → main`, merge, tag `v1.3.0`, `gh release create` по `docs/RELEASING.md`; черновик `docs/superpowers/triage/upstream-comments-v1.3.0.md` → одобрение → `gh issue comment`.

## Self-review (выполнено при написании)

- Spec coverage: пункты 1–8 v1.3.0 спека → Task 1–8; пункт identity → Task 9; release → Task 10. #750 («already imported») намеренно оставлен на v1.5.0 (в спеке «часть в v1.5.0»).
- Placeholder scan: нет TBD/TODO; каждый код-шаг содержит код.
- Type consistency: `resolveJobPid` везде возвращает `{ pid, identity }`; `terminateRecordedProcess` → `{ attempted, delivered, reason }`; `teardownBrokerSession` → `{ signalled, reason }`; `loadModelCatalog` → массив `{ slug, visibility, priority, efforts }`.
- Review Focus: 1 → Task 1 (`error-notification-retry`), 2 → Task 2, 3 → Task 4 (третий тест), 4 → Task 3, 5 → Task 8 (второй тест).
