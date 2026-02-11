require('dotenv').config();
const newman = require('newman');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const COLLECTION_UID = process.env.COLLECTION_UID;
const API_KEY = process.env.POSTMAN_API_KEY;
const SURGE_TOKEN = process.env.SURGE_TOKEN;
const SURGE_URL = process.env.SURGE_URL || 'kwant-automation-dashboard.surge.sh';

const ALLURE_RESULTS_DIR = path.join(__dirname, 'allure-results');
const ALLURE_REPORT_DIR = path.join(__dirname, 'allure-report');
const HISTORY_DIR = path.join(__dirname, '.history');

// Ensure directories exist
[ALLURE_RESULTS_DIR, HISTORY_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Clean previous allure results except history
function cleanAllureResults() {
    if (fs.existsSync(ALLURE_RESULTS_DIR)) {
        fs.readdirSync(ALLURE_RESULTS_DIR).forEach(file => {
            if (file !== 'history') {
                fs.rmSync(path.join(ALLURE_RESULTS_DIR, file), { recursive: true, force: true });
            }
        });
        console.log('🧹 Cleared previous allure-results (trend preserved)');
    }
}

// Add executor info
function addExecutorInfo() {
    const content = `
executor.name=ParasOli
executor.type=CLI
executor.build=1
executor.url=http://localhost
`.trim();
    fs.writeFileSync(path.join(ALLURE_RESULTS_DIR, 'executor.properties'), content);
}

// Generate Allure HTML report
function generateAllureReport() {
    return new Promise((resolve, reject) => {
        const cmd = `allure generate ${ALLURE_RESULTS_DIR} -o ${ALLURE_REPORT_DIR} --clean`;
        exec(cmd, err => {
            if (err) return reject(err);
            console.log('✅ Allure HTML report generated!');
            resolve();
        });
    });
}

// Deploy to Surge
function deployToSurge() {
    return new Promise((resolve, reject) => {
        const cmd = `surge ./allure-report ${SURGE_URL} --token ${SURGE_TOKEN}`;
        exec(cmd, (err, stdout, stderr) => {
            console.log('Surge Output:', stdout);
            if (stderr) console.log('Surge Stderr:', stderr);
            if (err) return reject(err);
            console.log(`🌐 Allure report deployed: https://${SURGE_URL}`);
            resolve();
        });
    });
}

// Run Newman tests
async function runTests() {
    if (!COLLECTION_UID || !API_KEY || !SURGE_TOKEN) {
        console.error('❌ Missing COLLECTION_UID, POSTMAN_API_KEY or SURGE_TOKEN in .env');
        process.exit(1);
    }

    cleanAllureResults();
    addExecutorInfo();

    const collection = await axios.get(`https://api.getpostman.com/collections/${COLLECTION_UID}`, {
        headers: { 'X-Api-Key': API_KEY }
    }).then(res => res.data.collection);

    newman.run({
        collection,
        reporters: ['cli', 'allure'],
        reporter: { allure: { export: ALLURE_RESULTS_DIR } },
        iterationCount: 1
    }, async (err, summary) => {
        if (err) return console.error('❌ Newman run failed:', err);

        console.log('✅ Newman tests completed!');
        try {
            await generateAllureReport();
            await deployToSurge();
        } catch (err) {
            console.error('❌ Could not generate/deploy Allure report:', err.message);
        }

        process.exit(summary.run.stats.assertions.failed > 0 ? 1 : 0);
    });
}

runTests();
