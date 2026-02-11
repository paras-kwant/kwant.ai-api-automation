require('dotenv').config();
const newman = require('newman');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Config
const COLLECTION_UID = process.env.COLLECTION_UID;
const API_KEY = process.env.POSTMAN_API_KEY;
const SURGE_TOKEN = process.env.SURGE_TOKEN;
const SURGE_URL = 'kwant-automation-dashboard.surge.sh';

const ALLURE_RESULTS_DIR = path.join(__dirname, 'allure-results');
const ALLURE_REPORT_DIR = path.join(__dirname, 'allure-report');
const HISTORY_DIR = path.join(__dirname, '.history');

// Ensure directories exist
[ALLURE_RESULTS_DIR, HISTORY_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Clean allure-results except history folder
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

// 🔐 SANITIZE ALLURE RESULTS (IMPORTANT SECURITY FIX)
function sanitizeAllureResults() {
    const files = fs.readdirSync(ALLURE_RESULTS_DIR);

    files.forEach(file => {
        const filePath = path.join(ALLURE_RESULTS_DIR, file);

        if (file.endsWith('.json')) {
            let content = fs.readFileSync(filePath, 'utf8');

            // Mask api-key
            content = content.replace(/("api-key"\s*:\s*")[^"]+(")/gi, '$1***MASKED***$2');

            // Mask Authorization headers
            content = content.replace(/("Authorization"\s*:\s*")[^"]+(")/gi, '$1***MASKED***$2');

            // Mask JWT tokens (generic pattern)
            content = content.replace(/eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, '***MASKED_JWT***');

            fs.writeFileSync(filePath, content, 'utf8');
        }
    });

    console.log('🔐 Sensitive data masked in allure-results');
}

// Extract base URL and environment
function extractEnvironmentInfo(collection) {
    let baseUrl = 'https://api.example.com';
    let environment = 'unknown';

    try {
        const findRequests = (items) => {
            const requests = [];
            if (!items) return requests;

            items.forEach(item => {
                if (item.request && item.request.url) {
                    requests.push(item.request.url);
                }
                if (item.item) {
                    requests.push(...findRequests(item.item));
                }
            });
            return requests;
        };

        const urls = findRequests(collection.item);

        if (urls.length > 0) {
            let firstUrl = urls[0];
            let urlString = '';

            if (typeof firstUrl === 'string') {
                urlString = firstUrl;
            } else if (typeof firstUrl === 'object') {
                urlString =
                    firstUrl.raw ||
                    firstUrl.href ||
                    (firstUrl.protocol
                        ? `${firstUrl.protocol}://${firstUrl.host?.join?.('.') || firstUrl.host}`
                        : '');
            }

            if (urlString) {
                urlString = urlString.replace(/\{\{[^}]+\}\}/g, '');
                const urlMatch = urlString.match(/^(https?:\/\/[^\/\?]+)/);

                if (urlMatch) {
                    baseUrl = urlMatch[1];

                    const hostMatch = baseUrl.match(/https?:\/\/([^.]+)\./);
                    if (hostMatch) {
                        const subdomain = hostMatch[1].toLowerCase();
                        if (['uat', 'staging', 'stage', 'dev', 'test', 'qa'].includes(subdomain)) {
                            environment = subdomain;
                        } else {
                            environment = 'production';
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.warn('⚠️ Could not extract environment info:', err.message);
    }

    return { baseUrl, environment };
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

// Add environment info
function addEnvironmentInfo(baseUrl, environment) {
    const content = `
POSTMAN_ENV=${environment}
API_URL=${baseUrl}
TIMESTAMP=${new Date().toISOString()}
`.trim();

    fs.writeFileSync(path.join(ALLURE_RESULTS_DIR, 'environment.properties'), content);
}

// Fetch Postman collection
async function getCollection() {
    const url = `https://api.getpostman.com/collections/${COLLECTION_UID}`;
    const res = await axios.get(url, { headers: { 'X-Api-Key': API_KEY } });
    return res.data.collection;
}

// Merge last 3 runs
function mergeHistory() {
    const targetHistory = path.join(ALLURE_RESULTS_DIR, 'history');

    if (fs.existsSync(targetHistory))
        fs.rmSync(targetHistory, { recursive: true, force: true });

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

    console.log('📂 Merged last 3 runs into history');
}

// Generate Allure report
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

// Save run history
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
}

// Deploy to Surge
function deployToSurge() {
    return new Promise((resolve, reject) => {
        const cmd = `surge ./allure-report ${SURGE_URL} --token ${SURGE_TOKEN}`;
        exec(cmd, (err, stdout, stderr) => {
            console.log(stdout);
            if (err) return reject(err);
            console.log(`🌐 Deployed to https://${SURGE_URL}`);
            resolve();
        });
    });
}

// Run tests
async function runTests() {
    if (!COLLECTION_UID || !API_KEY || !SURGE_TOKEN) {
        console.error('❌ Missing environment variables');
        process.exit(1);
    }

    cleanAllureResults();
    addExecutorInfo();

    const collection = await getCollection();
    const { baseUrl, environment } = extractEnvironmentInfo(collection);
    addEnvironmentInfo(baseUrl, environment);

    newman.run({
        collection,
        reporters: ['cli', 'allure'],
        reporter: { allure: { export: ALLURE_RESULTS_DIR } },
        iterationCount: 1
    }, async (err, summary) => {

        if (err) return console.error('❌ Newman failed:', err);

        console.log('✅ Tests completed');

        try {
            sanitizeAllureResults();   // 🔐 MASK BEFORE REPORT GENERATION
            await generateAllureReport();
            saveCurrentRunHistory();
            await deployToSurge();
        } catch (err) {
            console.error('❌ Report generation/deploy failed:', err.message);
        }

        process.exit(summary.run.stats.assertions.failed > 0 ? 1 : 0);
    });
}

runTests();
