/* global tableau */

(function forgeJiraConnector() {
    'use strict';

    var CONNECTOR_CONFIG = {
        forgeBaseUrl: 'https://your-forge-app.example.com',
        authEndpoint: '/wdc/auth/session',
        datasetsEndpoint: '/wdc/datasets',
        schemaEndpoint: '/wdc/schema',
        dataEndpoint: '/wdc/data'
    };

    var connectorState = {
        datasets: [],
        selectedDataset: null,
        filters: {},
        auditEnabled: false
    };

    function parseConnectionData() {
        if (!tableau.connectionData) {
            return {};
        }

        try {
            return JSON.parse(tableau.connectionData);
        } catch (error) {
            console.error('Failed to parse connection data', error);
            return {};
        }
    }

    function encodeConnectionData(payload) {
        try {
            return JSON.stringify(payload);
        } catch (error) {
            console.error('Failed to encode connection payload', error);
            return '{}';
        }
    }

    function buildForgeUrl(path) {
        return ''.concat(CONNECTOR_CONFIG.forgeBaseUrl, path);
    }

    function isAuthError(status) {
        return status === 401 || status === 403;
    }

    function mapDataType(column) {
        var type = column.dataType ? column.dataType.toLowerCase() : 'string';
        switch (type) {
        case 'string':
        case 'text':
        case 'keyword':
            return tableau.dataTypeEnum.string;
        case 'int':
        case 'integer':
        case 'long':
        case 'double':
        case 'float':
        case 'number':
            return tableau.dataTypeEnum.float;
        case 'bool':
        case 'boolean':
            return tableau.dataTypeEnum.bool;
        case 'date':
        case 'datetime':
        case 'timestamp':
            return tableau.dataTypeEnum.datetime;
        case 'geometry':
            return tableau.dataTypeEnum.geometry;
        default:
            return tableau.dataTypeEnum.string;
        }
    }

    function setStatus(message, tone) {
        var $status = $('#statusContainer');
        var className = 'alert-info';

        if (tone === 'success') {
            className = 'alert-success';
        } else if (tone === 'error') {
            className = 'alert-danger';
        } else if (tone === 'warning') {
            className = 'alert-warning';
        }

        $status.removeClass('alert-info alert-success alert-danger alert-warning');
        $status.addClass(className);
        $status.text(message);
    }

    function showError(error) {
        var $container = $('#errorContainer');
        var message = error && error.message ? error.message : 'Unexpected error communicating with Forge.';
        $container.text(message);
        $container.show();
    }

    function clearError() {
        $('#errorContainer').hide().text('');
    }

    function buildFilterControl(filter) {
        var $group = $('<div/>', { class: 'form-group', 'data-filter-id': filter.id });
        $('<label/>', { for: 'filter-'.concat(filter.id), text: filter.label || filter.id }).appendTo($group);

        if (filter.type === 'select') {
            var $select = $('<select/>', { class: 'form-control', id: 'filter-'.concat(filter.id) });
            if (!filter.required) {
                $('<option/>', { value: '', text: 'Any' }).appendTo($select);
            }

            (filter.options || []).forEach(function addOption(option) {
                $('<option/>', { value: option.value, text: option.label || option.value }).appendTo($select);
            });

            $select.appendTo($group);
        } else if (filter.type === 'multi-select') {
            var $multi = $('<select/>', { class: 'form-control', id: 'filter-'.concat(filter.id), multiple: true });
            (filter.options || []).forEach(function addMulti(option) {
                $('<option/>', { value: option.value, text: option.label || option.value }).appendTo($multi);
            });
            $multi.appendTo($group);
            $('<p/>', { class: 'help-block', text: 'Use Ctrl (Windows) or Command (macOS) to pick multiple values.' }).appendTo($group);
        } else if (filter.type === 'checkbox') {
            $group = $('<div/>', { class: 'checkbox', 'data-filter-id': filter.id });
            var $label = $('<label/>').appendTo($group);
            $('<input/>', { type: 'checkbox', id: 'filter-'.concat(filter.id), checked: !!filter.defaultValue }).appendTo($label);
            $label.append(' '.concat(filter.label || filter.id));
        } else {
            $('<input/>', {
                class: 'form-control',
                id: 'filter-'.concat(filter.id),
                type: filter.inputType || 'text',
                placeholder: filter.placeholder || '',
                value: filter.defaultValue || ''
            }).appendTo($group);
        }

        if (filter.help) {
            $('<p/>', { class: 'help-block', text: filter.help }).appendTo($group);
        }

        return $group;
    }

    function loadFilters(dataset) {
        var $container = $('#filterContainer');
        $container.empty();

        if (!dataset || !dataset.filters || !dataset.filters.length) {
            return;
        }

        dataset.filters.forEach(function appendFilter(filter) {
            var $control = buildFilterControl(filter);
            $container.append($control);

            if (connectorState.filters && connectorState.filters[filter.id] !== undefined) {
                var stored = connectorState.filters[filter.id];
                var $input = $('#filter-'.concat(filter.id));
                if ($input.is(':checkbox')) {
                    $input.prop('checked', !!stored);
                } else if ($input.is('select[multiple]')) {
                    $input.val(stored);
                } else {
                    $input.val(stored);
                }
            }
        });
    }

    function collectFilters(dataset) {
        var values = {};
        if (!dataset || !dataset.filters) {
            return values;
        }

        dataset.filters.forEach(function capture(filter) {
            var $input = $('#filter-'.concat(filter.id));
            if ($input.length === 0) {
                return;
            }

            if ($input.is(':checkbox')) {
                values[filter.id] = $input.is(':checked');
            } else if ($input.is('select[multiple]')) {
                values[filter.id] = $input.val() || [];
            } else {
                values[filter.id] = $input.val();
            }
        });

        return values;
    }

    function handleAuthFailure() {
        setStatus('Your Atlassian session expired. Sign in again to refresh the connection.', 'warning');
        $('#configurationPanel').hide();
        $('#authenticateButton').prop('disabled', false);
        $('#disconnectButton').hide();
        tableau.password = '';
        connectorState.selectedDataset = null;
    }

    function forgeFetch(path, options, skipAuth) {
        var opts = options || {};
        var headers = opts.headers ? $.extend({}, opts.headers) : {};

        if (!skipAuth && tableau.password) {
            headers.Authorization = 'Bearer '.concat(tableau.password);
        }

        if (opts.body && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }

        var fetchOptions = $.extend({}, opts, { headers: headers });

        return fetch(buildForgeUrl(path), fetchOptions).then(function handleResponse(response) {
            if (isAuthError(response.status)) {
                throw new Error('AUTH_REQUIRED');
            }

            if (!response.ok) {
                return response.text().then(function throwText(text) {
                    var err = new Error(text || 'Forge request failed.');
                    err.status = response.status;
                    throw err;
                });
            }

            if (response.status === 204) {
                return null;
            }

            return response.json();
        });
    }

    function populateDatasets(datasets) {
        var $select = $('#datasetSelect');
        $select.find('option:not(:first)').remove();

        datasets.forEach(function appendDataset(dataset) {
            $('<option/>', {
                value: dataset.key,
                text: dataset.name || dataset.key
            }).appendTo($select);
        });

        if (connectorState.selectedDataset) {
            $select.val(connectorState.selectedDataset.key);
            $('#datasetDescription').text(connectorState.selectedDataset.description || '');
            loadFilters(connectorState.selectedDataset);
        }
    }

    function refreshDatasets() {
        setStatus('Loading Jira datasets from Forge…', 'info');
        clearError();

        return forgeFetch(CONNECTOR_CONFIG.datasetsEndpoint, { method: 'GET' }).then(function onSuccess(response) {
            connectorState.datasets = response && response.datasets ? response.datasets : [];
            populateDatasets(connectorState.datasets);

            if (connectorState.selectedDataset && connectorState.selectedDataset.key) {
                var updated = connectorState.datasets.filter(function findDataset(item) {
                    return item.key === connectorState.selectedDataset.key;
                })[0];

                if (updated) {
                    connectorState.selectedDataset = updated;
                    $('#datasetSelect').val(updated.key);
                    $('#datasetDescription').text(updated.description || '');
                    loadFilters(updated);
                }
            }

            setStatus('Choose a dataset and filters, then click "Load data in Tableau".', 'success');
            $('#configurationPanel').show();
            $('#disconnectButton').show();
        }).catch(function onError(error) {
            if (error.message === 'AUTH_REQUIRED') {
                handleAuthFailure();
            } else {
                showError(error);
                setStatus('Unable to load datasets. Try again after refreshing your Atlassian session.', 'error');
            }
        });
    }

    function startAuthentication() {
        clearError();
        setStatus('Requesting an Atlassian session…', 'info');
        $('#authenticateButton').prop('disabled', true);

        var payload = {
            purpose: tableau.authPurpose || 'ephemeral',
            workbook: tableau && tableau.connectionName ? tableau.connectionName : undefined
        };

        return forgeFetch(CONNECTOR_CONFIG.authEndpoint, {
            method: 'POST',
            body: JSON.stringify(payload)
        }, true).then(function onAuth(response) {
            tableau.password = response.token;
            connectorState.auditEnabled = !!response.auditDefault;
            $('#auditToggle').prop('checked', connectorState.auditEnabled);
            setStatus('Authenticated with Atlassian. Loading datasets…', 'success');
            $('#disconnectButton').show();
            return refreshDatasets();
        }).catch(function onAuthError(error) {
            if (error.message === 'AUTH_REQUIRED') {
                setStatus('Authentication is required. Sign in again to continue.', 'error');
            } else {
                showError(error);
                setStatus('Authentication failed. Review your Forge deployment configuration.', 'error');
            }
            $('#authenticateButton').prop('disabled', false);
        });
    }

    function disconnect() {
        tableau.password = '';
        connectorState.selectedDataset = null;
        connectorState.filters = {};
        $('#configurationPanel').hide();
        $('#disconnectButton').hide();
        $('#authenticateButton').prop('disabled', false);
        setStatus('Disconnected. Sign in with Atlassian to continue.', 'info');
    }

    function restoreInteractiveState() {
        var data = parseConnectionData();
        connectorState.filters = data.filters || {};
        connectorState.auditEnabled = !!data.auditEnabled;
        $('#auditToggle').prop('checked', connectorState.auditEnabled);

        if (data.datasetKey) {
            connectorState.selectedDataset = {
                key: data.datasetKey,
                name: data.datasetName,
                description: data.datasetDescription,
                filters: data.filtersDefinition || []
            };
        }

        if (tableau.password) {
            $('#disconnectButton').show();
            setStatus('Connected. You can refresh dataset metadata or submit to Tableau.', 'success');
            refreshDatasets();
        } else {
            setStatus('Sign in with Atlassian to begin configuring the connector.', 'info');
        }
    }

    var connector = tableau.makeConnector();

    connector.init = function init(callback) {
        tableau.authType = tableau.authTypeEnum.custom;

        if (tableau.phase === tableau.phaseEnum.gatherDataPhase && !tableau.password) {
            tableau.abortForAuth();
            return;
        }

        if (tableau.phase === tableau.phaseEnum.interactivePhase) {
            restoreInteractiveState();
        }

        callback();

        if (tableau.phase === tableau.phaseEnum.authPhase) {
            startAuthentication();
        }
    };

    connector.getSchema = function getSchema(schemaCallback) {
        var data = parseConnectionData();
        if (!data.datasetKey) {
            tableau.abortWithError('A dataset has not been selected. Configure the connector and try again.');
            return;
        }

        forgeFetch(''.concat(CONNECTOR_CONFIG.schemaEndpoint, '/', data.datasetKey), {
            method: 'POST',
            body: JSON.stringify({
                filters: data.filters || {},
                auditId: data.auditId
            })
        }).then(function onSchema(response) {
            var columns = (response.columns || []).map(function mapColumn(column) {
                return {
                    id: column.id,
                    dataType: mapDataType(column),
                    alias: column.alias || column.name || column.id,
                    description: column.description
                };
            });

            var schema = {
                id: response.id || data.datasetKey,
                alias: response.alias || data.datasetName || data.datasetKey,
                columns: columns
            };

            if (response.incrementalColumnId) {
                schema.incrementColumnId = response.incrementalColumnId;
            }

            if (response.description) {
                schema.description = response.description;
            }

            schemaCallback([schema]);
        }).catch(function onSchemaError(error) {
            if (error.message === 'AUTH_REQUIRED') {
                tableau.abortForAuth();
            } else {
                tableau.abortWithError(error.message || 'Failed to load schema metadata from Forge.');
            }
        });
    };

    connector.getData = function getData(table, doneCallback) {
        var connectionData = parseConnectionData();
        if (!connectionData.datasetKey) {
            tableau.abortWithError('Missing dataset configuration. Reconfigure the connector in Tableau Desktop.');
            return;
        }

        var pageCursor = null;
        var pageSize = connectionData.pageSize || 500;

        function fetchNextPage() {
            var requestBody = {
                filters: connectionData.filters || {},
                cursor: pageCursor,
                limit: pageSize,
                auditId: connectionData.auditId,
                incrementalValue: table.incrementValue,
                auditEnabled: connectionData.auditEnabled
            };

            forgeFetch(''.concat(CONNECTOR_CONFIG.dataEndpoint, '/', connectionData.datasetKey), {
                method: 'POST',
                body: JSON.stringify(requestBody)
            }).then(function onData(response) {
                var rows = response.rows || [];
                if (rows.length > 0) {
                    table.appendRows(rows);
                }

                if (response.auditId && !connectionData.auditId) {
                    connectionData.auditId = response.auditId;
                    tableau.connectionData = encodeConnectionData(connectionData);
                }

                if (response.nextCursor) {
                    pageCursor = response.nextCursor;
                    fetchNextPage();
                } else {
                    doneCallback();
                }
            }).catch(function onDataError(error) {
                if (error.message === 'AUTH_REQUIRED') {
                    tableau.abortForAuth();
                } else {
                    tableau.abortWithError(error.message || 'Forge returned an unexpected error while streaming data.');
                }
            });
        }

        fetchNextPage();
    };

    connector.shutdown = function shutdown(shutdownCallback) {
        shutdownCallback();
    };

    tableau.registerConnector(connector);

    function selectDataset(datasetKey) {
        var dataset = connectorState.datasets.filter(function filterDataset(item) {
            return item.key === datasetKey;
        })[0] || null;

        connectorState.selectedDataset = dataset;
        connectorState.filters = {};

        if (dataset) {
            $('#datasetDescription').text(dataset.description || '');
            loadFilters(dataset);
        } else {
            $('#datasetDescription').text('');
            $('#filterContainer').empty();
        }
    }

    function submitConfiguration() {
        clearError();

        if (!connectorState.selectedDataset) {
            showError(new Error('Select a dataset before continuing.'));
            return;
        }

        var filters = collectFilters(connectorState.selectedDataset);
        connectorState.filters = filters;
        connectorState.auditEnabled = $('#auditToggle').is(':checked');

        var payload = {
            datasetKey: connectorState.selectedDataset.key,
            datasetName: connectorState.selectedDataset.name,
            datasetDescription: connectorState.selectedDataset.description,
            filters: filters,
            filtersDefinition: connectorState.selectedDataset.filters,
            auditEnabled: connectorState.auditEnabled,
            pageSize: connectorState.selectedDataset.pageSize
        };

        tableau.connectionData = encodeConnectionData(payload);
        tableau.connectionName = connectorState.selectedDataset.name || 'Jira Forge Dataset';

        tableau.submit();
    }

    $(document).ready(function onReady() {
        $('#authenticateButton').click(function onAuthClick() {
            startAuthentication();
        });

        $('#disconnectButton').click(function onDisconnect() {
            disconnect();
        });

        $('#datasetSelect').change(function onDatasetChange(event) {
            var value = $(event.target).val();
            selectDataset(value);
        });

        $('#auditToggle').change(function onAuditChange(event) {
            connectorState.auditEnabled = $(event.target).is(':checked');
        });

        $('#submitButton').click(function onSubmit() {
            submitConfiguration();
        });

        if (tableau.phase === tableau.phaseEnum.interactivePhase) {
            $('#configurationPanel').toggle(tableau.password !== '');
            $('#auditCheckboxContainer').show();
        }
    });
})();
