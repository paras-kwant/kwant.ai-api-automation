const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const chalk = require("chalk");

const newmanReport = path.join(__dirname, "reports", "test-results.json");
const allureResultsDir = path.join(__dirname, "reports", "allure-results");

// Ensure output dir exists
if (!fs.existsSync(allureResultsDir)) fs.mkdirSync(allureResultsDir, { recursive: true });

console.log(chalk.cyan.bold("\n=== Converting Newman JSON → Allure Format ===\n"));

// Read newman report
const data = JSON.parse(fs.readFileSync(newmanReport, "utf8"));
const executions = data.run.executions || [];

// For each executed request
executions.forEach((exec) => {
  const suiteName = exec.item.name || "Unnamed Test";
  const requestName = exec.item.name || "Unnamed Request";
  const assertions = exec.assertions || [];
  const start = new Date().getTime();
  const stop = start + (exec.response?.responseTime || 1);

  // Build Allure test result JSON
  const allureTest = {
    uuid: uuidv4(),
    historyId: uuidv4(),
    name: requestName,
    fullName: requestName,
    status: "passed",
    stage: "finished",
    start,
    stop,
    labels: [
      { name: "suite", value: suiteName },
      { name: "feature", value: "Kwant API Automation" },
      { name: "story", value: suiteName },
      { name: "epic", value: "Postman Collection" },
      { name: "owner", value: "Paras Oli" },
    ],
    steps: [],
  };

  // Handle assertions
  assertions.forEach((assert) => {
    const status = assert.error ? "failed" : "passed";
    allureTest.steps.push({
      name: assert.assertion,
      status,
      stage: "finished",
      start,
      stop,
      statusDetails: assert.error
        ? { message: assert.error.message, trace: JSON.stringify(assert.error, null, 2) }
        : {},
    });
    if (status === "failed") allureTest.status = "failed";
  });

  // Save each test case as a separate file
  const filePath = path.join(allureResultsDir, `${allureTest.uuid}-result.json`);
  fs.writeFileSync(filePath, JSON.stringify(allureTest, null, 2));
});

// Add environment info
const envFile = path.join(allureResultsDir, "environment.properties");
fs.writeFileSync(
  envFile,
  `Project=Kwant API Automation\nEnvironment=Staging\nExecutedBy=Paras Oli\nDate=${new Date().toISOString()}`
);

console.log(chalk.green.bold("✅ Allure JSON files generated successfully!\n"));
console.log(chalk.yellow(`📁 Check folder: ${allureResultsDir}`));
