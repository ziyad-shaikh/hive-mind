
module.exports = {
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
    window: {
        createWebviewPanel: () => ({
            webview: { html: '', onDidReceiveMessage: () => ({ dispose() {} }) },
            onDidDispose: () => ({ dispose() {} }),
            reveal: () => {},
        }),
        showTextDocument: () => Promise.resolve(),
    },
    ViewColumn: { Beside: 'beside' },
    workspace: {},
};
