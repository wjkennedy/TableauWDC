const { asUser, route, storage } = require('@forge/api');
const { v4: uuidv4 } = require('uuid');

const SESSION_PREFIX = 'session:';
const AUDIT_PREFIX = 'audit:';
const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_PAGE_SIZE = 1000;

class SessionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SessionError';
    }
}

class NotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotFoundError';
    }
}

const jsonResponse = (status, payload) => ({
    statusCode: status,
    headers: {
        'content-type': 'application/json'
    },
    body: payload !== undefined ? JSON.stringify(payload) : ''
});

const parseBody = (request) => {
    if (!request.body) {
        return {};
    }

    try {
        return JSON.parse(request.body);
    } catch (error) {
        throw new Error('Invalid JSON payload');
    }
};

const extractToken = (headers) => {
    const authHeader = headers.Authorization || headers.authorization;
    if (!authHeader || typeof authHeader !== 'string') {
        return null;
    }

    const trimmed = authHeader.trim();
    if (!trimmed.toLowerCase().startsWith('bearer ')) {
        return null;
    }

    return trimmed.substring(7).trim();
};

const clampLimit = (limit) => {
    if (!limit || Number.isNaN(Number(limit))) {
        return 500;
    }

    return Math.max(1, Math.min(Number(limit), MAX_PAGE_SIZE));
};

const createSession = async (accountId, options = {}) => {
    const now = Date.now();
    const token = uuidv4();
    const session = {
        token,
        accountId,
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
        auditEnabled: !!options.auditEnabled,
        workbook: options.workbook || null
    };

    await storage.set(`${SESSION_PREFIX}${token}`, session);
    return session;
};

const getSession = async (token) => {
    const session = await storage.get(`${SESSION_PREFIX}${token}`);
    if (!session) {
        throw new SessionError('Session not found');
    }

    if (session.expiresAt && session.expiresAt <= Date.now()) {
        await storage.delete(`${SESSION_PREFIX}${token}`);
        throw new SessionError('Session expired');
    }

    return session;
};

const refreshSessionExpiry = async (session) => {
    const updated = Object.assign({}, session, { expiresAt: Date.now() + SESSION_TTL_MS });
    await storage.set(`${SESSION_PREFIX}${session.token}`, updated);
    return updated;
};

const recordAudit = async (session, event, force = false) => {
    if (!session.auditEnabled && !force) {
        return null;
    }

    const id = uuidv4();
    const auditEvent = Object.assign({
        id,
        sessionToken: session.token,
        accountId: session.accountId,
        workbook: session.workbook,
        timestamp: new Date().toISOString()
    }, event);

    await storage.set(`${AUDIT_PREFIX}${id}`, auditEvent);
    return id;
};

