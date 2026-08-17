import * as React from "react";
import { createRoot } from "react-dom/client";

declare function acquireVsCodeApi(): {
  postMessage: (msg: Record<string, unknown>) => void;
  getState: () => Record<string, unknown> | undefined;
  setState: (s: Record<string, unknown>) => void;
};

interface Change {
  change_id: string;
  operation: string;
  chunk_id: string;
  old_html: string;
  new_html: string;
  ai_explanation?: string;
  decision?: boolean | null;
}

interface Warning {
  code: string;
  message: string;
}

interface UiState {
  phase:
    | "ready"
    | "uploading"
    | "uploaded"
    | "editing"
    | "awaiting"
    | "completed"
    | "exporting"
    | "error";
  sessionId: string;
  projectDir: string | null;
  chunksCount: number;
  ingestWarnings: Warning[];
  exportWarnings: Warning[];
  changes: Change[];
  response: string;
  message: string;
  exportPath: string | null;
}

const vscode = acquireVsCodeApi();

function renderHtml(text: string): string {
  return text;
}

function App() {
  const [state, setState] = React.useState<UiState>({
    phase: "ready",
    sessionId: "",
    projectDir: null,
    chunksCount: 0,
    ingestWarnings: [],
    exportWarnings: [],
    changes: [],
    response: "",
    message: "",
    exportPath: null,
  });

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown>;
      switch (msg.type) {
        case "ready":
          setState((s) => ({ ...s, phase: "ready" }));
          break;
        case "projectOpened":
          setState((s) => ({ ...s, projectDir: (msg.path as string) ?? null }));
          break;
        case "sessionCreated": {
          const changes = ((msg.changes ?? []) as Record<string, unknown>[]).map((c) => ({
            change_id: c.change_id as string,
            operation: c.operation as string,
            chunk_id: c.chunk_id as string,
            old_html: c.old_html as string,
            new_html: c.new_html as string,
            ai_explanation: (c.ai_explanation as string) ?? "",
            decision: null,
          }));
          setState((s) => ({
            ...s,
            phase: "uploaded",
            sessionId: msg.sessionId as string,
            chunksCount: msg.chunksCount as number,
            ingestWarnings: (msg.warnings as Warning[]) ?? [],
            changes,
          }));
          break;
        }
        case "sessionOpened":
          setState((s) => ({ ...s, sessionId: msg.sessionId as string }));
          break;
        case "sessionEvent": {
          const evt = msg as unknown as {
            type: string;
            stage?: string;
            jobId?: string;
            changes?: Change[];
            warnings?: Warning[];
          };
          if (evt.type === "uploaded") {
            setState((s) => ({ ...s, phase: evt.stage === "parsed" ? "uploaded" : "uploading" }));
          } else if (evt.type === "awaiting_approval") {
            const incoming = (evt.changes ?? []).map((c) => ({ ...c, decision: null }));
            setState((s) => ({ ...s, phase: "awaiting", changes: incoming }));
          } else if (evt.type === "completed") {
            setState((s) => ({ ...s, phase: "completed" }));
          }
          break;
        }
        case "editStarted":
          setState((s) => ({ ...s, phase: "editing", message: "AI is drafting edits..." }));
          break;
        case "editCompleted": {
          const changes = ((msg.changes ?? []) as Record<string, unknown>[]).map((c) => ({
            change_id: c.change_id as string,
            operation: c.operation as string,
            chunk_id: c.chunk_id as string,
            old_html: c.old_html as string,
            new_html: c.new_html as string,
            ai_explanation: (c.ai_explanation as string) ?? "",
            decision: null,
          }));
          setState((s) => ({
            ...s,
            phase: "completed",
            response: (msg.response as string) ?? "",
            changes,
          }));
          break;
        }
        case "exportCompleted":
          setState((s) => ({
            ...s,
            phase: "completed",
            exportWarnings: (msg.warnings as Warning[]) ?? [],
            exportPath: (msg.path as string) ?? null,
          }));
          break;
        case "error":
          setState((s) => ({ ...s, phase: "error", message: (msg.message as string) ?? "Unknown error" }));
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const openProject = () => vscode.postMessage({ type: "openProject" });
  const createSession = () =>
    vscode.postMessage({ type: "createSession", projectDir: state.projectDir });
  const requestEdit = (message: string) =>
    vscode.postMessage({ type: "requestEdit", message });
  const exportDocx = () => vscode.postMessage({ type: "exportDocx", filename: "" });
  const decide = (changeId: string, approved: boolean) =>
    setState((s) => ({
      ...s,
      changes: s.changes.map((c) =>
        c.change_id === changeId ? { ...c, decision: approved } : c
      ),
    }));
  const submitDecisions = () => {
    const decisions = state.changes
      .filter((c) => c.decision !== null)
      .map((c) => ({ changeId: c.change_id, approved: !!c.decision }));
    vscode.postMessage({ type: "submitDecisions", decisions });
  };

  const [prompt, setPrompt] = React.useState("");

  return (
    <div className="app">
      <header>
        <h1>LaTeX Bridge</h1>
        <div className="badges">
          {state.sessionId && <span className="badge">session {state.sessionId.slice(0, 24)}</span>}
          {state.chunksCount > 0 && <span className="badge">{state.chunksCount} sections</span>}
          <span className={`badge phase-${state.phase}`}>{state.phase}</span>
        </div>
      </header>

      {state.ingestWarnings.length > 0 && (
        <section className="warnings">
          <h2>Ingest warnings</h2>
          {state.ingestWarnings.map((w, i) => (
            <div key={i} className="warning">
              <code>{w.code}</code> — {w.message}
            </div>
          ))}
        </section>
      )}

      <section className="project">
        <h2>1 · Project</h2>
        <div className="row">
          <input
            readOnly
            placeholder="Select your LaTeX project folder (main.tex + sections + figures + .bib)"
            value={state.projectDir ?? ""}
            onClick={openProject}
          />
          <button onClick={openProject}>Browse…</button>
        </div>
        <button disabled={!state.projectDir || state.phase === "uploading"} onClick={createSession}>
          Upload to SuperDocs
        </button>
      </section>

      <section className="chat">
        <h2>2 · Edit instruction</h2>
        <textarea
          placeholder="Describe the edit — e.g. 'Tighten the abstract to two sentences and mention that the generating set is symmetric and identity-free.'"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
        />
        <button disabled={!prompt || state.phase === "editing"} onClick={() => requestEdit(prompt)}>
          Send edit (HITL review)
        </button>
      </section>

      {state.phase === "awaiting" && state.changes.length > 0 && (
        <section className="review">
          <h2>3 · Review proposed changes</h2>
          {state.changes.map((c) => (
            <div key={c.change_id} className="card">
              <div className="card-head">
                <span>{c.operation} · {c.chunk_id.slice(0, 8)}</span>
                {c.ai_explanation && <div className="explain">{c.ai_explanation}</div>}
              </div>
              <div className="diff">
                <div className="diff-old" dangerouslySetInnerHTML={{ __html: renderHtml(c.old_html) }} />
                <div className="arrow">→</div>
                <div className="diff-new" dangerouslySetInnerHTML={{ __html: renderHtml(c.new_html) }} />
              </div>
              <div className="decide">
                <button
                  className={c.decision === true ? "accepted" : ""}
                  onClick={() => decide(c.change_id, true)}
                >
                  Accept
                </button>
                <button
                  className={c.decision === false ? "denied" : ""}
                  onClick={() => decide(c.change_id, false)}
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
          <button
            className="submit"
            disabled={!state.changes.some((c) => c.decision !== null)}
            onClick={submitDecisions}
          >
            Submit decisions
          </button>
        </section>
      )}

      {state.phase === "completed" && state.response && (
        <section className="result">
          <h2>AI response</h2>
          <p>{state.response}</p>
        </section>
      )}

      {state.exportWarnings.length > 0 && (
        <section className="warnings">
          <h2>Export warnings</h2>
          {state.exportWarnings.map((w, i) => (
            <div key={i} className="warning">
              <code>{w.code}</code> — {w.message}
            </div>
          ))}
        </section>
      )}

      <section className="export">
        <h2>4 · Export</h2>
        <button disabled={!state.sessionId} onClick={exportDocx}>
          Export .docx (A4)
        </button>
        {state.exportPath && <p className="ok">Saved to {state.exportPath}</p>}
      </section>

      {state.phase === "error" && (
        <section className="warnings">
          <h2>Error</h2>
          <div className="warning">{state.message}</div>
        </section>
      )}
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
