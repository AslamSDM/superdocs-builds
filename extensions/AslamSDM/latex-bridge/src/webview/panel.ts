import * as vscode from "vscode";
import { SuperDocsClient } from "../core/client";
import { IngestWarning, ProposedChange, ExportWarning } from "../core/types";

export interface PanelHandlers {
  onOpenProject: () => Promise<string | undefined>;
  onOpenSession: (sessionId: string) => void;
  onCreateSession: (projectDir: string) => Promise<{
    sessionId: string;
    chunksCount: number;
    warnings: IngestWarning[];
  }>;
  onRequestEdit: (message: string) => Promise<{
    response: string;
    updatedHtml: string;
  }>;
  onExportDocx: (filename: string) => Promise<{
    saved: boolean;
    path?: string;
    warnings: ExportWarning[];
  }>;
  onSubmitDecisions: (decisions: { changeId: string; approved: boolean }[]) => void;
}

interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

export function webviewPanel(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    "latexBridge",
    "LaTeX Bridge",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    }
  );

  const media = vscode.Uri.joinPath(context.extensionUri, "dist", "media");
  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; img-src ${panel.webview.cspSource} https: data:; script-src ${panel.webview.cspSource};">
<link rel="stylesheet" href="${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "app.css"))}">
</head>
<body>
<div id="root"></div>
<script src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "webview", "app.js"))}"></script>
</body>
</html>`;

  let handlers: PanelHandlers | undefined;
  let client: SuperDocsClient | undefined;

  panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
    if (!handlers) return;
    try {
      switch (msg.type) {
        case "openProject": {
          const dir = await handlers.onOpenProject();
          post({ type: "projectOpened", path: dir ?? null });
          break;
        }
        case "createSession": {
          const dir = msg.projectDir as string;
          const info = await handlers.onCreateSession(dir);
          post({ type: "sessionCreated", ...info });
          break;
        }
        case "openSession": {
          handlers.onOpenSession(msg.sessionId as string);
          post({ type: "sessionOpened", sessionId: msg.sessionId });
          break;
        }
        case "requestEdit": {
          post({ type: "editStarted" });
          const result = await handlers.onRequestEdit(msg.message as string);
          post({ type: "editCompleted", ...result });
          break;
        }
        case "exportDocx": {
          const result = await handlers.onExportDocx((msg.filename as string) ?? "");
          post({ type: "exportCompleted", ...result });
          break;
        }
        case "submitDecisions": {
          handlers.onSubmitDecisions((msg.decisions as { changeId: string; approved: boolean }[]) ?? []);
          post({ type: "decisionsSubmitted" });
          break;
        }
        default:
          break;
      }
    } catch (err) {
      post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  });

  function post(message: unknown): void {
    void panel.webview.postMessage(message);
  }

  return {
    ready(c: SuperDocsClient, h: PanelHandlers) {
      client = c;
      handlers = h;
      post({ type: "ready", sessionId: "" });
    },
    emit(type: string, payload: unknown): void {
      post({ type, ...(payload as Record<string, unknown>) });
    },
    dispose: () => panel.dispose(),
  };
}
