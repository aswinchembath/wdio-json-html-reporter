import fs from 'fs';
import path from 'path';
import WDIOReporter from '@wdio/reporter';

/**
 * Custom JSON Reporter that generates a report with timestamps,
 * optional screenshots, browser logs, spec console logs, and metadata for WebDriverIO tests.
 *
 * Options:
 * - outputFile: the path where the JSON file is to be written.
 * - screenshotOption: "No" (default), "OnFailure", or "Full"
 * - history: number of history records to retain (default 5)
 * - historyPath: path where the individual/aggregated history report should be generated (if provided)
 */
export default class JSONReporter extends WDIOReporter {
  constructor(options) {
    // Default options.
    options = Object.assign(
      { stdout: true, screenshotOption: 'No', history: 5, historyPath: null },
      options
    );
    super(options);
    this.options = options;
    this.testResults = [];
    this.testResultUids = new Set();

    // Use a global executionId so that all reporter instances (across spec files) share the same one.
    if (!JSONReporter.globalExecutionId) {
      JSONReporter.globalExecutionId = Date.now().toString();
    }
    this.executionId = JSONReporter.globalExecutionId;
    this.executionStartTime = new Date();

    // Ensure the output directory exists.
    fs.mkdirSync(path.dirname(this.options.outputFile), { recursive: true });

    // Buffer to capture spec file console logs for each test.
    this.currentTestSpecLogs = [];
  }

  /**
   * Reset spec log buffer when a test starts.
   */
  onTestStart(test) {
    this.currentTestSpecLogs = [];
  }

  /**
   * Capture any stdout output from the spec files.
   */
  onStdout(chunk, pid) {
    if (this.currentTestSpecLogs) {
      this.currentTestSpecLogs.push(chunk.toString());
    }
  }

  async onRunnerEnd() {
    await this.writeJSONReport();
  }

  async onTestPass(test) {
    await this.addTestResult(test, 'PASSED');
  }

  async onTestFail(test) {
    await this.addTestResult(test, 'FAILED');
  }

  /**
   * Captures test result details along with optional screenshot,
   * browser logs, and spec console logs.
   */
  async addTestResult(test, status) {
    const date = new Date();
    const timestamp = date.toUTCString();
    const uid = test.uid || `${test.title}-${timestamp}`;
    const suiteName = test.parent ? test.parent.replace(/suite\d+/gi, '').trim() : 'Default Suite';
    // Handle multiple errors
    const errors = test.errors ? test.errors.map(error => ({
      message: this.sanitizeErrorMessage(error.message, true),
      stack: this.sanitizeErrorMessage(error.stack, true)
    })) : [];
  
    let screenshotPath = '';
  
    // Capture screenshot if enabled.
    if (
      this.options.screenshotOption === 'Full' ||
      (this.options.screenshotOption === 'OnFailure' && status === 'FAILED')
    ) {
      try {
        const screenshotData = await browser.takeScreenshot();
        const screenshotDir = path.join(path.dirname(this.options.outputFile), 'screenshots');
        fs.mkdirSync(screenshotDir, { recursive: true });
        const hash = this.generateShortHash(test.title);
        const safeTimestamp = this.formatDateForFilename(date);
        const screenshotFileName = `screenshot-${hash}-${safeTimestamp}.png`;
        screenshotPath = path.join(screenshotDir, screenshotFileName);
        fs.writeFileSync(screenshotPath, screenshotData, 'base64');
      } catch (err) {
        console.error('Error capturing screenshot: ', err);
      }
    }

    // Capture browser logs (if available).
    let browserConsoleLogs = [];
    if (
      browser &&
      !browser.isW3C &&
      typeof browser.getLogs === 'function' &&
      browser.logTypes &&
      browser.logTypes.includes('browser')
    ) {
      try {
        browserConsoleLogs = await browser.getLogs('browser');
      } catch (err) {
        if (err.code === 'ECONNREFUSED') {
          console.warn('Browser logs not available: Connection refused');
        } else {
          console.error('Error capturing browser logs: ', err);
        }
      }
    }

    // Get spec file console logs.
    const specConsoleLogs = this.currentTestSpecLogs || [];
    this.currentTestSpecLogs = [];

    if (!this.testResultUids.has(uid)) {
      this.testResults.push({
        uid,
        timestamp,
        suiteName,
        testName: test.title,
        status,
        errors, // Store multiple errors
        screenshot: screenshotPath,
        browserConsoleLogs,
        specConsoleLogs,
      });
      this.testResultUids.add(uid);
    }
  }

