# Forge-powered Jira Tableau Web Data Connector

This example pairs a Tableau Web Data Connector (WDC) with an [Atlassian Forge](https://developer.atlassian.com/platform/forge/) backend so that Tableau only receives the Jira records the signed-in user is permitted to see. The flow uses Forge to execute every Jira REST API call as the authenticated Atlassian user, providing fine-grained access control and an auditable trail of extract activity.

The example consists of two parts:

1. **Front-end WDC** – `/Examples/html/forgeJiraConnector.html` and `/Examples/js/ForgeJiraConnector.js` implement the interactive configuration experience and the gather-data phase. You can host the HTML page anywhere Tableau can reach (for example GitHub Pages, S3, or Forge static resources).
2. **Forge backend** – `/Examples/ForgeJiraConnector/forge-app` contains a Forge app skeleton that exposes authenticated HTTP endpoints for the WDC. The backend enforces user-level permissions, streams data in pages, and captures audit events for compliance.

## Prerequisites

* Node.js 16+
* The Forge CLI (`npm install -g @forge/cli`)
* A Jira Cloud site where you can install the Forge app

## 1. Configure the Forge app

The Forge app exposes authenticated HTTP endpoints under `/wdc/*`. The WDC calls these endpoints with the short-lived session token stored in `tableau.password`. Each request is executed with `asUser`, ensuring Jira enforces the calling user’s permissions.

```bash
cd Examples/ForgeJiraConnector/forge-app
npm install
forge register
forge deploy
forge install --site=https://your-site.atlassian.net --product=jira
```

The example `manifest.yml` declares an HTTP module and the permissions required to read Jira issues, projects, users, and worklogs. Update the `app.id` before deploying by running `forge register`.

### Session workflow

1. During the interactive phase the user clicks **Sign in with Atlassian**.
2. The WDC calls `POST /wdc/auth/session` which creates a short-lived Forge session bound to the Atlassian accountId and returns a signed bearer token. The token is stored in `tableau.password` so Tableau can reuse it during refreshes.
3. Subsequent calls to `/wdc/datasets`, `/wdc/schema/{datasetKey}`, and `/wdc/data/{datasetKey}` validate the token, impersonate the user with `asUser(session.accountId)`, and fetch Jira data.
4. Each data request records an audit entry (user, dataset, filters, row counts, timestamp) in Forge storage so administrators can review who extracted what data.

## 2. Host the Web Data Connector

1. Upload `Examples/html/forgeJiraConnector.html` and `Examples/js/ForgeJiraConnector.js` to a static host.
2. Edit `ForgeJiraConnector.js` to set `CONNECTOR_CONFIG.forgeBaseUrl` to your Forge app’s base URL (the value returned by `forge deploy`).
3. Load the HTML page in Tableau Desktop’s “Web Data Connector” dialog to test the experience.

The connector dynamically lists the datasets exposed by the Forge app (issues, projects, worklogs, etc.), shows dataset-specific filters, and allows an optional “enhanced audit logging” toggle. Selected options are serialized into `tableau.connectionData` so refreshes reuse the exact configuration.

## 3. Refreshes and auditing

* When Tableau Server performs an automated refresh, the connector reuses the stored Forge session. If the session expires the backend returns a 401/403, causing the WDC to call `tableau.abortForAuth()` which prompts Tableau to re-open the interactive UI so the user can re-authenticate.
* The Forge app writes audit events (session ID, dataset, filters, row count, timestamps, success/failure) into Forge storage. You can extend the example to stream these records to an external SIEM or compliance system.

## Extending the sample

* Add additional datasets by updating both the Forge resolver’s dataset catalog and the WDC UI’s rendering of filter controls.
* Implement incremental refresh semantics by returning `incrementalColumnId` from the schema endpoint and honoring `incrementalValue` in the data endpoint.
* Integrate with enterprise key management by encrypting session and audit data before writing to Forge storage.

This example is intentionally opinionated to highlight best practices for protecting Jira data when exposed through Tableau. Adapt it to match your organization’s governance, logging, and compliance needs.
