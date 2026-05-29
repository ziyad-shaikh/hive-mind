import * as https from 'https';
import * as vscode from 'vscode';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Types — GitHub Code Scanning Alerts
// ---------------------------------------------------------------------------

export interface CodeScanningAlert {
    number: number;
    state: string;
    rule: { id: string; severity: string; description: string; };
    most_recent_instance: {
        location: {
            path: string;
            start_line: number;
            end_line: number;
        };
        message: { text: string; };
        state: string;
    };
    tool: { name: string; version: string | null; };
    html_url: string;
    created_at: string;
}

// ---------------------------------------------------------------------------
// Types — GitHub Actions
// ---------------------------------------------------------------------------

export interface WorkflowRun {
    id: number;
    name: string;
    head_branch: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    created_at: string;
    workflow_id: number;
}

export interface CheckAnnotation {
    path: string;
    start_line: number;
    end_line: number;
    annotation_level: 'notice' | 'warning' | 'failure';
    message: string;
    title: string;
    raw_details?: string;
}

export interface CheckRun {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    output: {
        title: string | null;
        summary: string | null;
        annotations_count: number;
    };
}

// ---------------------------------------------------------------------------
// GitHubClient — thin wrapper over GitHub REST API using vscode.authentication
// ---------------------------------------------------------------------------

export class GitHubClient {
    private owner: string | null = null;
    private repo: string | null = null;
    private workspaceRoot: string | undefined;

    constructor() {
        this.workspaceRoot = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath;
        this.detectRepo();
    }

    // -----------------------------------------------------------------------
    // Repository detection
    // -----------------------------------------------------------------------

    private detectRepo(): void {
        if (!this.workspaceRoot) { return; }
        try {
            const remoteUrl = execSync('git remote get-url origin', {
                cwd: this.workspaceRoot,
                encoding: 'utf8',
                timeout: 5000,
            }).trim();
            const parsed = this.parseGitHubUrl(remoteUrl);
            if (parsed) {
                this.owner = parsed.owner;
                this.repo = parsed.repo;
            }
        } catch {
            // Not a git repo or no remote
        }
    }

