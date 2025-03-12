import fs from 'fs';
import path from 'path';

export default class HTMLReportGenerator {
  constructor(outputFilePath, historyPath = null) {
    this.outputFilePath = outputFilePath;
    this.historyPath = historyPath; // Optional history JSON file path.
    this.testResults = [];
    // Store metadata objects from each JSON file
    this.metadataList = [];
  }

  // Helper to escape HTML so that any HTML tags in data are rendered as text
  escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async convertJSONFolderToHTML(folderPath) {
    let historyData = [];
    try {
      const files = fs.readdirSync(folderPath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(folderPath, file);
          const jsonContent = await fs.promises.readFile(filePath, 'utf8');
          const parsedContent = JSON.parse(jsonContent);
          // Check if JSON contains metadata and testResults
          if (parsedContent.testResults && Array.isArray(parsedContent.testResults)) {
            if (parsedContent.metadata) {
              this.metadataList.push(parsedContent.metadata);
            }
            this.testResults.push(...parsedContent.testResults);
          } else if (Array.isArray(parsedContent)) {
            this.testResults.push(...parsedContent);
          }
        }
      }
      // Compute overall metadata if any metadata was collected
      let overallStart = null;
      let overallEnd = null;
      if (this.metadataList.length > 0) {
        this.metadataList.forEach(meta => {
          if (meta.executionStartTime) {
            const startTime = new Date(meta.executionStartTime);
            if (!overallStart || startTime < overallStart) {
              overallStart = startTime;
            }
          }
          if (meta.executionEndTime) {
            const endTime = new Date(meta.executionEndTime);
            if (!overallEnd || endTime > overallEnd) {
              overallEnd = endTime;
            }
          }
        });
      }
      // Build a metadata object with overall values
      this.metadata = {
        browserName: this.metadataList[0] ? this.metadataList[0].browserName : 'N/A',
        executionStartTime: overallStart ? overallStart.toISOString() : 'N/A',
        executionEndTime: overallEnd ? overallEnd.toISOString() : 'N/A',
        totalTimeInMinutes: (overallStart && overallEnd)
          ? (((overallEnd - overallStart) / (1000 * 60)).toFixed(2))
          : 'N/A'
      };

      // If historyPath is provided and exists, read the history JSON data.
      if (this.historyPath && fs.existsSync(this.historyPath)) {
        try {
          const historyContent = fs.readFileSync(this.historyPath, 'utf8');
          historyData = JSON.parse(historyContent);
          if (!Array.isArray(historyData)) {
            historyData = [];
          }
        } catch (error) {
          console.error('Error reading history file:', error);
        }
      }
      this.generateHTMLReport(historyData);
    } catch (error) {
      console.error('Error converting JSON to HTML:', error);
    }
  }

  generateHTMLReport(historyData) {
    const summary = this.calculateSummaryStats();
    const metadata = this.metadata || {
      browserName: 'N/A',
      executionStartTime: 'N/A',
      executionEndTime: 'N/A',
      totalTimeInMinutes: 'N/A',
    };

    // Compute suite statistics for current run
    const suiteStats = {};
    this.testResults.forEach(test => {
      const suite = test.suiteName || "Unknown";
      if (!suiteStats[suite]) {
        suiteStats[suite] = { total: 0, passed: 0, failed: 0 };
      }
      suiteStats[suite].total++;
      if (test.status === 'PASSED') {
        suiteStats[suite].passed++;
      } else if (test.status === 'FAILED') {
        suiteStats[suite].failed++;
      }
    });
    const totalSuiteCount = Object.keys(suiteStats).length;
    const failedSuiteCount = Object.keys(suiteStats).filter(suite => suiteStats[suite].failed > 0).length;
    const passedSuiteCount = totalSuiteCount - failedSuiteCount;

    // Process test results to embed screenshots as data URLs.
    const processedTestResults = this.testResults.map(test => {
      if (test.screenshot && !test.screenshot.startsWith('data:')) {
        const dataUrl = this.embedScreenshot(test.screenshot);
        if (dataUrl) {
          test.screenshot = dataUrl;
        }
      }
      return test;
    });

    // Build Unique Errors table rows.
    const uniqueErrors = Object.keys(this.testResults.reduce((acc, test) => {
      if (test.errors) {
        test.errors.forEach(error => { // Loop through each error
          const msg = error.message;
          acc[msg] = (acc[msg] || 0) + 1;
        });
      }
      return acc;
    }, {}));
    const uniqueErrorsRows = uniqueErrors.map((errMsg, index) => {
      const count = this.testResults.filter(t => t.error === errMsg).length;
      return `<tr class="error-row" data-error="${encodeURIComponent(errMsg)}" style="cursor: pointer;">
                <td>${index + 1}</td>
                <td>${this.escapeHtml(errMsg)}</td>
                <td>${count}</td>
              </tr>`;
    }).join('');

    // Group historical data by suite to build an interactive accordion.
    let historicalBySuite = {};
    if (historyData && historyData.length > 0) {
      // Sort history records by timestamp (oldest first)
      historyData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      historyData.forEach(record => {
        let timestamp = record.timestamp;
        if (record.suites) {
          Object.keys(record.suites).forEach(suite => {
            const data = record.suites[suite];
            let passRate = data.totalTests ? ((data.passed / data.totalTests) * 100).toFixed(2) : '0';
            let failRate = data.totalTests ? ((data.failed / data.totalTests) * 100).toFixed(2) : '0';
            if (!historicalBySuite[suite]) {
              historicalBySuite[suite] = [];
            }
            historicalBySuite[suite].push({
              timestamp: timestamp,
              totalTests: data.totalTests || 0,
              passed: data.passed || 0,
              failed: data.failed || 0,
              passRate: passRate,
              failRate: failRate,
              newIssues: data.defectComparison ? data.defectComparison.newDefects : [],
              resolvedIssues: data.defectComparison ? data.defectComparison.resolvedDefects : []
            });
          });
        }
      });
    }

    // Build the accordion HTML for historical execution details.
    let historicalAccordionHTML = '';
    if (Object.keys(historicalBySuite).length > 0) {
      historicalAccordionHTML += '<div class="historical-accordion">';
      Object.keys(historicalBySuite).forEach((suite) => {
        // For each suite, check the latest record for new/resolved issues
        let latestRecord = historicalBySuite[suite][historicalBySuite[suite].length - 1];
        let redDot = latestRecord.newIssues && latestRecord.newIssues.length > 0 ? '<span class="dot red-dot" title="New Issues"></span>' : '';
        let greenDot = latestRecord.resolvedIssues && latestRecord.resolvedIssues.length > 0 ? '<span class="dot green-dot" title="Resolved Issues"></span>' : '';
        historicalAccordionHTML += `<div class="suite-row" onclick="toggleSuiteDetails(this)">
            <span>${this.escapeHtml(suite)} ${redDot}${greenDot}</span>
            <span class="toggle-icon">+</span>
          </div>`;
        historicalAccordionHTML += '<div class="suite-details">';
        historicalAccordionHTML += '<div class="scrollable-table"><table><thead><tr><th>Timestamp</th><th>Total Tests</th><th>Passed</th><th>Failed</th><th>Pass Rate (%)</th><th>Fail Rate (%)</th><th>New Issues</th><th>Resolved Issues</th></tr></thead><tbody>';
        historicalBySuite[suite].forEach(record => {
          let newIssuesHTML = 'None';
          if (record.newIssues && record.newIssues.length > 0) {
            newIssuesHTML = '<ul>' + record.newIssues.map(t => `<li>${this.escapeHtml(t)}</li>`).join('') + '</ul>';
          }
          let resolvedIssuesHTML = 'None';
          if (record.resolvedIssues && record.resolvedIssues.length > 0) {
            resolvedIssuesHTML = '<ul>' + record.resolvedIssues.map(t => `<li>${this.escapeHtml(t)}</li>`).join('') + '</ul>';
          }
          historicalAccordionHTML += `<tr>
              <td>${record.timestamp}</td>
              <td>${record.totalTests}</td>
              <td>${record.passed}</td>
              <td>${record.failed}</td>
              <td>${record.passRate}</td>
              <td>${record.failRate}</td>
              <td>${newIssuesHTML}</td>
              <td>${resolvedIssuesHTML}</td>
          </tr>`;
        });
        historicalAccordionHTML += '</tbody></table></div></div>';
      });
      historicalAccordionHTML += '</div>';
    }

    // Build the tables container.
    // If historical data exists and produced suite data, include the Historical Execution section;
    // otherwise, only show the Unique Errors.
    let tablesContainerHTML = '';
    if (historyData && historyData.length > 0 && Object.keys(historicalBySuite).length > 0) {
      tablesContainerHTML = `
      <div class="tables-container">
        <div class="unique-errors">
          <h2>Unique Errors Overview</h2>
          <table id="uniqueErrorsTable">
            <thead>
              <tr>
                <th>SI NO</th>
                <th>Error Message</th>
                <th>Occurrence</th>
              </tr>
            </thead>
            <tbody>
              ${uniqueErrorsRows}
            </tbody>
          </table>
        </div>
        <div class="historical-accordion-container">
          <h2>Historical Execution by Suite</h2>
          <p class="dot-legend"><span class="dot red-dot"></span> [red-dot] Indicates the suite has New Issues, <span class="dot green-dot"></span> [green-dot] Indicates the suite has Resolved Issues</p>
          <button class="collapse-all-btn" onclick="collapseAllSuites()">Collapse All</button>
          ${historicalAccordionHTML}
        </div>
      </div>
    `;
    } else {
      tablesContainerHTML = `
      <div class="tables-container">
        <div class="unique-errors">
          <h2>Unique Errors Overview</h2>
          <table id="uniqueErrorsTable">
            <thead>
              <tr>
                <th>SI NO</th>
                <th>Error Message</th>
                <th>Occurrence</th>
              </tr>
            </thead>
            <tbody>
              ${uniqueErrorsRows}
            </tbody>
          </table>
        </div>
      </div>
    `;
    }

    // Include a chart container for history trends if historical data is provided.
    const historyChartHTML = (historyData && historyData.length > 0)
      ? `<div class="charts-row" id="historyChartsRow">
           <div class="chart-container">
             <canvas id="historyChart"></canvas>
             <button class="expand-btn" onclick="openChartModal('history')">Expand History Chart</button>
           </div>
         </div>`
      : '';

    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Test Execution Report</title>
  <style>
    /* Global Styles & CSS Variables */
    :root {
      --background-color: #f2f2f2;
      --header-bg: linear-gradient(135deg, rgb(123, 56, 5), rgb(73, 20, 111));
      --header-text: #ecf0f1;
      --nav-bg: rgb(41, 10, 63);
      --nav-btn-color: #ecf0f1;
      --nav-btn-hover: rgb(175, 93, 17);
      --card-bg: #fff;
      --card-shadow: 0 2px 8px rgba(0,0,0,0.1);
      --card-hover-shadow: 0 4px 12px rgba(0,0,0,0.15);
      --text-color: #2c3e50;
      --subtext-color: #7f8c8d;
      --button-bg: rgb(61, 26, 87);
      --button-bg-hover: rgb(221, 131, 47);
      --table-border: #e0e0e0;
      --table-header-bg: rgb(66, 4, 59);
      --table-text: rgb(22, 0, 26);
      --table-row-hover: #f5f5f5;
      --filter-menu-border: #ddd;
      --filter-menu-bg: #fff;
    }
    body { 
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      margin: 0;
      padding: 0;
      background-color: var(--background-color);
      transition: background-color 0.3s;
    }
    .header {
      background: var(--header-bg);
      color: var(--header-text);
      padding: 20px;
      text-align: center;
      position: relative;
    }
    .execution-subheader {
      font-size: 0.9em;
      color: var(--header-text);
      margin-top: 10px;
    }
    .nav {
      display: flex;
      justify-content: center;
      background-color: var(--nav-bg);
    }
    .nav button {
      background: none;
      border: none;
      color: var(--nav-btn-color);
      padding: 15px 30px;
      font-size: 1em;
      cursor: pointer;
      transition: background 0.3s;
    }
    .nav button:hover, .nav button.active {
      background-color: var(--nav-btn-hover);
    }
    .container {
      padding: 20px;
    }
    .tabcontent {
      display: none;
      animation: fadeIn 0.5s;
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    /* Dashboard Styles */
    #Dashboard {
      background: var(--card-bg);
      border-radius: 8px;
      padding: 20px;
      box-shadow: var(--card-shadow);
      margin-bottom: 20px;
    }
    #Dashboard .cards-group h2 {
      text-align: center;
      margin-bottom: 20px;
      color: var(--text-color);
      font-size: 1.2em;
    }
    #Dashboard .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 15px;
    }
    #Dashboard .card {
      background: var(--card-bg);
      border-radius: 8px;
      padding: 20px;
      box-shadow: var(--card-shadow);
      text-align: center;
      cursor: pointer;
      transition: transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out;
    }
    #Dashboard .card:hover {
      transform: translateY(-3px);
      box-shadow: var(--card-hover-shadow);
    }
    #Dashboard .card h3 {
      margin: 0 0 8px 0;
      font-size: 1em;
      color: var(--subtext-color);
    }
    #Dashboard .card p {
      margin: 0;
      font-size: 1.8em;
      color: var(--text-color);
      font-weight: bold;
    }
    /* Chart Container Styles */
    .charts-row {
      display: flex;
      justify-content: space-around;
      gap: 20px;
      margin: 20px 0;
      flex-wrap: nowrap;
    }
    .chart-container {
      background: var(--card-bg);
      border-radius: 8px;
      padding: 15px;
      box-shadow: var(--card-shadow);
      flex: 1;
      min-width: 350px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .chart-container canvas {
      display: block;
      margin: auto;
      width: 100%;
      height: 100%;
      max-height: 280px;
      max-width: 280px;
    }
    .expand-btn {
      margin-top: 10px;
      padding: 6px 12px;
      font-size: 0.9em;
      cursor: pointer;
      border: none;
      background-color: var(--button-bg);
      color: var(--header-text);
      border-radius: 4px;
      transition: background 0.3s;
    }
    .expand-btn:hover {
      background-color: var(--button-bg-hover);
    }
    /* Tables Container Styles */
    .tables-container {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      margin-top: 20px;
    }
    .tables-container > div {
      flex: 1;
      min-width: 300px;
    }
    .tables-container table {
      width: 100%;
      border-collapse: collapse;
    }
    .tables-container th, .tables-container td {
      border: 1px solid #bdc3c7;
      padding: 10px;
      text-align: center;
    }
    .tables-container th {
      background-color: rgb(63, 45, 73);
      color: #fff;
    }
    tr:nth-child(even) {
      background-color: #fafafa;
    }
    /* Historical Accordion Styles */
    .historical-accordion-container {
      overflow: hidden;
    }
    .historical-accordion {
      width: 100%;
    }
    .historical-accordion .suite-row {
      background: #f9f9f9;
      cursor: pointer;
      padding: 10px;
      border-bottom: 1px solid #ddd;
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .historical-accordion .suite-details {
      display: none;
      padding: 10px;
      background: #fff;
    }
    .historical-accordion .suite-details table {
      width: 100%;
      border-collapse: collapse;
    }
    .historical-accordion .suite-details th, 
    .historical-accordion .suite-details td {
      border: 1px solid #ddd;
      padding: 8px;
      text-align: center;
    }
    .historical-accordion .toggle-icon {
      font-size: 1.2em;
    }
    /* Dot Indicators for new/resolved issues */
    .historical-accordion .dot {
      height: 10px;
      width: 10px;
      border-radius: 50%;
      display: inline-block;
      margin-left: 5px;
    }
    .historical-accordion .red-dot {
      background-color: red;
    }
    .historical-accordion .green-dot {
      background-color: green;
    }
    /* Dot Legend Style */
    .dot-legend {
      font-size: 0.9em;
      margin-bottom: 10px;
    }
    /* Scrollable Table for Historical Details with Fixed Headers */
    .scrollable-table {
      max-height: 300px;
      overflow-y: auto;
      overflow-x: auto;
    }
    .scrollable-table th {
      position: sticky;
      top: 0;
      background-color: var(--table-header-bg);
      z-index: 2;
    }
    /* Collapse All Button Styles */
    .collapse-all-btn {
      margin-bottom: 10px;
      padding: 6px 12px;
      font-size: 0.9em;
      cursor: pointer;
      border: none;
      background-color: var(--button-bg);
      color: var(--header-text);
      border-radius: 4px;
      transition: background 0.3s;
    }
    .collapse-all-btn:hover {
      background-color: var(--button-bg-hover);
    }
    /* Test Details Styles */
    #TestDetails {
      background: var(--card-bg);
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.1);
      margin-top: 20px;
    }
    #TestDetails table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 15px;
      font-size: 0.9em;
    }
    #TestDetails th, #TestDetails td {
      border: 1px solid var(--table-border);
      padding: 12px;
      text-align: left;
      color: var(--table-text);
    }
    #TestDetails th {
      background-color: var(--table-header-bg);
      font-weight: bold;
    }
    /* Added styles for pass/fail cells in Test Details */
    #TestDetails td.passed {
      background-color: #d4edda !important;
      color: #155724 !important;
    }
    #TestDetails td.failed {
      background-color: #f8d7da !important;
      color: #721c24 !important;
    }
    #TestDetails tbody tr:hover {
      background-color: var(--table-row-hover);
    }
    .filter-group {
      display: flex;
      gap: 10px;
      margin-bottom: 15px;
      align-items: center;
    }
    .filter-group input {
      padding: 10px;
      border: 1px solid #ccc;
      border-radius: 4px;
      flex: 1;
    }
    .filter-group button {
      padding: 10px 15px;
      border: none;
      background-color: var(--button-bg);
      color: var(--header-text);
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.3s;
    }
    .filter-group button:hover {
      background-color: var(--button-bg-hover);
    }
    /* Filter Menu Styles */
    .filter-icon {
      margin-left: 5px;
      cursor: pointer;
      font-size: 0.8em;
      color: #555;
    }
    .filter-menu {
      position: absolute;
      background: var(--filter-menu-bg);
      border: 1px solid var(--filter-menu-border);
      padding: 10px;
      border-radius: 4px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      z-index: 1000;
    }
    .filter-menu label {
      display: block;
      margin: 5px 0;
    }
    .filter-menu button {
      margin-top: 10px;
      padding: 6px 10px;
      border: none;
      background-color: var(--button-bg);
      color: var(--header-text);
      border-radius: 4px;
      cursor: pointer;
    }
    .thumbnail {
      max-width: 100px;
      cursor: pointer;
      transition: opacity 0.3s;
    }
    .thumbnail:hover {
      opacity: 0.8;
    }
    /* Modal Styles */
    .modal, .chart-modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      overflow: auto;
      background-color: rgba(0,0,0,0.8);
    }
    .modal-content {
      margin: auto;
      display: block;
      max-width: 90%;
      max-height: 90%;
      position: relative;
    }
    .chart-modal-content {
      margin: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 90vmin;
      height: 90vmin;
      position: relative;
    }
    .close, .chart-close {
      position: absolute;
      top: 20px;
      right: 30px;
      color: var(--header-text);
      font-size: 40px;
      font-weight: bold;
      cursor: pointer;
    }
    .error-cell {
      max-width: 200px;
      overflow-y: auto;
      white-space: normal;
      word-wrap: break-word;
    }
    .error-message {
      cursor: pointer;
      color: rgb(168, 82, 72);
      text-decoration: underline;
    }
    .stack-trace {
      background-color: #f9f9f9;
      border: 1px solid #ccc;
      padding: 5px;
      margin-top: 5px;
      font-family: monospace;
      white-space: pre-wrap;
      overflow-wrap: break-word;
    }
    .suite-cell {
      text-align: center;
      font-weight: bold;
      vertical-align: middle;
    }
    /* Pagination Styles */
    .pagination {
      text-align: center;
      margin-top: 20px;
    }
    .pagination button {
      background-color: var(--button-bg);
      color: var(--header-text);
      border: none;
      padding: 8px 12px;
      margin: 0 4px;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.3s;
    }
    .pagination button:hover {
      background-color: var(--button-bg-hover);
    }
    .pagination button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .pagination .page-number {
      background-color: #e0e0e0;
      color: #555;
      font-size: 0.7em;
      padding: 4px 6px;
      margin: 0 2px;
      border-radius: 3px;
      min-width: 20px;
    }
    .pagination .page-number:hover {
      background-color: #d0d0d0;
    }
    .pagination .page-number:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    /* Common Table Header Style Override */
    table th {
      background-color: var(--table-header-bg) !important;
      color: #fff !important;
      padding: 12px !important;
      text-align: center !important;
      border: 1px solid var(--table-border) !important;
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels"></script>
</head>
<body>
  <div class="header">
    <h1>Test Execution Report</h1>
    <div class="execution-subheader">
      <p>Browser Name: ${metadata.browserName} - Execution Start Time: ${metadata.executionStartTime} - Execution End Time: ${metadata.executionEndTime} - Total Execution Time (minutes): ${metadata.totalTimeInMinutes}</p>
    </div>
  </div>
  <div class="nav">
    <button class="tablinks" onclick="openTab(event, 'Dashboard')">Dashboard</button>
    <button class="tablinks" onclick="openTab(event, 'TestDetails')">Test Details</button>
  </div>
  <div class="container">
    <div id="Dashboard" class="tabcontent" style="display: block;">
      <!-- Overall Test Information Group -->
      <div class="cards-group">
        <h2>Overall Test Information</h2>
        <div class="cards">
          <div class="card" onclick="showAllTestDetails()" title="Click to view All Tests">
            <h3>Total Tests</h3>
            <p>${summary.total}</p>
          </div>
          <div class="card" onclick="filterByStatus('PASSED')" title="Click to view Passed Tests">
            <h3>Passed</h3>
            <p>${summary.passed}</p>
          </div>
          <div class="card" onclick="filterByStatus('FAILED')" title="Click to view Failed Tests">
            <h3>Failed</h3>
            <p>${summary.failed}</p>
          </div>
        </div>
      </div>
      <!-- Suite Information Group -->
      <div class="cards-group">
        <h2>Suite Information</h2>
        <div class="cards">
          <div class="card" title="Total Suites">
            <h3>Total Suites</h3>
            <p>${totalSuiteCount}</p>
          </div>
          <div class="card" onclick="filterByPassedSuites()" title="Click to view passed suites">
            <h3>Passed Suites</h3>
            <p>${passedSuiteCount}</p>
          </div>
          <div class="card" onclick="filterByFailedSuites()" title="Click to view failed suites">
            <h3>Failed Suites</h3>
            <p>${failedSuiteCount}</p>
          </div>
        </div>
      </div>
      <!-- Charts Row -->
      <div class="charts-row">
        <div class="chart-container">
          <canvas id="statusChart"></canvas>
          <button class="expand-btn" onclick="openChartModal('overall')">Expand Chart</button>
        </div>
        <div class="chart-container">
          <canvas id="suiteChart"></canvas>
          <button class="expand-btn" onclick="openChartModal('suite')">Expand Chart</button>
        </div>
      </div>
      <!-- History Chart (only if history data available) -->
      ${historyChartHTML}
      <!-- Tables Container: Unique Errors and Historical Execution Accordion (if available) -->
      ${tablesContainerHTML}
    </div>
    <div id="TestDetails" class="tabcontent">
      <div class="filter-group">
        <input type="text" id="filterSuiteDetails" placeholder="Search Suite Name..." onkeyup="applyFilters()">
        <button onclick="clearFilters()">Clear Filters</button>
      </div>
      <button onclick="exportTableToExcel('detailsTable', 'TestDetailsReport')" style="margin-bottom: 10px;">Export to Excel</button>
      <table id="detailsTable">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Suite Name <span class="filter-icon" onclick="openFilterMenu(event, 1)">&#x1F50D;</span></th>
            <th>Test Name <span class="filter-icon" onclick="openFilterMenu(event, 2)">&#x1F50D;</span></th>
            <th>Status <span class="filter-icon" onclick="openFilterMenu(event, 3)">&#x1F50D;</span></th>
            <th>Error <span class="filter-icon" onclick="openFilterMenu(event, 4)">&#x1F50D;</span></th>
            <th>Screenshot</th>
          </tr>
        </thead>
        <tbody id="tableBody">
          <!-- Dynamic rows will be rendered here -->
        </tbody>
      </table>
      <div id="paginationControls"></div>
    </div>
  </div>
  
  <!-- Image Modal -->
  <div id="myModal" class="modal">
    <span class="close" onclick="closeModal()">&times;</span>
    <img class="modal-content" id="modalImage">
  </div>
  
  <!-- Chart Modal -->
  <div id="chartModal" class="chart-modal">
    <div class="chart-modal-content">
      <span class="chart-close" onclick="closeChartModal()">&times;</span>
      <canvas id="chartModalCanvas"></canvas>
    </div>
  </div>
  
  <script>
    // Expose processed data to client-side.
    window.allTestResults = ${JSON.stringify(processedTestResults)};
    window.filteredResults = window.allTestResults.slice();
    window.currentPage = 1;
    window.suiteStats = ${JSON.stringify(suiteStats)};
    // Expose history data (if any) to client-side.
    window.historyData = ${JSON.stringify(historyData)};
    
    let activeFilters = {};
    let currentFilterMenu = null;
    let statusChartInstance, suiteChartInstance, modalChartInstance, historyChartInstance;
    const PAGE_SIZE = 50;
    
    function navigateToError(errorMsg) {
      activeFilters[4] = [errorMsg];
      applyFilters();
      openTab(null, 'TestDetails');
    }
    
    document.addEventListener("DOMContentLoaded", function() {
      document.querySelectorAll('#uniqueErrorsTable .error-row').forEach(function(row) {
        row.addEventListener('click', function() {
          var errorMsg = decodeURIComponent(row.getAttribute('data-error'));
          navigateToError(errorMsg);
        });
      });
      renderTable(1);
      openTab(null, 'Dashboard');
    });
    
    // Toggle the suite details in the historical accordion.
    function toggleSuiteDetails(element) {
      var details = element.nextElementSibling;
      var icon = element.querySelector('.toggle-icon');
      if (details.style.display === 'none' || details.style.display === '') {
        details.style.display = 'block';
        icon.textContent = '-';
      } else {
        details.style.display = 'none';
        icon.textContent = '+';
      }
    }
    
    // Collapse all expanded suite details.
    function collapseAllSuites() {
      var suiteDetailsElements = document.querySelectorAll('.historical-accordion .suite-details');
      suiteDetailsElements.forEach(function(details) {
          details.style.display = 'none';
          var suiteRow = details.previousElementSibling;
          if (suiteRow) {
              var icon = suiteRow.querySelector('.toggle-icon');
              if (icon) {
                  icon.textContent = '+';
              }
          }
      });
    }
    
    function renderTable(page) {
      page = page || 1;
      window.currentPage = page;
      const start = (page - 1) * PAGE_SIZE;
      const end = start + PAGE_SIZE;
      const currentData = window.filteredResults.slice(start, end);
      const tbody = document.getElementById('tableBody');
      let html = '';
      currentData.forEach(test => {
        let screenshotHTML = 'No Screenshot';
        const dataUrl = embedScreenshot(test.screenshot);
        if (dataUrl) {
          screenshotHTML = \`<img src="\${dataUrl}" class="thumbnail" alt="Screenshot for \${escapeHtml(test.testName)}" onclick="openModal(this.src)">\`;
        }
        html += \`<tr data-suite="\${escapeHtml(test.suiteName || '')}" data-test-name="\${escapeHtml(test.testName || '')}" data-status="\${test.status || ''}" data-error="\${escapeHtml(test.error || '')}">
          <td>\${test.timestamp || ''}</td>
          <td class="suite-cell">\${escapeHtml(test.suiteName || '')}</td>
          <td>\${escapeHtml(test.testName || '')}</td>
          <td class="\${test.status === 'PASSED' ? 'passed' : test.status === 'FAILED' ? 'failed' : ''}">\${test.status || ''}</td>
          <td class=\"error-cell\">
            \${test.errors ? test.errors.map((error, idx) => \`
              <div class=\"error-message\" onclick=\"toggleStack(this)\">
                Error \${idx + 1}: \${escapeHtml(error.message)}
              </div>
              <div class=\"stack-trace\" style=\"display: none;\">
                \${escapeHtml(error.stack || 'No stack trace')}
              </div>
            \`).join('') : ''}
          </td>
          <td>\${screenshotHTML}</td>
        </tr>\`;
      });
      tbody.innerHTML = html;
      mergeSuiteCellsAdvanced();
      renderPaginationControls();
    }
    
    function renderPaginationControls() {
      const totalPages = Math.ceil(window.filteredResults.length / PAGE_SIZE);
      const container = document.getElementById('paginationControls');
      let html = '';
      if (totalPages > 1) {
        html += \`<button onclick="changePage(1)" \${window.currentPage === 1 ? 'disabled' : ''}>First</button>\`;
        html += \` <button onclick="changePage(\${Math.max(window.currentPage - 1, 1)})" \${window.currentPage === 1 ? 'disabled' : ''}>Previous</button> \`;
        for (let i = 1; i <= totalPages; i++) {
          html += \`<button class="page-number" onclick="changePage(\${i})" \${window.currentPage === i ? 'disabled' : ''}>\${i}</button>\`;
        }
        html += \` <button onclick="changePage(\${Math.min(window.currentPage + 1, totalPages)})" \${window.currentPage === totalPages ? 'disabled' : ''}>Next</button> \`;
        html += \` <button onclick="changePage(\${totalPages})" \${window.currentPage === totalPages ? 'disabled' : ''}>Last</button>\`;
      }
      container.innerHTML = '<div class="pagination">' + html + '</div>';
    }
    
    function changePage(page) {
      renderTable(page);
    }
    
    function applyFilters() {
      const suiteFilterText = document.getElementById("filterSuiteDetails").value.toUpperCase();
      window.filteredResults = window.allTestResults.filter(test => {
        const suiteValue = (test.suiteName || "").toUpperCase();
        let textMatch = suiteValue.indexOf(suiteFilterText) > -1;
        let columnMatch = true;
        if (activeFilters[1] && activeFilters[1].length > 0 && !activeFilters[1].includes(test.suiteName || '')) {
          columnMatch = false;
        }
        if (activeFilters[2] && activeFilters[2].length > 0 && !activeFilters[2].includes(test.testName || '')) {
          columnMatch = false;
        }
        if (activeFilters[3] && activeFilters[3].length > 0 && !activeFilters[3].includes(test.status || '')) {
          columnMatch = false;
        }
        let errorText = test.errors ? 
          test.errors.map(e => e.message).join(' ') : 
          "No Error";

        if (activeFilters[4] && activeFilters[4].length > 0 && 
          !activeFilters[4].some(filterMsg => 
            test.errors?.some(e => e.message === filterMsg) // Check all errors
          )) {
          columnMatch = false;
        }
        return textMatch && columnMatch;
      });
      renderTable(1);
    }
    
    function clearFilters() {
      document.getElementById("filterSuiteDetails").value = "";
      activeFilters = {};
      window.filteredResults = window.allTestResults.slice();
      renderTable(1);
    }
    
    function openFilterMenu(event, colIndex) {
      event.stopPropagation();
      if (currentFilterMenu) {
        currentFilterMenu.remove();
        currentFilterMenu = null;
      }
      const menu = document.createElement('div');
      menu.className = 'filter-menu';
      
      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.placeholder = 'Search...';
      searchInput.style.width = '100%';
      searchInput.style.marginBottom = '10px';
      menu.appendChild(searchInput);
      
      const controlsDiv = document.createElement('div');
      controlsDiv.style.marginBottom = '10px';
      
      const uncheckAllBtn = document.createElement('button');
      uncheckAllBtn.textContent = 'Uncheck All';
      uncheckAllBtn.onclick = function(e) {
        e.stopPropagation();
        const checkboxes = optionsContainer.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(chk => chk.checked = false);
      };
      controlsDiv.appendChild(uncheckAllBtn);
      
      const applyBtn = document.createElement('button');
      applyBtn.textContent = 'Apply';
      applyBtn.style.marginLeft = '5px';
      applyBtn.onclick = function(e) {
        e.stopPropagation();
        applyFilterMenu(colIndex, menu);
      };
      controlsDiv.appendChild(applyBtn);
      
      const clearBtn = document.createElement('button');
      clearBtn.textContent = 'Clear';
      clearBtn.style.marginLeft = '5px';
      clearBtn.onclick = function(e) {
        e.stopPropagation();
        clearFilterMenu(colIndex, menu);
      };
      controlsDiv.appendChild(clearBtn);
      
      menu.appendChild(controlsDiv);
      
      let dataset = window.allTestResults.filter(test => {
        for (let key in activeFilters) {
          if (Number(key) === colIndex) continue;
          if (activeFilters[key] && activeFilters[key].length > 0) {
            let value = "";
            if (Number(key) === 1) value = test.suiteName || "";
            else if (Number(key) === 2) value = test.testName || "";
            else if (Number(key) === 3) value = test.status || "";
            else if (Number(key) === 4) value = test.error ? test.error : "No Error";
            if (!activeFilters[key].includes(value)) return false;
          }
        }
        return true;
      });
      
      let uniqueValues = new Set();
      dataset.forEach(test => {
        let value = "";
        if (colIndex === 1) {
          value = test.suiteName || "";
        } else if (colIndex === 2) {
          value = test.testName || "";
        } else if (colIndex === 3) {
          value = test.status || "";
        } else if (colIndex === 4) {
          value = test.error ? test.error : "No Error";
        }
        uniqueValues.add(value);
      });
      
      const optionsContainer = document.createElement('div');
      let valuesArray = Array.from(uniqueValues).sort();
      valuesArray.forEach(value => {
        const label = document.createElement('label');
        label.className = 'filter-option';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = value;
        if (activeFilters[colIndex]) {
          checkbox.checked = activeFilters[colIndex].includes(value);
        } else {
          checkbox.checked = true;
        }
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(' ' + value));
        optionsContainer.appendChild(label);
      });
      menu.appendChild(optionsContainer);
      
      searchInput.addEventListener('keyup', function() {
        const filterValue = searchInput.value.toLowerCase();
        const optionLabels = optionsContainer.querySelectorAll('.filter-option');
        optionLabels.forEach(label => {
          label.style.display = label.textContent.toLowerCase().includes(filterValue) ? '' : 'none';
        });
      });
      
      document.body.appendChild(menu);
      currentFilterMenu = menu;
      const rect = event.target.getBoundingClientRect();
      menu.style.top = rect.bottom + window.scrollY + 'px';
      menu.style.left = rect.left + window.scrollX + 'px';
      menu.onclick = function(e) {
        e.stopPropagation();
      };
      document.addEventListener('click', closeCurrentFilterMenu);
    }
    
    function applyFilterMenu(colIndex, menu) {
      const checkboxes = menu.querySelectorAll('input[type="checkbox"]');
      const selectedValues = [];
      checkboxes.forEach(chk => {
        if (chk.checked) selectedValues.push(chk.value);
      });
      activeFilters[colIndex] = selectedValues;
      applyFilters();
      menu.remove();
      currentFilterMenu = null;
      document.removeEventListener('click', closeCurrentFilterMenu);
    }
    
    function clearFilterMenu(colIndex, menu) {
      activeFilters[colIndex] = [];
      applyFilters();
      menu.remove();
      currentFilterMenu = null;
      document.removeEventListener('click', closeCurrentFilterMenu);
    }
    
    function closeCurrentFilterMenu() {
      if (currentFilterMenu) {
        currentFilterMenu.remove();
        currentFilterMenu = null;
        document.removeEventListener('click', closeCurrentFilterMenu);
      }
    }
    
    function mergeSuiteCellsAdvanced() {
      const tbody = document.getElementById("detailsTable").tBodies[0];
      const allRows = Array.from(tbody.rows).filter(row => row.style.display !== "none");
      let i = 0;
      while (i < allRows.length) {
        const currentSuite = allRows[i].dataset.suite || "";
        let count = 1;
        let j = i + 1;
        while (j < allRows.length && (allRows[j].dataset.suite || "") === currentSuite) {
          count++;
          j++;
        }
        if (count > 1) {
          const firstRow = allRows[i];
          const suiteCell = firstRow.querySelector('.suite-cell');
          if (suiteCell) suiteCell.rowSpan = count;
          for (let k = i + 1; k < j; k++) {
            const cellToRemove = allRows[k].querySelector('.suite-cell');
            if (cellToRemove) cellToRemove.parentNode.removeChild(cellToRemove);
          }
        }
        i = j;
      }
    }
    
    function embedScreenshot(screenshotPath) {
      if (screenshotPath && screenshotPath.startsWith('data:')) return screenshotPath;
      return null;
    }
    
    function exportTableToExcel(tableID, filename = '') {
      var dataType = 'application/vnd.ms-excel';
      var style = \`
      <style>
        table { border-collapse: collapse; width: 100%; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        table, th, td { border: 1px solid #e0e0e0; }
        th, td { padding: 12px; text-align: center; }
        th { background-color: rgb(119, 145, 173); color: #fff; }
        td.passed { background-color: #d4edda !important; color: #155724 !important; }
        td.failed { background-color: #f8d7da !important; color: #721c24 !important; }
      </style>\`;
      
      let htmlTable = '<table><thead><tr><th>Timestamp</th><th>Suite Name</th><th>Test Name</th><th>Status</th><th>Error</th></tr></thead><tbody>';
      const results = window.filteredResults;
      for (let i = 0; i < results.length; i++) {
        const test = results[i];
        let suiteCell = '';
        if (i === 0 || (results[i].suiteName !== results[i - 1].suiteName)) {
          let rowspan = 1;
          for (let j = i + 1; j < results.length; j++) {
            if (results[j].suiteName === test.suiteName) {
              rowspan++;
            } else {
              break;
            }
          }
          suiteCell = \`<td rowspan="\${rowspan}">\${test.suiteName || ''}</td>\`;
        }
        let statusCell = '';
        if (test.status === 'PASSED') {
          statusCell = \`<td class="passed">\${test.status || ''}</td>\`;
        } else if (test.status === 'FAILED') {
          statusCell = \`<td class="failed">\${test.status || ''}</td>\`;
        } else {
          statusCell = \`<td>\${test.status || ''}</td>\`;
        }
        
        htmlTable += '<tr>';
        htmlTable += \`<td>\${test.timestamp || ''}</td>\`;
        htmlTable += suiteCell;
        htmlTable += \`<td>\${test.testName || ''}</td>\`;
        htmlTable += statusCell;
        htmlTable += \`<td>\${test.errors ? test.errors.map(e => e.message).join('; ') : ''}</td>\`;
        htmlTable += '</tr>';
      }
      htmlTable += '</tbody></table>';
      
      var htmlContent = \`
<html>
<head>
<meta charset="UTF-8">
\${style}
</head>
<body>
\${htmlTable}
</body>
</html>\`;
      
      var downloadLink = document.createElement("a");
      document.body.appendChild(downloadLink);
      filename = filename ? filename + '.xls' : 'report.xls';
      if (navigator.msSaveOrOpenBlob) {
        var blob = new Blob(['\\ufeff', htmlContent], { type: dataType });
        navigator.msSaveOrOpenBlob(blob, filename);
      } else {
        downloadLink.href = 'data:' + dataType + ', ' + encodeURIComponent(htmlContent);
        downloadLink.download = filename;
        downloadLink.click();
      }
      document.body.removeChild(downloadLink);
    }
    
    function openModal(src) {
      const modal = document.getElementById("myModal");
      const modalImg = document.getElementById("modalImage");
      modal.style.display = "block";
      modalImg.src = src;
    }
    
    function closeModal() {
      document.getElementById("myModal").style.display = "none";
    }
    
    function toggleStack(element) {
      var stackTraceDiv = element.nextElementSibling;
      if (stackTraceDiv.style.display === "none") {
        stackTraceDiv.style.display = "block";
      } else {
        stackTraceDiv.style.display = "none";
      }
    }
    
    function openChartModal(type) {
      document.getElementById("chartModal").style.display = "block";
      const modalCanvas = document.getElementById("chartModalCanvas");
      const ctx = modalCanvas.getContext('2d');
      if (modalChartInstance) {
        modalChartInstance.destroy();
      }
      if (type === 'overall') {
        modalChartInstance = new Chart(ctx, {
          type: 'pie',
          data: {
            labels: ['Passed', 'Failed'],
            datasets: [{
              data: [${summary.passed}, ${summary.failed}],
              backgroundColor: ['#28a745', '#dc3545']
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              datalabels: {
                color: '#fff',
                font: { weight: 'bold', size: 16 },
                formatter: function(value, context) {
                  let sum = context.chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
                  let percentage = sum ? Math.round((value / sum) * 100) + '%' : '0%';
                  return percentage;
                }
              },
              title: { display: true, text: 'Overall Execution Status' },
              legend: { position: 'bottom' }
            }
          },
          plugins: [ChartDataLabels]
        });
      } else if (type === 'suite') {
        const suiteNames = Object.keys(${JSON.stringify(suiteStats)});
        const passPercentages = suiteNames.map(suite => {
          const stats = ${JSON.stringify(suiteStats)}[suite];
          return stats.total > 0 ? parseFloat((stats.passed / stats.total * 100).toFixed(2)) : 0;
        });
        const failPercentages = suiteNames.map(suite => {
          const stats = ${JSON.stringify(suiteStats)}[suite];
          return stats.total > 0 ? parseFloat((stats.failed / stats.total * 100).toFixed(2)) : 0;
        });
        modalChartInstance = new Chart(ctx, {
          type: 'bar',
          data: {
            labels: suiteNames.map(name => name.length > 10 ? name.slice(0,10) + '...' : name),
            datasets: [
              { label: 'Passed %', data: passPercentages, backgroundColor: '#28a745' },
              { label: 'Failed %', data: failPercentages, backgroundColor: '#dc3545' }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              title: { display: true, text: 'Suite Level Pass/Fail Percentage' },
              legend: { position: 'bottom' },
              tooltip: {
                callbacks: {
                  title: function(context) {
                    return suiteNames[context[0].dataIndex];
                  }
                }
              }
            },
            scales: {
              x: { stacked: true, ticks: { font: { size: 12 } } },
              y: { stacked: true, beginAtZero: true, max: 100, ticks: { callback: function(value) { return value + '%'; } } }
            }
          }
        });
      } else if (type === 'history') {
        if (!window.historyData || window.historyData.length === 0) return;
        const labels = window.historyData.map(record => record.timestamp);
        const totalTests = window.historyData.map(record => record.totalTests);
        const passed = window.historyData.map(record => record.passed);
        const failed = window.historyData.map(record => record.failed);
        // In expanded view, show full timestamp labels.
        modalChartInstance = new Chart(ctx, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              { label: 'Total Tests', data: totalTests, borderColor: '#007bff', fill: false },
              { label: 'Passed', data: passed, borderColor: '#28a745', fill: false },
              { label: 'Failed', data: failed, borderColor: '#dc3545', fill: false }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              title: { display: true, text: 'Historical Test Execution Trends' },
              legend: { position: 'bottom' }
            }
          }
        });
      }
    }
    
    function closeChartModal() {
      document.getElementById("chartModal").style.display = "none";
    }
    
    function drawChart() {
      const canvas = document.getElementById('statusChart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (statusChartInstance) {
        statusChartInstance.destroy();
      }
      statusChartInstance = new Chart(ctx, {
        type: 'pie',
        data: {
          labels: ['Passed', 'Failed'],
          datasets: [{
            data: [${summary.passed}, ${summary.failed}],
            backgroundColor: ['#28a745', '#dc3545']
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          aspectRatio: 1,
          plugins: {
            datalabels: {
              color: '#fff',
              font: { weight: 'bold', size: 16 },
              formatter: function(value, context) {
                let sum = context.chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
                let percentage = sum ? Math.round((value / sum) * 100) + '%' : '0%';
                return percentage;
              }
            },
            title: { display: true, text: 'Overall Execution Status' },
            legend: { position: 'bottom' }
          },
          plugins: [ChartDataLabels]
        }
      });
    }
    
    function drawSuiteChart() {
      const canvas = document.getElementById('suiteChart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (suiteChartInstance) {
        suiteChartInstance.destroy();
      }
      
      const MAX_SUITES_DISPLAYED = 10;
      const suiteNamesAll = Object.keys(${JSON.stringify(suiteStats)});
      let suiteNames = suiteNamesAll;
      let passPercentagesAll = suiteNamesAll.map(suite => {
        const stats = ${JSON.stringify(suiteStats)}[suite];
        return stats.total > 0 ? parseFloat((stats.passed / stats.total * 100).toFixed(2)) : 0;
      });
      let failPercentagesAll = suiteNamesAll.map(suite => {
        const stats = ${JSON.stringify(suiteStats)}[suite];
        return stats.total > 0 ? parseFloat((stats.failed / stats.total * 100).toFixed(2)) : 0;
      });
      
      if (suiteNamesAll.length > MAX_SUITES_DISPLAYED) {
          suiteNames = suiteNamesAll.slice(0, MAX_SUITES_DISPLAYED);
          passPercentagesAll = passPercentagesAll.slice(0, MAX_SUITES_DISPLAYED);
          failPercentagesAll = failPercentagesAll.slice(0, MAX_SUITES_DISPLAYED);
      }
      
      const maxLabelLength = 10;
      const truncatedNames = suiteNames.map(name => name.length > maxLabelLength ? name.slice(0, maxLabelLength) + '...' : name);
      const fontSize = suiteNames.length > 10 ? 10 : 12;
      
      suiteChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: truncatedNames,
          datasets: [
            { label: 'Passed %', data: passPercentagesAll, backgroundColor: '#28a745' },
            { label: 'Failed %', data: failPercentagesAll, backgroundColor: '#dc3545' }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: { display: true, text: 'Suite Level Pass/Fail Percentage' },
            legend: { position: 'bottom' },
            tooltip: {
              callbacks: {
                title: function(context) {
                  return suiteNames[context[0].dataIndex];
                }
              }
            }
          },
          scales: {
            x: { stacked: true, ticks: { font: { size: fontSize } } },
            y: { stacked: true, beginAtZero: true, max: 100, ticks: { callback: function(value) { return value + '%'; } } }
          }
        }
      });
    }
    
    // Draw history chart for dashboard view with simplified x-axis (no labels)
    function drawHistoryChart() {
      if (!window.historyData || window.historyData.length === 0) return;
      const canvas = document.getElementById('historyChart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (historyChartInstance) {
        historyChartInstance.destroy();
      }
      const labels = window.historyData.map(record => record.timestamp);
      const totalTests = window.historyData.map(record => record.totalTests);
      const passed = window.historyData.map(record => record.passed);
      const failed = window.historyData.map(record => record.failed);
      // In dashboard view, hide x-axis tick labels to reduce clutter.
      historyChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            { label: 'Total Tests', data: totalTests, borderColor: '#007bff', fill: false },
            { label: 'Passed', data: passed, borderColor: '#28a745', fill: false },
            { label: 'Failed', data: failed, borderColor: '#dc3545', fill: false }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              ticks: {
                display: false // hide x-axis labels in dashboard view
              }
            }
          },
          plugins: {
            title: { display: true, text: 'Historical Test Execution Trends' },
            legend: { position: 'bottom' }
          }
        }
      });
    }
    
    function openTab(evt, tabName) {
      const tabcontent = document.getElementsByClassName("tabcontent");
      for (let i = 0; i < tabcontent.length; i++) {
        tabcontent[i].style.display = "none";
      }
      const tablinks = document.getElementsByClassName("tablinks");
      for (let i = 0; i < tablinks.length; i++) {
        tablinks[i].classList.remove("active");
      }
      document.getElementById(tabName).style.display = "block";
      if (evt && evt.currentTarget) {
        evt.currentTarget.classList.add("active");
      }
      if (tabName === 'Dashboard'){
        setTimeout(() => {
          drawChart();
          drawSuiteChart();
          if (window.historyData && window.historyData.length > 0) {
            document.getElementById("historyChartsRow").style.display = "flex";
            drawHistoryChart();
          }
        }, 0);
      }
      mergeSuiteCellsAdvanced();
    }
    
    function showAllTestDetails() {
      clearFilters();
      openTab(null, 'TestDetails');
    }
    
    function filterByStatus(status) {
      document.getElementById("filterSuiteDetails").value = "";
      activeFilters = {};
      window.filteredResults = window.allTestResults.filter(test => test.status === status);
      renderTable(1);
      openTab(null, 'TestDetails');
    }
    
    function filterByErrorTests() {
      window.filteredResults = window.allTestResults.filter(test => test.error && test.error.trim().length > 0);
      renderTable(1);
      openTab(null, 'TestDetails');
    }
    
    function filterByFailedSuites() {
      const failedSuites = new Set();
      window.allTestResults.forEach(test => {
        if (test.status === 'FAILED' && test.suiteName) {
          failedSuites.add(test.suiteName);
        }
      });
      window.filteredResults = window.allTestResults.filter(test => failedSuites.has(test.suiteName));
      renderTable(1);
      openTab(null, 'TestDetails');
    }
    
    function filterByPassedSuites() {
      const passedSuites = Object.keys(window.suiteStats).filter(suite => window.suiteStats[suite].failed === 0);
      window.filteredResults = window.allTestResults.filter(test => passedSuites.includes(test.suiteName));
      renderTable(1);
      openTab(null, 'TestDetails');
    }
    
    function escapeHtml(str) {
      if (!str) return '';
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  </script>
</body>
</html>
    `;
    fs.writeFileSync(this.outputFilePath, htmlContent, 'utf8');
    console.log(`HTML report successfully written to ${this.outputFilePath}`);
  }

  calculateSummaryStats() {
    const total = this.testResults.length;
    const passed = this.testResults.filter(test => test.status === 'PASSED').length;
    const failed = this.testResults.filter(test => test.status === 'FAILED').length;
    return { total, passed, failed };
  }

  embedScreenshot(screenshotPath) {
    try {
      if (fs.existsSync(screenshotPath)) {
        const ext = path.extname(screenshotPath).toLowerCase();
        let mimeType = 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') {
          mimeType = 'image/jpeg';
        } else if (ext === '.gif') {
          mimeType = 'image/gif';
        }
        const imageData = fs.readFileSync(screenshotPath);
        const base64Image = imageData.toString('base64');
        return `data:${mimeType};base64,${base64Image}`;
      }
      return null;
    } catch (e) {
      return null;
    }
  }
}