  async writeJSONReport() {
    const executionEnd = new Date();
    const totalTimeMinutes = ((executionEnd - this.executionStartTime) / 60000).toFixed(2);
    const browserName =
      browser && browser.capabilities && browser.capabilities.browserName
        ? browser.capabilities.browserName
        : 'Unknown';

    // Include the shared executionId in the metadata.
    const metadata = {
      executionId: this.executionId,
      browserName,
      executionStartTime: this.executionStartTime.toUTCString(),
      executionEndTime: executionEnd.toUTCString(),
      totalTimeInMinutes: totalTimeMinutes,
    };

    const report = {
      metadata,
      testResults: this.testResults,
    };

    const fileTimestamp = this.formatDateForFilename(new Date());
    const fileName = `test-report-${fileTimestamp}.json`;
    const outputDir = path.dirname(this.options.outputFile);
    const outputFile = path.join(outputDir, fileName);
    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
    console.log(`JSON report successfully written to ${outputFile}`);
  }

  /**
   * Helper to create a filename-safe timestamp string from a Date object.
   */
  formatDateForFilename(date) {
    return date
      .toUTCString()
      .replace(/,/g, '')
      .replace(/:/g, '-')
      .replace(/\s+/g, '_');
  }

  /**
   * Sanitizes error messages by removing ANSI escape sequences.
   */
  sanitizeErrorMessage(errorMessage, full = false) {
    if (!errorMessage) return '';
    const sanitized = errorMessage
      .replace(/[\u001b\u009b]\[\d{1,2}(;\d{1,2})?(m|K)/g, '')
      .trim();
    return full ? sanitized : sanitized.split('\n')[0];
  }

  /**
   * Generates a short non-cryptographic hash for a given string.
   */
  generateShortHash(input) {
    let hash = 0;
    if (input.length === 0) return '00000000';
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) - hash) + input.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0').substring(0, 8);
  }

  /**
   * Static method to generate an aggregated history record.
   * It scans all JSON report files (matching the pattern 'test-report-*.json') in the provided report directories,
   * aggregates the results (summing test counts and merging suite data), and appends the aggregated record
   * to the specified history file. The method returns the aggregated history record.
   *
   * Options:
   * - reportPaths: Path containing JSON report files.
   * - historyPath: File path where the aggregated history record should be appended.
   * - maxHistory: Maximum number of history records to retain (default: 5).
   */
  /**
   * Static method to generate an aggregated history record.
   * It scans all JSON report files (matching the pattern 'test-report-*.json') in the provided report directories,
   * aggregates the results (summing test counts and merging suite data), compares with the last aggregated record
   * (if available) to compute defect comparisons, and appends the aggregated record
   * to the specified history file. The method returns the aggregated history record.
   *
   * Options:
   * - reportPaths: Directory path (or array of paths) containing JSON report files.
   * - historyPath: File path where the aggregated history record should be appended.
   * - maxHistory: Maximum number of history records to retain (default: 5).
   */
  static generateAggregateHistory({ reportPaths, historyPath, maxHistory = 5 }) {
    // If reportPaths is not an array, wrap it in an array.
    if (!Array.isArray(reportPaths)) {
      reportPaths = [reportPaths];
    }
  
    let aggregated = {
      executionStartTime: null,
      executionEndTime: null,
      totalTests: 0,
      passed: 0,
      failed: 0,
      suites: {} // For each suite: { totalTests, passed, failed, errors: {} }
    };
  
    // Process each provided report directory.
    reportPaths.forEach(reportDir => {
      if (!fs.existsSync(reportDir)) {
        console.warn(`Report directory not found: ${reportDir}`);
        return;
      }
      const files = fs.readdirSync(reportDir).filter(file => file.startsWith('test-report-') && file.endsWith('.json'));
      files.forEach(file => {
        // Using simple concatenation instead of path.join.
        const filePath = reportDir + '/' + file;
        try {
          const data = fs.readFileSync(filePath, 'utf8');
          const jsonData = JSON.parse(data);
  
          // Update aggregated start time (earliest) and end time (latest).
          const fileStart = new Date(jsonData.metadata.executionStartTime);
          if (!aggregated.executionStartTime || fileStart < new Date(aggregated.executionStartTime)) {
            aggregated.executionStartTime = jsonData.metadata.executionStartTime;
          }
          const fileEnd = new Date(jsonData.metadata.executionEndTime);
          if (!aggregated.executionEndTime || fileEnd > new Date(aggregated.executionEndTime)) {
            aggregated.executionEndTime = jsonData.metadata.executionEndTime;
          }
  
          // Sum tests and update counts.
          aggregated.totalTests += jsonData.testResults.length;
          const passedCount = jsonData.testResults.filter(result => result.status === 'PASSED').length;
          const failedCount = jsonData.testResults.filter(result => result.status === 'FAILED').length;
          aggregated.passed += passedCount;
          aggregated.failed += failedCount;
  
          // Aggregate suite data.
          jsonData.testResults.forEach(result => {
            const suiteName = result.suiteName || 'Default Suite';
            if (!aggregated.suites[suiteName]) {
              aggregated.suites[suiteName] = { totalTests: 0, passed: 0, failed: 0, errors: {} };
            }
            aggregated.suites[suiteName].totalTests++;
            if (result.status === 'PASSED') {
              aggregated.suites[suiteName].passed++;
            } else if (result.status === 'FAILED') {
              aggregated.suites[suiteName].failed++;
              if (result.error) {
                aggregated.suites[suiteName].errors[result.testName] = result.error;
              }
            }
          });
        } catch (err) {
          console.error(`Error processing file ${filePath}:`, err);
        }
      });
    });
  
    // Read existing history data.
    let historyData = [];
    if (fs.existsSync(historyPath)) {
      try {
        const data = fs.readFileSync(historyPath, 'utf8');
        historyData = JSON.parse(data);
        if (!Array.isArray(historyData)) {
          historyData = [];
        }
      } catch (err) {
        console.error('Error reading history file:', err);
      }
    }
  
    // Compute defectComparison using the last aggregated record if available.
    let previousRecord = historyData.length > 0 ? historyData[historyData.length - 1] : null;
  
    // For each suite in the current aggregated data:
    for (const suiteName in aggregated.suites) {
      const currentErrors = Object.keys(aggregated.suites[suiteName].errors);
      let previousErrors = [];
      if (previousRecord && previousRecord.suites && previousRecord.suites[suiteName] && previousRecord.suites[suiteName].errors) {
        previousErrors = Object.keys(previousRecord.suites[suiteName].errors);
      }
      const newDefects = currentErrors.filter(key => !previousErrors.includes(key));
      const resolvedDefects = previousErrors.filter(key => !currentErrors.includes(key));
      aggregated.suites[suiteName].defectComparison = {
        newDefects,
        resolvedDefects
      };
    }
  
    // Create the aggregated history record.
    const aggregatedHistoryRecord = {
      timestamp: new Date().toUTCString(),
      executionStartTime: aggregated.executionStartTime,
      executionEndTime: aggregated.executionEndTime,
      totalTests: aggregated.totalTests,
      passed: aggregated.passed,
      failed: aggregated.failed,
      suites: aggregated.suites
    };
  
    // Append the new aggregated record.
    historyData.push(aggregatedHistoryRecord);
    // Retain only the last maxHistory records.
    if (historyData.length > maxHistory) {
      historyData = historyData.slice(historyData.length - maxHistory);
    }
  
    try {
      // Create directory if needed using simple string concatenation.
      const historyDir = historyPath.substring(0, historyPath.lastIndexOf('/'));
      if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir, { recursive: true });
      }
      fs.writeFileSync(historyPath, JSON.stringify(historyData, null, 2));
      console.log(`Aggregated history record appended to ${historyPath}`);
    } catch (err) {
      console.error('Error writing history file:', err);
    }
  
    return aggregatedHistoryRecord;
  }

  
}

// Ensure that the aggregated history is written only once if needed.
JSONReporter.aggregatedHistoryWritten = false;  
