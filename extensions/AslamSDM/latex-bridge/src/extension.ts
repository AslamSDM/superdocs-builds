import * as vscode from "vscode";
import { SuperDocsClient } from "./core/client";
import { BridgeSession, sessionIdFor } from "./core/session";
import { findLaTeXRoot, buildProjectZip, ProjectInfo } from "./core/zip";
import { writeBackToProject } from "./core/writeback-cli";
import { parseDocxTrackChanges, toChange } from "./core/trackchanges";
import { initKeyStorage, getKey, setKey, clearKey } from "./keychain";
import { webviewPanel } from "./webview/panel";

interface PersistedState {
  projectDir?: string;
  sessionId?: string;
}

export function activate(context: vscode.ExtensionContext): void {
  initKeyStorage(context.secrets);
  const state: PersistedState = {
    projectDir: context.workspaceState.get("latexBridge.projectDir"),
    sessionId: context.workspaceState.get("latexBridge.sessionId"),
  };

  let activeSession: BridgeSession | undefined;
  let client: SuperDocsClient | undefined;

  async function makeClient(): Promise<SuperDocsClient | undefined> {
    const key = await getKey();
    if (!key) {
      const entered = await vscode.window.showInputBox({
        prompt: "Enter your SuperDocs API key (sk_...) — stored in VS Code secret storage",
        password: true,
      });
      if (!entered) return undefined;
      await setKey(entered);
      return new SuperDocsClient(entered, {
        pollIntervalMs: vscode.workspace.getConfiguration("latexBridge").get("pollIntervalMs", 2000),
      });
    }
    return new SuperDocsClient(key, {
      pollIntervalMs: vscode.workspace.getConfiguration("latexBridge").get("pollIntervalMs", 2000),
    });
  }

  async function openPanel(): Promise<void> {
    if (!client) client = await makeClient();
    if (!client) return;
    const panel = webviewPanel(context);
    panel.ready(client, {
      onOpenProject: async () => {
        const dir = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: "Select your LaTeX project folder (Overleaf export shape)",
        });
        return dir?.[0]?.fsPath;
      },
      onOpenSession: (sessionId: string) => {
        state.sessionId = sessionId;
        context.workspaceState.update("latexBridge.sessionId", sessionId);
      },
      onSubmitDecisions: (decisions) => {
        if (!activeSession) return;
        activeSession.submitDecisions(decisions);
      },
      onCreateSession: async (projectDir: string) => {
        const root = findLaTeXRoot(projectDir);
        if (!root) {
          throw new Error(
            "No LaTeX document root found. Pick the project folder that directly contains the .tex file with \\documentclass and \\begin{document} (e.g. samples/math-paper, not samples)."
          );
        }
        const proj: ProjectInfo = await buildProjectZip(projectDir, root);
        const sid = sessionIdFor(root);
        const session = new BridgeSession(client!, sid, {
          opBudget: vscode.workspace.getConfiguration("latexBridge").get("opBudgetPerSession", 10),
          pollIntervalMs: vscode.workspace.getConfiguration("latexBridge").get("pollIntervalMs", 2000),
        }, (e) => panel.emit("sessionEvent", e));
        activeSession = session;
        state.sessionId = sid;
        context.workspaceState.update("latexBridge.projectDir", projectDir);
        context.workspaceState.update("latexBridge.sessionId", sid);
        const info = await session.uploadProject(proj.zipBytes, `${root.replace(/\.tex$/, "")}.zip`, "application/zip");
        return { sessionId: info.sessionId, chunksCount: info.chunksCount ?? 0, warnings: info.warnings };
      },
      onRequestEdit: async (message: string) => {
        if (!activeSession) throw new Error("No active session — upload a project first.");
        const job = await activeSession.requestEdit(message);
        return { response: job.result?.response ?? "", updatedHtml: job.result?.document_changes?.updated_html ?? "" };
      },
      onExportDocx: async (filename: string) => {
        if (!activeSession || !state.sessionId) throw new Error("No active session — upload a project first.");
        const result = await client!.exportDocx(state.sessionId, { paper_size: "A4" });
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(filename || "document.docx"),
          filters: { "Word Document": ["docx"] },
        });
        if (!uri) return { saved: false, warnings: result.warnings };
        await vscode.workspace.fs.writeFile(uri, result.body);
        return { saved: true, path: uri.fsPath, warnings: result.warnings };
      },
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("latex-bridge.open", openPanel),
    vscode.commands.registerCommand("latex-bridge.uploadProject", async () => {
      const dir = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: "Select your LaTeX project folder",
      });
      if (!dir?.[0]) return;
      const root = findLaTeXRoot(dir[0].fsPath);
      if (!root) {
        vscode.window.showErrorMessage("LaTeX Bridge: no LaTeX root found in this folder.");
        return;
      }
      const proj = await buildProjectZip(dir[0].fsPath, root);
      client = await makeClient();
      if (!client) return;
      const sid = sessionIdFor(root);
      activeSession = new BridgeSession(client, sid, {
        opBudget: vscode.workspace.getConfiguration("latexBridge").get("opBudgetPerSession", 10),
        pollIntervalMs: vscode.workspace.getConfiguration("latexBridge").get("pollIntervalMs", 2000),
      }, () => {});
      const info = await activeSession.uploadProject(
        proj.zipBytes,
        `${root.replace(/\.tex$/, "")}.zip`,
        "application/zip"
      );
      vscode.window.showInformationMessage(
        `LaTeX Bridge: project parsed into ${info.chunksCount} editable sections.`
      );
    }),
    vscode.commands.registerCommand("latex-bridge.exportDocx", async () => {
      if (!client || !state.sessionId) {
        vscode.window.showErrorMessage("LaTeX Bridge: no active session.");
        return;
      }
      const result = await client.exportDocx(state.sessionId, { paper_size: "A4" });
      const uri = await vscode.window.showSaveDialog({
        filters: { "Word Document": ["docx"] },
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, result.body);
      vscode.window.showInformationMessage(`LaTeX Bridge: exported ${uri.fsPath}`);
    }),
    vscode.commands.registerCommand("latex-bridge.writeBack", async () => {
      if (!activeSession) {
        vscode.window.showErrorMessage("LaTeX Bridge: no active session.");
        return;
      }
      const changes = activeSession.approvedChanges;
      if (changes.length === 0) {
        vscode.window.showInformationMessage("LaTeX Bridge: no approved edits to write back yet.");
        return;
      }
      const dir = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: "Select the LaTeX project folder to patch",
      });
      if (!dir?.[0]) return;
      const root = findLaTeXRoot(dir[0].fsPath);
      if (!root) return;
      const result = await writeBackToProject(
        dir[0].fsPath,
        root,
        changes.map((c) => ({
          change_id: c.change_id,
          chunk_id: c.chunk_id,
          operation: c.operation,
          old_html: c.old_html,
          new_html: c.new_html,
        }))
      );
      let patched = 0;
      for (const [file, content] of result.files) {
        const target = vscode.Uri.joinPath(vscode.Uri.file(dir[0].fsPath), file);
        await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
        patched += 1;
      }
      const summary =
        `LaTeX Bridge: applied ${result.applied.length}/${changes.length} approved edits across ${patched} file(s)` +
        (result.unresolved.length > 0 ? `; ${result.unresolved.length} could not be located` : "");
      if (result.unresolved.length > 0) {
        vscode.window.showWarningMessage(summary);
      } else {
        vscode.window.showInformationMessage(summary);
      }
    }),
    vscode.commands.registerCommand("latex-bridge.importTrackChanges", async () => {
      const docxUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: "Select the co-author's .docx (with tracked changes)",
        filters: { "Word Document": ["docx"] },
      });
      if (!docxUri?.[0]) return;
      const bytes = await vscode.workspace.fs.readFile(docxUri[0]);
      const changes = await parseDocxTrackChanges(new Uint8Array(bytes));
      if (changes.length === 0) {
        vscode.window.showInformationMessage("LaTeX Bridge: no tracked changes found in this document.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        changes.map((c, i) => ({
          label: `${c.id} — ${c.author}`,
          description: c.date ?? "",
          detail: c.oldText
            ? `${c.oldText.slice(0, 120)} → ${c.newText.slice(0, 120)}`
            : `insert: ${c.newText.slice(0, 120)}`,
          change: c,
          index: i,
        })),
        {
          canPickMany: true,
          placeHolder: "Select tracked changes to apply to the LaTeX project",
        }
      );
      if (!picked || picked.length === 0) return;
      const dir = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: "Select the LaTeX project folder to patch",
      });
      if (!dir?.[0]) return;
      const root = findLaTeXRoot(dir[0].fsPath);
      if (!root) return;
      const result = await writeBackToProject(
        dir[0].fsPath,
        root,
        picked.map((p) => toChange(p.change))
      );
      let patched = 0;
      for (const [file, content] of result.files) {
        const target = vscode.Uri.joinPath(vscode.Uri.file(dir[0].fsPath), file);
        await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
        patched += 1;
      }
      const summary =
        `LaTeX Bridge: applied ${result.applied.length}/${picked.length} tracked changes across ${patched} file(s)` +
        (result.unresolved.length > 0 ? `; ${result.unresolved.length} could not be located` : "");
      if (result.unresolved.length > 0) {
        vscode.window.showWarningMessage(summary);
      } else {
        vscode.window.showInformationMessage(summary);
      }
    }),
    vscode.commands.registerCommand("latex-bridge.setKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: "SuperDocs API key (sk_...)",
        password: true,
      });
      if (key) {
        await setKey(key);
        vscode.window.showInformationMessage("LaTeX Bridge: API key stored.");
      }
    }),
    vscode.commands.registerCommand("latex-bridge.clearKey", async () => {
      await clearKey();
      vscode.window.showInformationMessage("LaTeX Bridge: API key removed.");
    })
  );

  context.subscriptions.push({
    dispose: () => {
      /* sessions are server-side; nothing to tear down locally */
    },
  });
}

export function deactivate(): void {
  /* no-op */
}