    private parseGitHubUrl(url: string): { owner: string; repo: string } | null {
        // HTTPS: https://github.com/owner/repo.git
        const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
        if (httpsMatch) {
            return { owner: httpsMatch[1], repo: httpsMatch[2] };
        }
        // SSH: git@github.com:owner/repo.git
        const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/i);
        if (sshMatch) {
            return { owner: sshMatch[1], repo: sshMatch[2] };
        }
        return null;
    }

    getOwner(): string | null { return this.owner; }
    getRepo(): string | null { return this.repo; }
    isAvailable(): boolean { return this.owner !== null && this.repo !== null; }

    // -----------------------------------------------------------------------
    // Authentication
    // -----------------------------------------------------------------------

    private async getToken(): Promise<string | null> {
        try {
            const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
            return session?.accessToken ?? null;
        } catch {
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // HTTP helper
    // -----------------------------------------------------------------------

    private request(token: string, method: string, apiPath: string, params?: Record<string, string | number>): Promise<unknown> {
        return new Promise((resolve, reject) => {
            let fullPath = `/repos/${this.owner}/${this.repo}${apiPath}`;
            if (params) {
                const qs = Object.entries(params)
                    .filter(([, v]) => v !== undefined && v !== '')
                    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
                    .join('&');
                if (qs) { fullPath += `?${qs}`; }
            }

            const options: https.RequestOptions = {
                hostname: 'api.github.com',
                path: fullPath,
                method,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                    'User-Agent': 'HiveMind-VSCode-Extension',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try { resolve(JSON.parse(body)); }
                        catch { resolve(body); }
                    } else {
                        reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 300)}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('GitHub API timeout')); });
            req.end();
        });
    }

    // -----------------------------------------------------------------------
    // Code Scanning Alerts (CodeQL)
    // -----------------------------------------------------------------------

    async getCodeScanningAlerts(options?: {
        state?: 'open' | 'closed' | 'dismissed';
        severity?: string;
        toolName?: string;
        ref?: string;
        perPage?: number;
    }): Promise<{ alerts: CodeScanningAlert[]; error?: string }> {
        if (!this.isAvailable()) {
            return { alerts: [], error: 'GitHub repo not detected (no git remote origin pointing to github.com).' };
        }
        const token = await this.getToken();
        if (!token) {
            return { alerts: [], error: 'GitHub authentication not available. Sign in via VS Code\'s GitHub account (Accounts menu in the sidebar).' };
        }

        const params: Record<string, string | number> = {
            state: options?.state ?? 'open',
            per_page: options?.perPage ?? 100,
        };
        if (options?.toolName) { params['tool_name'] = options.toolName; }
        if (options?.ref) { params['ref'] = options.ref; }

        try {
            const data = await this.request(token, 'GET', '/code-scanning/alerts', params) as CodeScanningAlert[];
            let results = data;
            if (options?.severity) {
                const sev = options.severity.toLowerCase();
                results = results.filter(a =>
                    a.rule.severity?.toLowerCase() === sev ||
                    a.most_recent_instance.state?.toLowerCase() === sev
                );
            }
            return { alerts: results };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes('403')) {
                return { alerts: [], error: 'Code scanning API returned 403. Ensure the repo has code scanning enabled and your token has `security_events` scope.' };
            }
            if (msg.includes('404')) {
                return { alerts: [], error: 'Code scanning not enabled on this repository, or the repo was not found on GitHub.' };
            }
            return { alerts: [], error: `GitHub API error: ${msg}` };
        }
    }

    // -----------------------------------------------------------------------
    // GitHub Actions — Workflow Runs
    // -----------------------------------------------------------------------

    async getLatestWorkflowRun(options?: {
        workflowFileName?: string;
        branch?: string;
        status?: string;
    }): Promise<{ run: WorkflowRun | null; error?: string }> {
        if (!this.isAvailable()) {
            return { run: null, error: 'GitHub repo not detected.' };
        }
        const token = await this.getToken();
        if (!token) {
            return { run: null, error: 'GitHub authentication not available.' };
        }

        try {
            let apiPath: string;
            const params: Record<string, string | number> = { per_page: 1 };

            if (options?.workflowFileName) {
                apiPath = `/actions/workflows/${options.workflowFileName}/runs`;
            } else {
                apiPath = '/actions/runs';
            }
            if (options?.branch) { params['branch'] = options.branch; }
            if (options?.status) { params['status'] = options.status; }

            const data = await this.request(token, 'GET', apiPath, params) as { workflow_runs: WorkflowRun[] };
            return { run: data.workflow_runs?.[0] ?? null };
        } catch (e: unknown) {
            return { run: null, error: e instanceof Error ? e.message : String(e) };
        }
    }

    // -----------------------------------------------------------------------
    // GitHub Actions — Check Run Annotations (build warnings/errors)
    // -----------------------------------------------------------------------

    async getRunAnnotations(runId: number): Promise<{ annotations: CheckAnnotation[]; checkRuns: CheckRun[]; error?: string }> {
        if (!this.isAvailable()) {
            return { annotations: [], checkRuns: [], error: 'GitHub repo not detected.' };
        }
        const token = await this.getToken();
        if (!token) {
            return { annotations: [], checkRuns: [], error: 'GitHub authentication not available.' };
        }

        try {
            // Get check runs for this workflow run
            const checkData = await this.request(token, 'GET', `/actions/runs/${runId}/check-runs`, { per_page: 100 }) as {
                check_runs: CheckRun[];
            };

            const allAnnotations: CheckAnnotation[] = [];
            const checkRuns = checkData.check_runs ?? [];

            for (const cr of checkRuns) {
                if (cr.output.annotations_count === 0) { continue; }
                try {
                    const annData = await this.request(token, 'GET', `/check-runs/${cr.id}/annotations`, { per_page: 100 }) as CheckAnnotation[];
                    for (const ann of annData) {
                        allAnnotations.push(ann);
                    }
                } catch {
                    // Skip check runs that fail to fetch annotations
                }
            }

            return { annotations: allAnnotations, checkRuns };
        } catch (e: unknown) {
            return { annotations: [], checkRuns: [], error: e instanceof Error ? e.message : String(e) };
        }
    }

    // -----------------------------------------------------------------------
    // Convenience — get CI warnings for the latest run of a workflow
    // -----------------------------------------------------------------------

    async getCIWarnings(options?: {
        workflowFileName?: string;
        branch?: string;
    }): Promise<{
        annotations: CheckAnnotation[];
        run: WorkflowRun | null;
        checkRuns: CheckRun[];
        error?: string;
    }> {
        const runResult = await this.getLatestWorkflowRun({
            workflowFileName: options?.workflowFileName,
            branch: options?.branch,
            status: 'completed',
        });

        if (runResult.error) {
            return { annotations: [], run: null, checkRuns: [], error: runResult.error };
        }
        if (!runResult.run) {
            return { annotations: [], run: null, checkRuns: [], error: 'No completed workflow runs found.' };
        }

        const annResult = await this.getRunAnnotations(runResult.run.id);
        return {
            annotations: annResult.annotations,
            run: runResult.run,
            checkRuns: annResult.checkRuns,
            error: annResult.error,
        };
    }
}
