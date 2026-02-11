require('dotenv').config();
const newman = require('newman');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const ghpages = require('gh-pages');

// Config
const COLLECTION_UID = process.env.COLLECTION_UID;
const API_KEY = process.env.POSTMAN_API_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_PAGES_URL = `https://paras-kwant.github.io/kwant.ai-api-automation/`;

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

// 🔒 Sanitize sensitive data
function sanitizeAllureResults() {
    try {
        const files = fs.readdirSync(ALLURE_RESULTS_DIR).filter(f => f.endsWith('.txt') || f.endsWith('.json'));
        files.forEach(file => {
            const filePath = path.join(ALLURE_RESULTS_DIR, file);
            let content = fs.readFileSync(filePath, 'utf8');
            
            content = content.replace(/"api-key":\s*"[^"]+"/gi, '"api-key": "***REDACTED***"');
            content = content.replace(/"authorization":\s*"[^"]+"/gi, '"authorization": "***REDACTED***"');
            content = content.replace(/"postman-token":\s*"[^"]+"/gi, '"postman-token": "***REDACTED***"');
            content = content.replace(/"x-api-key":\s*"[^"]+"/gi, '"x-api-key": "***REDACTED***"');
            content = content.replace(/"cookie":\s*"[^"]+"/gi, '"cookie": "***REDACTED***"');
            
            fs.writeFileSync(filePath, content);
        });
        console.log(`🔒 Sanitized ${files.length} files`);
    } catch (err) {
        console.log('⚠️ Sanitization error (non-critical):', err.message);
    }
}

// Extract base URL and environment from collection
function extractEnvironmentInfo(collection) {
    let baseUrl = 'https://api.example.com';
    let environment = 'unknown';

    try {
        const findRequests = (items) => {
            const requests = [];
            if (!items) return requests;
            items.forEach(item => {
                if (item.request && item.request.url) requests.push(item.request.url);
                if (item.item) requests.push(...findRequests(item.item));
            });
            return requests;
        };

        const urls = findRequests(collection.item);
        console.log(`📊 Found ${urls.length} requests in collection`);
        
        if (urls.length > 0) {
            let firstUrl = urls[0];
            console.log(`🔍 Raw URL object:`, JSON.stringify(firstUrl, null, 2));
            
            let urlString = '';
            if (typeof firstUrl === 'string') {
                urlString = firstUrl;
            } else if (typeof firstUrl === 'object') {
                urlString = firstUrl.raw || firstUrl.href || (firstUrl.protocol ? `${firstUrl.protocol}://${firstUrl.host?.join?.('.') || firstUrl.host}` : '');
            }

            urlString = urlString.replace(/\{\{[^}]+\}\}/g, '');
            const urlMatch = urlString.match(/^(https?:\/\/[^\/\?]+)/);
            if (urlMatch) {
                baseUrl = urlMatch[1];
                const hostMatch = baseUrl.match(/https?:\/\/([^.]+)\./);
                if (hostMatch) {
                    const subdomain = hostMatch[1];
                    if (['uat', 'staging', 'stage', 'dev', 'test', 'qa'].includes(subdomain.toLowerCase())) {
                        environment = subdomain.toLowerCase();
                    } else if (['www', 'api'].includes(subdomain.toLowerCase())) {
                        environment = 'production';
                    } else {
                        environment = subdomain.toLowerCase();
                    }
                } else {
                    environment = 'production';
                }
            }
        }

        console.log(`🌍 Detected Base URL: ${baseUrl}`);
        console.log(`🔧 Detected Environment: ${environment}`);
    } catch (err) {
        console.warn('⚠️ Could not extract environment info, using defaults:', err.message);
        console.error(err);
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

// Add environment info dynamically
function addEnvironmentInfo(baseUrl, environment) {
    const content = `
POSTMAN_ENV=${environment}
API_URL=${baseUrl}
TIMESTAMP=${new Date().toISOString()}
`.trim();
    fs.writeFileSync(path.join(ALLURE_RESULTS_DIR, 'environment.properties'), content);
    console.log(`📝 Environment info saved: ${environment} - ${baseUrl}`);
}

// Fetch Postman collection
async function getCollection() {
    const url = `https://api.getpostman.com/collections/${COLLECTION_UID}`;
    const res = await axios.get(url, { headers: { 'X-Api-Key': API_KEY } });
    return res.data.collection;
}

// Merge last 3 runs into allure-results/history
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
                fs.copyFileSync(path.join(src, file), path.join(targetHistory, `${folder.name}-${file}`));
            });
        }
    });

    console.log('📂 Merged last 3 runs into allure-results/history');
}

