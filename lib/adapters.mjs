import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import fs from "node:fs";
import { instructions, REPLY_SCHEMA } from "./core.mjs";

const TURN_TIMEOUT = 240_000;

export function codexExecutable() {
  if (process.env.SEMAPHORE_CODEX_BIN) return process.env.SEMAPHORE_CODEX_BIN;
  // Keep the provider compatible with the user's desktop app without changing
  // their globally installed CLI. Other platforms use the CLI on PATH.
  if (process.platform === "darwin") {
    for (const candidate of [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ]) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return "codex";
}

function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}

export class CodexClient extends EventEmitter {
  constructor({ cwd, executable = codexExecutable() } = {}) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.child = spawn(executable, ["app-server"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.child.stderr.on("data", (data) => {
      this.stderr = (this.stderr + data).slice(-6000);
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) =>
      this.fail(
        new Error(
          `Codex app-server exited (${signal ?? code}). ${this.stderr.slice(-1200)}`,
        ),
      ),
    );
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch (error) {
        this.fail(
          new Error(`Invalid Codex protocol response: ${error.message}`),
        );
        this.close();
      }
    });
  }

  receive(message) {
    if (message.id !== undefined && message.method) {
      // Conversation-only V1 never approves execution or interactive tool requests.
      if (
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
        ].includes(message.method)
      ) {
        this.write({ id: message.id, result: { decision: "decline" } });
      } else {
        this.write({
          id: message.id,
          error: {
            code: -32601,
            message:
              "Semaphore conversation mode does not support this tool request.",
          },
        });
      }
    } else if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    } else if (message.method) this.emit("notification", message);
  }

  write(message) {
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  request(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "semaphore", title: "Semaphore", version: "0.1.0" },
    });
    this.write({ method: "initialized", params: {} });
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }

  close() {
    this.fail(new Error("Codex connection closed."));
    this.child.stdin.end();
    stopProcess(this.child);
  }
}

export class CodexAdapter {
  async reply({ room, participant, prompt, workspace, signal, onSession }) {
    const client = new CodexClient({ cwd: workspace });
    let threadId = participant.id;
    let turnId;
    let abortTimer;
    const abort = () => {
      if (threadId && turnId && !client.failure) {
        client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
        abortTimer = setTimeout(() => client.close(), 1500);
      } else client.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await client.initialize();
      const params = {
        model: participant.model,
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions: instructions("astra"),
        config: { web_search: "disabled" },
      };
      const response = threadId
        ? await client.request("thread/resume", { ...params, threadId })
        : await client.request("thread/start", params);
      threadId = response.thread.id;
      if (participant.id && participant.id !== threadId)
        throw new Error("Codex resumed a different conversation.");
      onSession({
        id: threadId,
        actualModel: response.model ?? participant.model,
      });
      await client.request("thread/name/set", {
        threadId,
        name: `Semaphore · ${room.name} · GPT`,
      });
      signal.throwIfAborted();
      return await new Promise((resolve, reject) => {
        const messages = new Map();
        let finished = false;
        const finish = (error, value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          client.off("notification", notify);
          client.off("closed", closed);
          if (error) reject(error);
          else resolve(value);
        };
        const timer = setTimeout(() => {
          finish(new Error("GPT took too long to respond."));
          abort();
        }, TURN_TIMEOUT);
        const closed = (error) =>
          finish(signal.aborted ? signal.reason : error);
        const notify = ({ method, params: event }) => {
          if (event.threadId !== threadId) return;
          if (method === "turn/started") turnId = event.turn.id;
          if (turnId && event.turnId && event.turnId !== turnId) return;
          if (
            method === "item/completed" &&
            event.item.type === "agentMessage"
          ) {
            messages.set(event.item.id, event.item.text);
          }
          if (method === "turn/completed") {
            if (turnId && event.turn.id !== turnId) return;
            if (signal.aborted) return finish(signal.reason);
            if (event.turn.status !== "completed") {
              return finish(
                new Error(
                  event.turn.error?.message ??
                    `GPT turn ${event.turn.status}.`,
                ),
              );
            }
            const text = [...messages.values()].at(-1);
            if (!text)
              return finish(new Error("GPT finished without a message."));
            finish(null, text);
          }
        };
        client.on("notification", notify);
        client.on("closed", closed);
        client
          .request("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt }],
            model: participant.model,
            effort: "medium",
            outputSchema: REPLY_SCHEMA,
          })
          .then((result) => {
            turnId = result.turn.id;
            if (signal.aborted) abort();
          })
          .catch((error) => finish(error));
      });
    } finally {
      signal.removeEventListener("abort", abort);
      clearTimeout(abortTimer);
      client.close();
    }
  }
}

export function claudeResult(event) {
  if (event.type !== "result") throw new Error("Missing Claude result event.");
  if (event.is_error || event.subtype !== "success") {
    throw new Error(
      event.result ||
        event.errors?.join("\n") ||
        `Claude failed: ${event.subtype}`,
    );
  }
  return event.structured_output ?? event.result;
}

export class ClaudeAdapter {
  async reply({ participant, prompt, workspace, signal, onSession }) {
    signal.throwIfAborted();
    const args = [
      "--print",
      "--model",
      participant.actualModel ?? participant.model,
      "--effort",
      "medium",
      "--safe-mode",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "stream-json",
      "--verbose",
      // Ask for JSON in the ordinary assistant reply. Claude's schema mode stores
      // the substantive answer in a tool event and can show only a short summary
      // when reopened interactively; ordinary replies remain visible natively.
      "--append-system-prompt",
      instructions("claude"),
      participant.started ? "--resume" : "--session-id",
      participant.id,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd: workspace,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let result;
      let stderr = "";
      let protocolError;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => {
        // SIGINT asks Claude to end its turn; the timer is only a shutdown fallback.
        child.kill("SIGINT");
        const killTimer = setTimeout(() => stopProcess(child), 1500);
        killTimer.unref();
        child.once("exit", () => clearTimeout(killTimer));
      };
      const timer = setTimeout(() => {
        protocolError = new Error("Claude took too long to respond.");
        abort();
      }, TURN_TIMEOUT);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.on("error", (error) => finish(error));
      child.stdin.on("error", (error) => {
        protocolError ??= error;
      });
      child.stderr.on("data", (data) => {
        stderr = (stderr + data).slice(-6000);
      });
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.session_id && event.session_id !== participant.id)
            throw new Error("Claude returned a different session ID.");
          if (event.type === "system" && event.subtype === "init") {
            onSession({ started: true, actualModel: event.model });
          }
          if (event.type === "result") result = event;
        } catch (error) {
          protocolError = error;
          stopProcess(child);
        }
      });
      child.on("close", (code) => {
        if (signal.aborted) return finish(signal.reason);
        if (protocolError) return finish(protocolError);
        if (!result)
          return finish(
            new Error(`Claude exited (${code}) without a response. ${stderr}`),
          );
        try {
          const reply = claudeResult(result);
          if (code !== 0) throw new Error(`Claude exited (${code}). ${stderr}`);
          onSession({ started: true });
          finish(null, reply);
        } catch (error) {
          finish(error);
        }
      });
      child.stdin.end(prompt);
    });
  }
}
