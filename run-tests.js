require('dotenv').config();
const newman = require('newman');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const COLLECTION_UID = process.env.COLLECTION_UID;
const API_KEY = process.env.POSTMAN_API_KEY;
const SURGE_LOGIN = process.env.SURGE_LOGIN;
const SURGE_PASSWORD = process.env.SURGE_PASSWORD; 

const SURGE_URL = 'kwant-api-automation.surge.sh';

const ALLURE_RESULTS_DIR = path.join(__dirname, 'allure-results');
const ALLURE_REPORT_DIR = path.join(__dirname, 'allure-report');
const HISTORY_DIR = path.join(__dirname, '.history');

[ALLURE_RESULTS_DIR, HISTORY_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

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

function addExecutorInfo() {
    const content = `
executor.name=ParasOli
executor.type=CLI
executor.build=1
executor.url=http://localhost
`.trim();
    fs.writeFileSync(path.join(ALLURE_RESULTS_DIR, 'executor.properties'), content);
}

function addEnvironmentInfo() {
    const content = `
POSTMAN_ENV=UAT
API_URL=https://uat.example.com
`.trim();
    fs.writeFileSync(path.join(ALLURE_RESULTS_DIR, 'environment.properties'), content);
}

async function getCollection() {
    try {
        const url = `https://api.getpostman.com/collections/${COLLECTION_UID}`;
        const res = await axios.get(url, { headers: { 'X-Api-Key': API_KEY } });
        console.log('✅ Collection fetched successfully from Postman Cloud');
        return res.data.collection;
    } catch (err) {
        console.error('❌ Failed to fetch Postman collection:', err.message);
        process.exit(1);
    }
}

// ♻️ Merge last 3 runs into allure-results/history
function mergeHistory() {
    const targetHistory = path.join(ALLURE_RESULTS_DIR, 'history');

    if (fs.existsSync(targetHistory)) fs.rmSync(targetHistory, { recursive: true, force: true });
    fs.mkdirSync(targetHistory, { recursive: true });

    const folders = fs.readdirSync(HISTORY_DIR)
        .map(name => ({ name, time: fs.statSync(path.join(HISTORY_DIR, name)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time)
        .slice(0, 3)
        .reverse();

    folders.forEach(folder => {
        const src = path.join(HISTORY_DIR, folder.name);
        if (fs.existsSync(src)) {
            fs.readdirSync(src).forEach(file => {
                const srcFile = path.join(src, file);
                const destFile = path.join(targetHistory, `${folder.name}-${file}`);
                fs.copyFileSync(srcFile, destFile);
            });
        }
    });

    console.log('📂 Merged last 3 runs into allure-results/history');
}

// 🧭 Generate Allure HTML report
function generateAllureReport() {
    mergeHistory();
    return new Promise((resolve, reject) => {
        const cmd = `allure generate ${ALLURE_RESULTS_DIR} -o ${ALLURE_REPORT_DIR} --clean`;
        exec(cmd, err => {
            if (err) return reject(err);
            console.log('✅ Allure HTML report generated!');
            resolve();
        });
    });
}

function saveCurrentRunHistory() {
    const reportHistory = path.join(ALLURE_REPORT_DIR, 'history');
    if (!fs.existsSync(reportHistory)) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runFolder = path.join(HISTORY_DIR, timestamp);
    fs.mkdirSync(runFolder, { recursive: true });

    fs.readdirSync(reportHistory).forEach(file => {
        const srcFile = path.join(reportHistory, file);
        fs.copyFileSync(srcFile, path.join(runFolder, file));
    });

    console.log(`📂 Saved current run's history to ${runFolder}`);

    const folders = fs.readdirSync(HISTORY_DIR)
        .map(name => ({ name, time: fs.statSync(path.join(HISTORY_DIR, name)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);

    for (let i = 3; i < folders.length; i++) {
        fs.rmSync(path.join(HISTORY_DIR, folders[i].name), { recursive: true, force: true });
        console.log(`🗑️ Deleted old history: ${folders[i].name}`);
    }
}

function deployToSurge() {
    return new Promise((resolve, reject) => {
        if (!SURGE_LOGIN || !SURGE_PASSWORD) {
            console.error('❌ Missing SURGE_LOGIN or SURGE_PASSWORD in .env');
            process.exit(1);
        }

        const cmd = `surge ./allure-report ${SURGE_URL} --login ${SURGE_LOGIN} --password ${SURGE_PASSWORD}`;
        exec(cmd, (err, stdout, stderr) => {
            if (err) {
                console.error(stderr);
                return reject(err);
            }
            console.log(`🌐 Allure report deployed to Surge: https://${SURGE_URL}`);
            resolve();
        });
    });
}

async function runTests() {
    if (!COLLECTION_UID || !API_KEY) {
        console.error('❌ Missing COLLECTION_UID or POSTMAN_API_KEY in .env');
        process.exit(1);
    }

    cleanAllureResults();
    addExecutorInfo();
    addEnvironmentInfo();

    const collection = await getCollection();

    newman.run({
        collection,
        reporters: ['cli', 'allure'],
        reporter: { allure: { export: ALLURE_RESULTS_DIR } },
        iterationCount: 1
    }, async (err, summary) => {
        if (err) return console.error('❌ Newman run failed:', err);

        console.log('✅ Newman tests completed!');
        console.log(`📊 Total requests: ${summary.run.stats.requests.total}`);
        console.log(`❌ Failed requests: ${summary.run.stats.requests.failed}`);
        console.log(`🚨 Failed assertions: ${summary.run.stats.assertions.failed}`);

        try {
            await generateAllureReport();
            saveCurrentRunHistory();
            await deployToSurge();
        } catch (err) {
            console.error('❌ Could not generate/deploy Allure report:', err.message);
        }

        process.exit(summary.run.stats.assertions.failed > 0 ? 1 : 0);
    });
}

runTests();
