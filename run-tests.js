require('dotenv').config();
const newman = require('newman');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const axios = require('axios');
const { execSync } = require('child_process');
const moment = require('moment-timezone');

const reportsDir = path.join(__dirname, 'reports');
const allureResultsDir = path.join(reportsDir, 'allure-results');
const historyDir = path.join(allureResultsDir, 'history');

// Ensure directories exist
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
if (!fs.existsSync(allureResultsDir)) fs.mkdirSync(allureResultsDir, { recursive: true });
if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });

// 🧹 Step 1: Clear old Allure results (preserve history)
console.log(chalk.blue('🗑️ Clearing old Allure results...'));
fs.readdirSync(allureResultsDir).forEach(file => {
  const filePath = path.join(allureResultsDir, file);
  if (file !== 'history') {
    fs.rmSync(filePath, { recursive: true, force: true });
  }
});
console.log(chalk.green('✅ Cleared old Allure results, preserved history.'));

// 🧹 Step 2: Delete older history folders if more than 5
function cleanOldHistory() {
  const runFolders = fs.readdirSync(historyDir)
    .filter(name => name.startsWith('run-'))
    .map(name => ({
      name,
      time: fs.statSync(path.join(historyDir, name)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time); // newest first

  if (runFolders.length > 5) {
    const oldFolders = runFolders.slice(5); // keep only 5 latest
    oldFolders.forEach(folder => {
      const folderPath = path.join(historyDir, folder.name);
      fs.rmSync(folderPath, { recursive: true, force: true });
      console.log(chalk.yellow(`🧹 Deleted old run folder: ${folder.name}`));
    });
  }
}

cleanOldHistory();

// 🧭 Step 3: Backup history temporarily
const tempHistoryDir = path.join(reportsDir, `temp-history-${Date.now()}`);
if (fs.existsSync(historyDir)) {
  fs.mkdirSync(tempHistoryDir);
  fs.readdirSync(historyDir).forEach(file => {
    fs.copyFileSync(path.join(historyDir, file), path.join(tempHistoryDir, file));
  });
}

// 🌐 Step 4: Fetch Postman Collection
async function getCollection() {
  try {
    const response = await axios.get(`https://api.getpostman.com/collections/${process.env.COLLECTION_UID}`, {
      headers: { 'X-Api-Key': process.env.POSTMAN_API_KEY }
    });
    return response.data.collection;
  } catch (err) {
    console.error(chalk.red('❌ Error fetching collection from Postman:'), err.message);
    process.exit(1);
  }
}

// 🚀 Step 5: Run Newman + Allure
async function runNewman() {
  const collection = await getCollection();

  console.log(chalk.blue('🚀 Starting Newman API tests...'));
  newman.run({
    collection: collection,
    reporters: ['cli', 'allure'],
    reporter: {
      allure: { export: allureResultsDir }
    }
  }, function (err, summary) {
    if (err) {
      console.error(chalk.red('❌ Error during automation:'), err);
      process.exit(1);
    }
    console.log(chalk.green('✅ Newman run completed!'));

    // Restore history backup
    fs.readdirSync(tempHistoryDir).forEach(file => {
      fs.copyFileSync(path.join(tempHistoryDir, file), path.join(historyDir, file));
    });
    fs.rmSync(tempHistoryDir, { recursive: true, force: true });

    // Remove comparison/trend data
    const categoriesFile = path.join(allureResultsDir, 'categories.json');
    if (fs.existsSync(categoriesFile)) fs.unlinkSync(categoriesFile);

    // Generate & Deploy
    try {
      console.log(chalk.blue('📊 Generating Allure report...'));
      execSync(`allure generate ${allureResultsDir} --clean -o ${reportsDir}/allure-report`);
      console.log(chalk.green('✅ Allure report generated!'));

      console.log(chalk.blue('☁️ Deploying report to Surge...'));
      execSync(`surge ${reportsDir}/allure-report kwant-automation-dashboard.surge.sh`);
      console.log(chalk.green('✅ Report deployed successfully!'));
    } catch (error) {
      console.error(chalk.red('❌ Error during report generation or deployment:'), error.message);
    }
  });
}

// 🏁 Run
runNewman();