// Generate Allure HTML report
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

// Save current run to .history and prune older than 3
function saveCurrentRunHistory() {
    const reportHistory = path.join(ALLURE_REPORT_DIR, 'history');
    if (!fs.existsSync(reportHistory)) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runFolder = path.join(HISTORY_DIR, timestamp);
    fs.mkdirSync(runFolder, { recursive: true });

    fs.readdirSync(reportHistory).forEach(file => {
        fs.copyFileSync(path.join(reportHistory, file), path.join(runFolder, file));
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

// Deploy to GitHub Pages
function deployToGithubPages() {
    return new Promise((resolve, reject) => {
        ghpages.publish(ALLURE_REPORT_DIR, {
            branch: 'gh-pages',
            repo: `https://github.com/${GITHUB_REPOSITORY}.git`,
            dotfiles: true
        }, (err) => {
            if (err) return reject(err);
            console.log('🌐 Allure report deployed to GitHub Pages!');
            resolve();
        });
    });
}

// Send Slack Notification
function sendSlackNotification(stats) {
    const { TOTAL, PASSED, FAILED, SKIPPED, SUCCESS_RATE, TOTAL_TIME, TIMESTAMP } = stats;

    let STATUS = '';
    let COLOR = '';

    if (FAILED == 0 && TOTAL > 0) {
        STATUS = "✅ API tests completed successfully";
        COLOR = "good";
    } else if (TOTAL == 0) {
        STATUS = "⚠️ API tests did not run properly";
        COLOR = "warning";
    } else {
        STATUS = "🚨 PROD Health Check tests failed";
        COLOR = "danger";
    }

    const payload = {
        attachments: [
            {
                color: COLOR,
                title: STATUS,
                fields: [
                    { title: "Total Tests", value: TOTAL, short: true },
                    { title: "✅ Passed", value: PASSED, short: true },
                    { title: "❌ Failed", value: FAILED, short: true },
                    { title: "⏭️ Skipped", value: SKIPPED, short: true },
                    { title: "📈 Success Rate", value: `${SUCCESS_RATE}%`, short: true },
                    { title: "⏳ Total Time", value: TOTAL_TIME, short: true },
                    { title: "🕐 Last Checked", value: TIMESTAMP, short: false }
                ],
                actions: [
                    {
                        type: "button",
                        text: "View Detailed Report",
                        url: GITHUB_PAGES_URL
                    }
                ]
            }
        ]
    };

    axios.post(SLACK_WEBHOOK_URL, payload)
        .then(() => console.log('💬 Slack notification sent'))
        .catch(err => console.error('❌ Slack notification failed', err.message));
}

// Run Newman tests
async function runTests() {
    if (!COLLECTION_UID || !API_KEY || !SLACK_WEBHOOK_URL || !GITHUB_REPOSITORY) {
        console.error('❌ Missing required .env variables');
        process.exit(1);
    }

    cleanAllureResults();
    addExecutorInfo();

    const collection = await getCollection();
    console.log('📦 Collection Name:', collection.info?.name || 'Unknown');
    console.log('📦 Collection has items:', !!collection.item);

    const { baseUrl, environment } = extractEnvironmentInfo(collection);
    addEnvironmentInfo(baseUrl, environment);

    newman.run({
        collection,
        reporters: ['cli', 'allure'],
        reporter: { allure: { export: ALLURE_RESULTS_DIR } },
        iterationCount: 1
    }, async (err, summary) => {
        if (err) return console.error('❌ Newman run failed:', err);

        console.log('✅ Newman tests completed!');
        const TOTAL = summary.run.stats.requests.total;
        const FAILED = summary.run.stats.assertions.failed;
        const PASSED = TOTAL - FAILED;
        const SKIPPED = 0;
        const SUCCESS_RATE = TOTAL > 0 ? ((PASSED / TOTAL) * 100).toFixed(2) : 0;
        const TOTAL_TIME = summary.run.stats.requests.totalResponseTime || "N/A";
        const TIMESTAMP = new Date().toISOString();

        try {
            sanitizeAllureResults();
            await generateAllureReport();
            saveCurrentRunHistory();
            await deployToGithubPages();
            sendSlackNotification({ TOTAL, PASSED, FAILED, SKIPPED, SUCCESS_RATE, TOTAL_TIME, TIMESTAMP });
        } catch (err) {
            console.error('❌ Error during report generation/deployment:', err.message);
        }

        process.exit(FAILED > 0 ? 1 : 0);
    });
}

runTests();