const requestJiraJson = async (accountId, path, init) => {
    const response = await asUser().withAccountId(accountId).requestJira(route`${path}`, init);
    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Jira API ${response.status}: ${details}`);
    }

    if (response.status === 204) {
        return null;
    }

    return response.json();
};

const fetchProjectsOptions = async (accountId) => {
    const params = new URLSearchParams();
    params.set('maxResults', '1000');
    params.set('orderBy', 'name');
    const data = await requestJiraJson(accountId, `/rest/api/3/project/search?${params.toString()}`);
    const projects = data.values || [];
    return projects.map((project) => ({
        value: project.key,
        label: `${project.name} (${project.key})`
    }));
};

const fetchIssueTypeOptions = async (accountId) => {
    const issueTypes = await requestJiraJson(accountId, '/rest/api/3/issuetype');
    return (issueTypes || []).filter((type) => !type.subtask).map((type) => ({
        value: type.id,
        label: type.name
    }));
};

const buildDatasets = async (accountId) => {
    const [projectOptions, issueTypeOptions] = await Promise.all([
        fetchProjectsOptions(accountId),
        fetchIssueTypeOptions(accountId)
    ]);

    return [
        {
            key: 'jira-issues',
            name: 'Jira issues',
            description: 'Issues and metadata the signed-in user can view.',
            pageSize: 500,
            filters: [
                {
                    id: 'projectKeys',
                    label: 'Projects',
                    type: 'multi-select',
                    options: projectOptions,
                    help: 'Leave blank to query every project you can access.'
                },
                {
                    id: 'issueTypeIds',
                    label: 'Issue types',
                    type: 'multi-select',
                    options: issueTypeOptions
                },
                {
                    id: 'updatedAfter',
                    label: 'Updated after',
                    inputType: 'datetime-local',
                    help: 'ISO-8601 timestamp. When supplied, only issues updated after this value are returned.'
                },
                {
                    id: 'jql',
                    label: 'Additional JQL',
                    placeholder: 'statusCategory != Done',
                    help: 'Optional JQL clause appended with AND to the generated filters.'
                }
            ],
            incrementalColumnId: 'updated'
        },
        {
            key: 'jira-projects',
            name: 'Jira projects',
            description: 'Projects available to the signed-in user.',
            pageSize: 200,
            filters: [
                {
                    id: 'projectKeys',
                    label: 'Projects',
                    type: 'multi-select',
                    options: projectOptions,
                    help: 'Select specific projects or leave blank to include them all.'
                }
            ]
        }
    ];
};

const buildIssueSchema = () => ({
    id: 'jira-issues',
    alias: 'Jira issues',
    description: 'Issue metadata sourced from Jira via Atlassian Forge.',
    incrementalColumnId: 'updated',
    columns: [
        { id: 'id', alias: 'Issue ID', dataType: 'string' },
        { id: 'key', alias: 'Issue key', dataType: 'string' },
        { id: 'summary', dataType: 'string' },
        { id: 'status', dataType: 'string' },
        { id: 'statusCategory', alias: 'Status category', dataType: 'string' },
        { id: 'projectKey', alias: 'Project key', dataType: 'string' },
        { id: 'projectName', alias: 'Project name', dataType: 'string' },
        { id: 'issueType', alias: 'Issue type', dataType: 'string' },
        { id: 'issueTypeId', alias: 'Issue type ID', dataType: 'string' },
        { id: 'assigneeAccountId', alias: 'Assignee accountId', dataType: 'string' },
        { id: 'assigneeDisplayName', alias: 'Assignee', dataType: 'string' },
        { id: 'reporterAccountId', alias: 'Reporter accountId', dataType: 'string' },
        { id: 'reporterDisplayName', alias: 'Reporter', dataType: 'string' },
        { id: 'created', dataType: 'datetime' },
        { id: 'updated', dataType: 'datetime' }
    ]
});

const buildProjectSchema = () => ({
    id: 'jira-projects',
    alias: 'Jira projects',
    description: 'Projects accessible to the signed-in user.',
    columns: [
        { id: 'id', alias: 'Project ID', dataType: 'string' },
        { id: 'key', alias: 'Project key', dataType: 'string' },
        { id: 'name', dataType: 'string' },
        { id: 'projectTypeKey', alias: 'Project type', dataType: 'string' },
        { id: 'projectCategory', alias: 'Project category', dataType: 'string' },
        { id: 'leadAccountId', alias: 'Lead accountId', dataType: 'string' },
        { id: 'leadDisplayName', alias: 'Project lead', dataType: 'string' },
        { id: 'isPrivate', alias: 'Private', dataType: 'bool' },
        { id: 'simplified', alias: 'Simplified workflow', dataType: 'bool' },
        { id: 'archived', dataType: 'bool' }
    ]
});

const buildIssueJql = (filters, incrementalValue) => {
    const clauses = [];
    if (filters.projectKeys && filters.projectKeys.length) {
        const projects = filters.projectKeys.map((key) => `"${key}"`).join(', ');
        clauses.push(`project in (${projects})`);
    }

    if (filters.issueTypeIds && filters.issueTypeIds.length) {
        const issueTypes = filters.issueTypeIds.map((id) => `"${id}"`).join(', ');
        clauses.push(`issueType in (${issueTypes})`);
    }

    if (filters.updatedAfter) {
        clauses.push(`updated >= "${filters.updatedAfter}"`);
    }

    if (incrementalValue) {
        clauses.push(`updated > "${incrementalValue}"`);
    }

    if (filters.jql) {
        clauses.push(`(${filters.jql})`);
    }

    return clauses.join(' AND ');
};

const fetchIssueData = async (accountId, filters, cursor, limit, incrementalValue) => {
    const startAt = cursor ? Number(cursor) : 0;
    const maxResults = clampLimit(limit);
    const searchParams = new URLSearchParams();
    searchParams.set('startAt', String(startAt));
    searchParams.set('maxResults', String(maxResults));
    searchParams.set('fields', 'summary,status,project,issuetype,assignee,reporter,updated,created');

    const jql = buildIssueJql(filters || {}, incrementalValue);
    if (jql) {
        searchParams.set('jql', jql);
    }

    const searchResponse = await requestJiraJson(accountId, `/rest/api/3/search?${searchParams.toString()}`);
    const issues = searchResponse.issues || [];

    const rows = issues.map((issue) => {
        const fields = issue.fields || {};
        const status = fields.status || {};
        const project = fields.project || {};
        const issueType = fields.issuetype || {};
        const assignee = fields.assignee || {};
        const reporter = fields.reporter || {};

        return {
            id: issue.id,
            key: issue.key,
            summary: fields.summary || '',
            status: status.name || null,
            statusCategory: status.statusCategory ? status.statusCategory.key : null,
            projectKey: project.key || null,
            projectName: project.name || null,
            issueType: issueType.name || null,
            issueTypeId: issueType.id || null,
            assigneeAccountId: assignee.accountId || null,
            assigneeDisplayName: assignee.displayName || null,
            reporterAccountId: reporter.accountId || null,
            reporterDisplayName: reporter.displayName || null,
            created: fields.created || null,
            updated: fields.updated || null
        };
    });

    const nextCursor = (searchResponse.startAt || 0) + issues.length < (searchResponse.total || 0)
        ? (searchResponse.startAt || 0) + issues.length
        : null;

    return {
        rows,
        nextCursor,
        total: searchResponse.total || rows.length
    };
};

const fetchProjectData = async (accountId, filters, cursor, limit) => {
    const startAt = cursor ? Number(cursor) : 0;
    const maxResults = clampLimit(limit);
    const params = new URLSearchParams();
    params.set('startAt', String(startAt));
    params.set('maxResults', String(maxResults));
    params.set('orderBy', 'name');

    const response = await requestJiraJson(accountId, `/rest/api/3/project/search?${params.toString()}`);
    let projects = response.values || [];

    if (filters.projectKeys && filters.projectKeys.length) {
        const keySet = new Set(filters.projectKeys);
        projects = projects.filter((project) => keySet.has(project.key));
    }

    const rows = projects.map((project) => ({
        id: project.id,
        key: project.key,
        name: project.name,
        projectTypeKey: project.projectTypeKey,
        projectCategory: project.projectCategory ? project.projectCategory.name : null,
        leadAccountId: project.lead ? project.lead.accountId : null,
        leadDisplayName: project.lead ? project.lead.displayName : null,
        isPrivate: project.isPrivate || false,
        simplified: project.simplified || false,
        archived: project.archived || false
    }));

    const nextCursor = (response.startAt || 0) + projects.length < (response.total || 0)
        ? (response.startAt || 0) + projects.length
        : null;

    return {
        rows,
        nextCursor,
        total: response.total || rows.length
    };
};

const getSchemaForDataset = (datasetKey) => {
    if (datasetKey === 'jira-issues') {
        return buildIssueSchema();
    }

    if (datasetKey === 'jira-projects') {
        return buildProjectSchema();
    }

    throw new NotFoundError(`Unknown dataset: ${datasetKey}`);
};

const fetchDatasetRows = async (session, datasetKey, payload) => {
    const filters = payload.filters || {};
    if (datasetKey === 'jira-issues') {
        return fetchIssueData(session.accountId, filters, payload.cursor, payload.limit, payload.incrementalValue);
    }

    if (datasetKey === 'jira-projects') {
        return fetchProjectData(session.accountId, filters, payload.cursor, payload.limit);
    }

    throw new NotFoundError(`Unknown dataset: ${datasetKey}`);
};

const handleAuthSession = async (request) => {
    const { accountId } = request.context || {};
    if (!accountId) {
        return jsonResponse(401, { error: 'User context is required to create a session.' });
    }

    const payload = parseBody(request);
    const session = await createSession(accountId, {
        auditEnabled: payload.auditEnabled,
        workbook: payload.workbook
    });

    await recordAudit(session, { event: 'session-created', purpose: payload.purpose || null }, true);

    return jsonResponse(200, {
        token: session.token,
        expiresAt: session.expiresAt,
        auditDefault: session.auditEnabled
    });
};

const handleDatasets = async (session) => {
    const datasets = await buildDatasets(session.accountId);
    return jsonResponse(200, { datasets });
};

const handleSchema = async (session, datasetKey) => {
    const schema = getSchemaForDataset(datasetKey);
    return jsonResponse(200, schema);
};

const handleData = async (session, datasetKey, payload) => {
    if (typeof payload.auditEnabled === 'boolean' && payload.auditEnabled !== session.auditEnabled) {
        const updatedSession = Object.assign({}, session, { auditEnabled: payload.auditEnabled });
        await storage.set(`${SESSION_PREFIX}${session.token}`, updatedSession);
        session.auditEnabled = updatedSession.auditEnabled;
    }

    const data = await fetchDatasetRows(session, datasetKey, payload);
    const auditId = await recordAudit(session, {
        event: 'data-fetch',
        datasetKey,
        filters: payload.filters || {},
        rowCount: data.rows.length,
        nextCursor: data.nextCursor || null
    });

    if (auditId) {
        data.auditId = auditId;
    }

    return jsonResponse(200, data);
};

exports.handler = async (request) => {
    try {
        const resourcePath = (request.pathParameters && request.pathParameters.resource) || '';
        const segments = resourcePath.split('/').filter(Boolean);
        const resource = segments[0];

        if (request.method === 'POST' && resource === 'auth' && segments[1] === 'session') {
            return handleAuthSession(request);
        }

        const token = extractToken(request.headers || {});
        if (!token) {
            throw new SessionError('Missing bearer token');
        }

        const session = await getSession(token);
        await refreshSessionExpiry(session);

        if (request.method === 'GET' && resource === 'datasets') {
            return handleDatasets(session);
        }

        if (request.method === 'POST' && resource === 'schema') {
            const datasetKey = segments[1];
            if (!datasetKey) {
                return jsonResponse(400, { error: 'Dataset key is required.' });
            }

            return handleSchema(session, datasetKey);
        }

        if (request.method === 'POST' && resource === 'data') {
            const datasetKey = segments[1];
            if (!datasetKey) {
                return jsonResponse(400, { error: 'Dataset key is required.' });
            }

            const payload = parseBody(request);
            return handleData(session, datasetKey, payload);
        }

        return jsonResponse(404, { error: 'Endpoint not found.' });
    } catch (error) {
        if (error instanceof SessionError) {
            return jsonResponse(401, { error: 'Authentication required.' });
        }

        if (error instanceof NotFoundError) {
            return jsonResponse(404, { error: error.message });
        }

        console.error('Forge Jira WDC handler error', error);
        return jsonResponse(500, { error: 'Unexpected server error.', details: error.message });
    }
};
